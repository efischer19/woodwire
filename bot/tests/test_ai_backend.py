from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import URLError

from bot.ai_backend import AIBackend, MockBackend, OpenClawBackend, build_ai_backend


class OpenClawResponse:
    def __init__(self, body: str, content_type: str = "application/json") -> None:
        self.body = body.encode("utf-8")
        self.headers = {"Content-Type": content_type}

    def __enter__(self) -> "OpenClawResponse":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class AIBackendTests(unittest.TestCase):
    def test_mock_backend_echoes_message(self) -> None:
        backend = MockBackend()

        self.assertIsInstance(backend, AIBackend)
        self.assertEqual(backend.process("Hello", ["/tmp/a.txt"]), "Echo: Hello")

    def test_build_ai_backend_defaults_to_openclaw(self) -> None:
        backend = build_ai_backend({})

        self.assertIsInstance(backend, OpenClawBackend)
        self.assertEqual(backend.endpoint, "http://127.0.0.1:8080/process")

    def test_build_ai_backend_selects_mock_backend(self) -> None:
        backend = build_ai_backend({"AI_BACKEND": "mock"})

        self.assertIsInstance(backend, MockBackend)

    def test_build_ai_backend_rejects_invalid_openclaw_port(self) -> None:
        with self.assertRaisesRegex(ValueError, "OPENCLAW_PORT must be an integer"):
            build_ai_backend({"OPENCLAW_PORT": "not-a-port"})

    def test_openclaw_backend_posts_message_and_attachments(self) -> None:
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({"response": "Processed"}))

        backend = OpenClawBackend("http://127.0.0.1:8080/process", timeout_seconds=12)

        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            response = backend.process("Hello", ["/tmp/one.txt", "/tmp/two.txt"])

        self.assertEqual(response, "Processed")
        self.assertEqual(len(request_log), 1)
        request = request_log[0].request
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/process")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request_log[0].timeout, 12)
        self.assertEqual(
            json.loads(request.data.decode("utf-8")),
            {
                "attachments": ["/tmp/one.txt", "/tmp/two.txt"],
                "message": "Hello",
            },
        )

    def test_openclaw_backend_falls_back_to_mock_on_connection_error(self) -> None:
        logger = Mock()
        backend = OpenClawBackend(
            "http://127.0.0.1:8080/process",
            fallback_backend=MockBackend(),
            logger=logger,
        )

        with patch("bot.ai_backend.urlopen", side_effect=URLError("unreachable")):
            response = backend.process("Hello", [])

        self.assertEqual(response, "Echo: Hello")
        logger.error.assert_called_once()


if __name__ == "__main__":
    unittest.main()
