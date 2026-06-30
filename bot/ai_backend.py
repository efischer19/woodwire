from __future__ import annotations

import json
import logging
import os
from typing import Protocol, runtime_checkable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_OPENCLAW_HOST = "127.0.0.1"
DEFAULT_OPENCLAW_PATH = "/process"
DEFAULT_OPENCLAW_PORT = 8080
DEFAULT_OPENCLAW_TIMEOUT_SECONDS = 60.0


@runtime_checkable
class AIBackend(Protocol):
    def process(self, message: str, attachments: list[str]) -> str: ...


class MockBackend:
    def process(self, message: str, attachments: list[str]) -> str:
        del attachments
        return f"Echo: {message}"


class OpenClawBackend:
    def __init__(
        self,
        endpoint: str,
        *,
        fallback_backend: AIBackend | None = None,
        logger: logging.Logger | None = None,
        timeout_seconds: float = DEFAULT_OPENCLAW_TIMEOUT_SECONDS,
    ) -> None:
        self.endpoint = endpoint
        self.fallback_backend = fallback_backend or MockBackend()
        self.logger = logger or logging.getLogger("woodwire.bot")
        self.timeout_seconds = timeout_seconds

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
        return cls(
            endpoint,
            fallback_backend=fallback_backend,
            logger=logger,
            timeout_seconds=timeout_seconds,
        )

    def process(self, message: str, attachments: list[str]) -> str:
        request = Request(
            self.endpoint,
            data=json.dumps({"attachments": attachments, "message": message}).encode("utf-8"),
            headers={
                "Accept": "application/json, text/plain",
                "Content-Type": "application/json",
            },
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
    """Accept either raw text or common JSON text fields from local OpenClaw setups."""
    text = body.decode("utf-8").strip()

    if not text:
        raise ValueError("OpenClaw response was empty")

    if "json" not in content_type.lower():
        return text

    payload = json.loads(text)

    if not isinstance(payload, dict):
        raise ValueError("OpenClaw JSON response must be an object")

    for key in ("response", "text", "content", "message"):
        value = payload.get(key)

        if isinstance(value, str) and value.strip():
            return value

    raise ValueError("OpenClaw JSON response did not include text content")
