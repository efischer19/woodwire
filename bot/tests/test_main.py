from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

from bot.ai_backend import MockBackend
from bot.main import (
    BotConfig,
    INITIAL_BACKOFF_SECONDS,
    LONG_POLL_WAIT_SECONDS,
    MAX_BACKOFF_SECONDS,
    VISIBILITY_TIMEOUT_SECONDS,
    WoodwireBot,
)
from botocore.exceptions import ClientError


def build_client_error(operation_name: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "InternalError", "Message": "temporary failure"}},
        operation_name,
    )


def build_message(text: str = "Hello") -> dict[str, str]:
    return {
        "Body": json.dumps(
            {
                "attachments": [],
                "conversationId": "conversation-123",
                "createdAt": "2026-06-30T12:00:00.000Z",
                "text": text,
            }
        ),
        "MessageId": "message-123",
        "ReceiptHandle": "receipt-123",
    }


class WoodwireBotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = BotConfig(
            aws_access_key_id="access-key",
            aws_region="us-east-1",
            aws_secret_access_key="secret-key",
            s3_bucket_name="woodwire-chat",
            sqs_queue_url="https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat",
        )
        self.fixed_now = datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)

    def create_bot(self, **overrides) -> WoodwireBot:
        return WoodwireBot(
            self.config,
            logger=overrides.pop("logger", Mock()),
            now=overrides.pop("now", lambda: self.fixed_now),
            ai_backend=overrides.pop("ai_backend", MockBackend()),
            sleep=overrides.pop("sleep", lambda seconds: None),
            s3_client=overrides.pop("s3_client", Mock()),
            sqs_client=overrides.pop("sqs_client", Mock()),
            temp_root_dir=overrides.pop("temp_root_dir", tempfile.gettempdir()),
            **overrides,
        )

    def test_run_uses_long_polling_and_finishes_current_message_on_shutdown(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        bot = None

        class ShutdownBackend(MockBackend):
            def process(self, _message: str, _attachments: list[str]) -> str:
                bot.request_shutdown()
                return "Echo: Hello"

        bot = self.create_bot(
            ai_backend=ShutdownBackend(),
            s3_client=s3_client,
            sqs_client=sqs_client,
        )
        sqs_client.receive_message.return_value = {"Messages": [build_message()]}

        bot.run()

        sqs_client.receive_message.assert_called_once_with(
            QueueUrl=self.config.sqs_queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=LONG_POLL_WAIT_SECONDS,
        )
        sqs_client.change_message_visibility.assert_called_once_with(
            QueueUrl=self.config.sqs_queue_url,
            ReceiptHandle="receipt-123",
            VisibilityTimeout=VISIBILITY_TIMEOUT_SECONDS,
        )
        sqs_client.delete_message.assert_called_once_with(
            QueueUrl=self.config.sqs_queue_url,
            ReceiptHandle="receipt-123",
        )
        self.assertEqual(s3_client.put_object.call_count, 2)

    def test_handle_message_downloads_attachments_writes_response_and_cleans_up(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        captured_attachments: list[str] = []

        class RecordingBackend(MockBackend):
            def process(self, message: str, attachments: list[str]) -> str:
                test_case.assertEqual(message, "Hello Woodwire")
                captured_attachments.extend(attachments)
                return super().process(message, attachments)

        test_case = self

        with tempfile.TemporaryDirectory() as temp_root_dir:
            conversation_temp_dir = os.path.join(
                temp_root_dir,
                "woodwire",
                "conversation-123",
            )

            def download_file(bucket: str, key: str, filename: str) -> None:
                self.assertEqual(bucket, self.config.s3_bucket_name)
                self.assertTrue(filename.startswith(conversation_temp_dir))
                with open(filename, "w", encoding="utf-8") as handle:
                    handle.write(key)

            s3_client.download_file.side_effect = download_file
            bot = self.create_bot(
                ai_backend=RecordingBackend(),
                s3_client=s3_client,
                sqs_client=sqs_client,
                temp_root_dir=temp_root_dir,
            )

            response_key = bot.handle_message(
                build_message("Hello Woodwire")
                | {
                    "Body": json.dumps(
                        {
                            "attachments": [
                                "attachments/conversation-123/a.txt",
                                "attachments/conversation-123/b.txt",
                            ],
                            "conversationId": "conversation-123",
                            "createdAt": "2026-06-30T12:00:00.000Z",
                            "text": "Hello Woodwire",
                        }
                    )
                }
            )

            self.assertEqual(response_key, "outbox/conversation-123/1782820800-response.md")
            self.assertEqual(captured_attachments, [
                os.path.join(conversation_temp_dir, "00-a.txt"),
                os.path.join(conversation_temp_dir, "01-b.txt"),
            ])
            self.assertFalse(os.path.exists(conversation_temp_dir))

        self.assertEqual(s3_client.put_object.call_count, 2)
        self.assertEqual(s3_client.download_file.call_count, 2)
        marker_call, response_call = s3_client.put_object.call_args_list
        self.assertEqual(marker_call.kwargs["Key"], "outbox/conversation-123/processing.json")
        self.assertEqual(response_call.kwargs["Key"], response_key)
        self.assertEqual(response_call.kwargs["ContentType"], "text/markdown; charset=utf-8")
        self.assertEqual(response_call.kwargs["Body"], b"Echo: Hello Woodwire")

    def test_processing_failure_does_not_delete_message(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()

        class FailingBackend:
            def process(self, _message: str, _attachments: list[str]) -> str:
                raise ValueError("processor boom")

        bot = self.create_bot(
            ai_backend=FailingBackend(),
            s3_client=s3_client,
            sqs_client=sqs_client,
        )

        with self.assertRaisesRegex(ValueError, "processor boom"):
            bot.handle_message(build_message())

        sqs_client.change_message_visibility.assert_called_once()
        sqs_client.delete_message.assert_not_called()

    def test_polling_errors_back_off_and_reset_after_success(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        sleep_calls: list[float] = []
        bot = None
        receive_count = 0

        def receive_message(*_args, **_kwargs):
            nonlocal receive_count
            receive_count += 1

            if receive_count == 1:
                raise build_client_error("ReceiveMessage")

            if receive_count == 2:
                return {"Messages": []}

            if receive_count == 3:
                raise build_client_error("ReceiveMessage")

            bot.request_shutdown()
            return {"Messages": []}

        sqs_client.receive_message.side_effect = receive_message
        bot = self.create_bot(
            sleep=sleep_calls.append,
            s3_client=s3_client,
            sqs_client=sqs_client,
        )

        bot.run()

        self.assertEqual(sleep_calls, [INITIAL_BACKOFF_SECONDS, INITIAL_BACKOFF_SECONDS])
        self.assertLessEqual(max(sleep_calls), MAX_BACKOFF_SECONDS)


if __name__ == "__main__":
    unittest.main()
