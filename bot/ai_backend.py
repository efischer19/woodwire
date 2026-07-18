from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Protocol, runtime_checkable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_OPENCLAW_HOST = "127.0.0.1"
DEFAULT_OPENCLAW_PATH = "/process"
DEFAULT_OPENCLAW_PORT = 8080
DEFAULT_OPENCLAW_TIMEOUT_SECONDS = 60.0
DEFAULT_OPENCLAW_MODEL = "openclaw/default"


@runtime_checkable
class AIBackend(Protocol):
    def process(self, message: str, attachments: list[str]) -> str: ...


class MockBackend:
    def process(self, message: str, _attachments: list[str]) -> str:
        return f"Echo: {message}"


class OpenClawBackend:
    @staticmethod
    def _validate_model(model: str | None) -> str:
        """Validate and normalize model string by stripping whitespace.

        None, empty, or whitespace-only strings are replaced with DEFAULT_OPENCLAW_MODEL.
        """
        if not model:
            return DEFAULT_OPENCLAW_MODEL
        return model.strip() or DEFAULT_OPENCLAW_MODEL

    def __init__(
        self,
        endpoint: str,
        *,
        fallback_backend: AIBackend | None = None,
        logger: logging.Logger | None = None,
        timeout_seconds: float = DEFAULT_OPENCLAW_TIMEOUT_SECONDS,
        auth_token: str | None = None,
        model: str = DEFAULT_OPENCLAW_MODEL,
    ) -> None:
        self.endpoint = endpoint
        self.fallback_backend = fallback_backend or MockBackend()
        self.logger = logger or logging.getLogger("woodwire.bot")
        self.timeout_seconds = timeout_seconds
        if auth_token and ("\n" in auth_token or "\r" in auth_token):
            raise ValueError("auth_token must not contain newline characters (\\n or \\r)")
        self.auth_token = auth_token
        self.model = self._validate_model(model)

    @classmethod
    def from_env(
        cls,
        environ: dict[str, str] | None = None,
        *,
        fallback_backend: AIBackend | None = None,
        logger: logging.Logger | None = None,
    ) -> "OpenClawBackend":
        env = os.environ if environ is None else environ
        endpoint = env.get("OPENCLAW_URL") or build_openclaw_endpoint(env)
        timeout_seconds = float(
            env.get("OPENCLAW_TIMEOUT_SECONDS", str(DEFAULT_OPENCLAW_TIMEOUT_SECONDS))
        )
        auth_token = env.get("AI_BACKEND_TOKEN")
        model = cls._validate_model(env.get("OPENCLAW_MODEL"))
        return cls(
            endpoint,
            fallback_backend=fallback_backend,
            logger=logger,
            timeout_seconds=timeout_seconds,
            auth_token=auth_token,
            model=model,
        )

    def process(self, message: str, attachments: list[str]) -> str:
        headers = {
            "Accept": "application/json, text/plain",
            "Content-Type": "application/json",
        }
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        # Build OpenResponses-compliant input structure
        content: list[dict[str, Any]] = [
            {"type": "input_text", "text": message}
        ]

        # Add file attachments to the content
        for attachment_path in attachments:
            attachment_path = attachment_path.strip()
            if not attachment_path:
                continue

            # Try to read file content, otherwise use as URL
            try:
                with open(attachment_path, "rb") as f:
                    file_data = base64.b64encode(f.read()).decode("utf-8")
                    content.append({
                        "type": "input_file",
                        "filename": os.path.basename(attachment_path),
                        "file_data": file_data,
                    })
            except OSError:
                # If file can't be read, treat it as a URL
                content.append({
                    "type": "input_file",
                    "file_url": attachment_path,
                })

        request_body = {
            "model": self.model,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": content,
                }
            ],
        }

        request = Request(
            self.endpoint,
            data=json.dumps(request_body).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return parse_openclaw_response(
                    response.read(),
                    response.headers.get("Content-Type", ""),
                )
        except (HTTPError, OSError, URLError, ValueError) as error:
            self.logger.error(
                "OpenClaw backend unavailable at %s: %s. Falling back to mock backend.",
                self.endpoint,
                error,
            )
            return self.fallback_backend.process(message, attachments)


def build_ai_backend(
    environ: dict[str, str] | None = None,
    *,
    logger: logging.Logger | None = None,
) -> AIBackend:
    env = os.environ if environ is None else environ
    backend_name = env.get("AI_BACKEND", "openclaw").strip().lower()

    if backend_name == "mock":
        return MockBackend()

    if backend_name == "openclaw":
        return OpenClawBackend.from_env(env, logger=logger)

    raise ValueError(f"Unsupported AI_BACKEND value: {backend_name}")


def build_openclaw_endpoint(environ: dict[str, str]) -> str:
    host = environ.get("OPENCLAW_HOST", DEFAULT_OPENCLAW_HOST).strip() or DEFAULT_OPENCLAW_HOST
    port_text = environ.get("OPENCLAW_PORT", str(DEFAULT_OPENCLAW_PORT)).strip()
    path = environ.get("OPENCLAW_PATH", DEFAULT_OPENCLAW_PATH).strip() or DEFAULT_OPENCLAW_PATH

    if "://" in host or any(character in host for character in "/?#"):
        raise ValueError("OPENCLAW_HOST must be a hostname or IP address")

    if not path.startswith("/"):
        path = f"/{path}"

    try:
        port = int(port_text)
    except ValueError as error:
        raise ValueError("OPENCLAW_PORT must be an integer") from error

    if not 1 <= port <= 65535:
        raise ValueError("OPENCLAW_PORT must be between 1 and 65535")

    return f"http://{host}:{port}{path}"


def parse_openclaw_response(body: bytes, content_type: str) -> str:
    """Parse OpenResponses-compliant response and extract text content."""
    text = body.decode("utf-8").strip()

    if not text:
        raise ValueError("OpenClaw response was empty")

    if "json" not in content_type.lower():
        return text

    payload = json.loads(text)

    if not isinstance(payload, dict):
        raise ValueError("OpenClaw JSON response must be an object")

    # Handle OpenResponses schema: output is an array of items
    if "output" in payload and isinstance(payload["output"], list):
        for item in payload["output"]:
            if not isinstance(item, dict):
                continue

            # Look for message items with assistant role
            if item.get("type") == "message" and item.get("role") == "assistant":
                content = item.get("content")

                # Content can be a string or an array of content objects
                if isinstance(content, str) and content.strip():
                    return content

                # If content is an array, look for output_text items
                if isinstance(content, list):
                    for content_item in content:
                        if isinstance(content_item, dict):
                            if content_item.get("type") == "output_text":
                                text_value = content_item.get("text")
                                if isinstance(text_value, str) and text_value.strip():
                                    return text_value

    # Fallback to common response field names for backward compatibility
    for key in ("response", "text", "content", "message"):
        value = payload.get(key)

        if isinstance(value, str) and value.strip():
            return value

    raise ValueError("OpenClaw JSON response did not include text content")
