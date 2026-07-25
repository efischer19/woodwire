from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load_validator_module():
    module_path = (
        Path(__file__).resolve().parents[2]
        / ".github"
        / "scripts"
        / "validate_cloudflare_purge.py"
    )
    spec = importlib.util.spec_from_file_location("validate_cloudflare_purge", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class ValidateCloudflarePurgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_validator_module()

    def run_main(self, http_status: int, response_body: str) -> tuple[int, str, str]:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as response_file:
            response_file.write(response_body)
            response_path = response_file.name

        stdout = io.StringIO()
        stderr = io.StringIO()

        try:
            with (
                patch("sys.argv", ["validate_cloudflare_purge.py", str(http_status), response_path]),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                exit_code = self.module.main()
        finally:
            Path(response_path).unlink(missing_ok=True)

        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_main_accepts_successful_purge_response(self) -> None:
        exit_code, stdout, stderr = self.run_main(200, json.dumps({"success": True}))

        self.assertEqual(exit_code, 0)
        self.assertIn("Cloudflare cache purged successfully", stdout)
        self.assertEqual(stderr, "")

    def test_main_rejects_invalid_json_response(self) -> None:
        exit_code, stdout, stderr = self.run_main(200, "not-json")

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("invalid JSON response", stderr)
        self.assertIn("not-json", stderr)

    def test_main_rejects_api_error_payload(self) -> None:
        exit_code, stdout, stderr = self.run_main(200, json.dumps({"success": False}))

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("Cloudflare API error", stderr)

    def test_main_rejects_http_error_status(self) -> None:
        exit_code, stdout, stderr = self.run_main(403, json.dumps({"success": True}))

        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("HTTP error", stderr)
        self.assertIn("status=403", stderr)
