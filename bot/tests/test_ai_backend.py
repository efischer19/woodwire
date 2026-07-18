from __future__ import annotations

import json
import os
import tempfile
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
    @staticmethod
    def _build_auth_header(token: str) -> str:
        """Build an Authorization header value with ****** format."""
        return "Bearer " + token

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

    def test_build_ai_backend_rejects_invalid_openclaw_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "OPENCLAW_HOST must be a hostname or IP address"):
            build_ai_backend({"OPENCLAW_HOST": "http://bad-host"})

    def test_openclaw_backend_posts_message_and_attachments(self) -> None:
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        backend = OpenClawBackend("http://127.0.0.1:8080/process", timeout_seconds=12)

        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            response = backend.process("Hello", ["/tmp/one.txt", "/tmp/two.txt"])

        self.assertEqual(response, "Processed")
        self.assertEqual(len(request_log), 1)
        request = request_log[0].request
        self.assertEqual(request.full_url, "http://127.0.0.1:8080/process")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request_log[0].timeout, 12)
        
        # Validate the request body matches OpenResponses schema
        request_body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request_body["model"], "gpt-5")
        self.assertIn("input", request_body)
        self.assertEqual(len(request_body["input"]), 1)
        
        input_item = request_body["input"][0]
        self.assertEqual(input_item["type"], "message")
        self.assertEqual(input_item["role"], "user")
        
        # Validate content structure
        self.assertIn("content", input_item)
        content = input_item["content"]
        # Should have text + 2 file attachments (non-existent paths use file_url)
        self.assertEqual(len(content), 3)
        self.assertEqual(content[0]["type"], "input_text")
        self.assertEqual(content[0]["text"], "Hello")
        self.assertEqual(content[1]["type"], "input_file")
        self.assertEqual(content[1]["file_url"], "/tmp/one.txt")
        self.assertEqual(content[2]["type"], "input_file")
        self.assertEqual(content[2]["file_url"], "/tmp/two.txt")

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

    def test_openclaw_backend_includes_bearer_token_when_auth_token_present(self) -> None:
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        backend = OpenClawBackend(
            "http://127.0.0.1:8080/process",
            auth_token="secret-token-xyz",
            timeout_seconds=12,
        )

        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            response = backend.process("Hello", [])

        self.assertEqual(response, "Processed")
        self.assertEqual(len(request_log), 1)
        request = request_log[0].request
        auth_header = request.headers.get("Authorization")
        self.assertIsNotNone(auth_header)
        expected_auth = self._build_auth_header("secret-token-xyz")
        self.assertEqual(auth_header, expected_auth)

    def test_openclaw_backend_omits_authorization_header_when_no_token(self) -> None:
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        backend = OpenClawBackend("http://127.0.0.1:8080/process", timeout_seconds=12)

        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            response = backend.process("Hello", [])

        self.assertEqual(response, "Processed")
        self.assertEqual(len(request_log), 1)
        request = request_log[0].request
        self.assertIsNone(request.headers.get("Authorization"))

    def test_build_ai_backend_includes_auth_token_from_env(self) -> None:
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        backend = build_ai_backend({"AI_BACKEND_TOKEN": "test-token-123"})

        self.assertIsInstance(backend, OpenClawBackend)
        self.assertEqual(backend.auth_token, "test-token-123")

        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            backend.process("Test", [])

        self.assertEqual(len(request_log), 1)
        request = request_log[0].request
        auth_header = request.headers.get("Authorization")
        self.assertIsNotNone(auth_header)
        expected_auth = self._build_auth_header("test-token-123")
        self.assertEqual(auth_header, expected_auth)

    def test_openclaw_backend_rejects_auth_token_with_newline(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not contain newline characters"):
            OpenClawBackend(
                "http://127.0.0.1:8080/process",
                auth_token="token\ninjection",
            )

    def test_openclaw_backend_rejects_auth_token_with_carriage_return(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not contain newline characters"):
            OpenClawBackend(
                "http://127.0.0.1:8080/process",
                auth_token="token\rinjection",
            )

    def test_parse_openclaw_response_handles_openresponses_format(self) -> None:
        """Test parsing OpenResponses format with output array."""
        from bot.ai_backend import parse_openclaw_response
        
        response_body = json.dumps({
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Hello from OpenResponses"
                        }
                    ]
                }
            ]
        }).encode("utf-8")
        
        result = parse_openclaw_response(response_body, "application/json")
        self.assertEqual(result, "Hello from OpenResponses")

    def test_parse_openclaw_response_handles_openresponses_format_with_string_content(self) -> None:
        """Test parsing OpenResponses format with string content instead of array."""
        from bot.ai_backend import parse_openclaw_response
        
        response_body = json.dumps({
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": "Hello from OpenResponses"
                }
            ]
        }).encode("utf-8")
        
        result = parse_openclaw_response(response_body, "application/json")
        self.assertEqual(result, "Hello from OpenResponses")

    def test_parse_openclaw_response_falls_back_to_legacy_format(self) -> None:
        """Test backward compatibility with legacy response format."""
        from bot.ai_backend import parse_openclaw_response
        
        response_body = json.dumps({
            "response": "Legacy response format"
        }).encode("utf-8")
        
        result = parse_openclaw_response(response_body, "application/json")
        self.assertEqual(result, "Legacy response format")

    def test_parse_openclaw_response_handles_plain_text(self) -> None:
        """Test parsing plain text response."""
        from bot.ai_backend import parse_openclaw_response
        
        response_body = b"Just plain text"
        result = parse_openclaw_response(response_body, "text/plain")
        self.assertEqual(result, "Just plain text")

    def test_openclaw_backend_reads_local_files_as_base64(self) -> None:
        """Test that local files are read and encoded as base64 file_data."""
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        # Create a temporary file with known content
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt") as f:
            f.write("test content")
            f.flush()  # Ensure content is written to disk
            temp_file = f.name

            backend = OpenClawBackend("http://127.0.0.1:8080/process")
            
            with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
                response = backend.process("Hello", [temp_file])

            self.assertEqual(response, "Processed")
            request_body = json.loads(request_log[0].request.data.decode("utf-8"))
            
            # Verify the file was included as file_data (base64-encoded)
            content = request_body["input"][0]["content"]
            # Should have text + file attachment
            self.assertEqual(len(content), 2)
            self.assertEqual(content[0]["type"], "input_text")
            self.assertEqual(content[0]["text"], "Hello")
            self.assertEqual(content[1]["type"], "input_file")
            self.assertIn("file_data", content[1])
            self.assertEqual(content[1]["filename"], os.path.basename(temp_file))

    def test_openclaw_backend_uses_file_url_for_non_existent_files(self) -> None:
        """Test that non-existent files are treated as URLs."""
        request_log: list[SimpleNamespace] = []

        def fake_urlopen(request, timeout):
            request_log.append(SimpleNamespace(request=request, timeout=timeout))
            return OpenClawResponse(json.dumps({
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Processed"
                            }
                        ]
                    }
                ]
            }))

        backend = OpenClawBackend("http://127.0.0.1:8080/process")
        nonexistent_path = os.path.join(tempfile.gettempdir(), "nonexistent_file.txt")
        
        with patch("bot.ai_backend.urlopen", side_effect=fake_urlopen):
            response = backend.process("Hello", [nonexistent_path])

        self.assertEqual(response, "Processed")
        request_body = json.loads(request_log[0].request.data.decode("utf-8"))
        
        # Verify the file path was included as file_url
        content = request_body["input"][0]["content"]
        self.assertEqual(len(content), 2)
        self.assertEqual(content[0]["type"], "input_text")
        self.assertEqual(content[1]["type"], "input_file")
        self.assertIn("file_url", content[1])
        self.assertEqual(content[1]["file_url"], nonexistent_path)


if __name__ == "__main__":
    unittest.main()
