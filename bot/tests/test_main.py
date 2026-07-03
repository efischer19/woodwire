from __future__ import annotations

import base64
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
    SUPPORTED_SCHEMA_VERSION,
    VISIBILITY_TIMEOUT_SECONDS,
    WoodwireBot,
    combine_message_text,
    decrypt_payload_bytes,
    encrypt_payload_bytes,
    read_schema_version,
)
from bot.voice import VoiceEngineUnavailableError
from botocore.exceptions import ClientError


def build_client_error(operation_name: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "InternalError", "Message": "temporary failure"}},
        operation_name,
    )


def build_message(
    text: str = "Hello",
    *,
    attachments: list[str] | None = None,
    schema_version: int = 1,
) -> dict[str, str]:
    return {
        "Body": json.dumps(
            {
                "attachments": attachments or [],
                "conversationId": "conversation-123",
                "createdAt": "2026-06-30T12:00:00.000Z",
                "schemaVersion": schema_version,
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
            e2ee_key=None,
            s3_bucket_name="woodwire-chat",
            sqs_queue_url="https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat",
        )
        self.fixed_now = datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc)
        self.e2ee_key = bytes(range(1, 33))

    def create_bot(self, **overrides) -> WoodwireBot:
        config = overrides.pop("config", self.config)
        return WoodwireBot(
            config,
            logger=overrides.pop("logger", Mock()),
            now=overrides.pop("now", lambda: self.fixed_now),
            ai_backend=overrides.pop("ai_backend", MockBackend()),
            sleep=overrides.pop("sleep", lambda seconds: None),
            s3_client=overrides.pop("s3_client", Mock()),
            sqs_client=overrides.pop("sqs_client", Mock()),
            temp_root_dir=overrides.pop("temp_root_dir", tempfile.gettempdir()),
            voice_pipeline=overrides.pop("voice_pipeline", Mock()),
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
        message_text = "Hello Woodwire"

        class RecordingBackend(MockBackend):
            def process(self, message: str, attachments: list[str]) -> str:
                test_case.assertEqual(message, message_text)
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

            s3_client.head_object.return_value = {"ContentType": "text/plain"}
            s3_client.download_file.side_effect = download_file
            bot = self.create_bot(
                ai_backend=RecordingBackend(),
                s3_client=s3_client,
                sqs_client=sqs_client,
                temp_root_dir=temp_root_dir,
            )

            response_key = bot.handle_message(
                build_message(
                    message_text,
                    attachments=[
                        "attachments/conversation-123/a.txt",
                        "attachments/conversation-123/b.txt",
                    ],
                )
            )

            self.assertEqual(response_key, "outbox/conversation-123/1782820800-response.md")
            self.assertEqual(captured_attachments, [
                os.path.join(conversation_temp_dir, "attachment-00-a.txt"),
                os.path.join(conversation_temp_dir, "attachment-01-b.txt"),
            ])
            self.assertFalse(os.path.exists(conversation_temp_dir))

        self.assertEqual(s3_client.put_object.call_count, 2)
        self.assertEqual(s3_client.head_object.call_count, 2)
        self.assertEqual(s3_client.download_file.call_count, 2)
        marker_call, response_call = s3_client.put_object.call_args_list
        self.assertEqual(marker_call.kwargs["Key"], "outbox/conversation-123/processing.json")
        self.assertEqual(response_call.kwargs["Key"], response_key)
        self.assertEqual(response_call.kwargs["ContentType"], "text/markdown; charset=utf-8")
        self.assertEqual(response_call.kwargs["Body"], f"Echo: {message_text}".encode("utf-8"))

    def test_audio_attachment_transcribes_message_and_uploads_mp3_response(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        recorded_messages: list[str] = []
        recorded_transcriptions: list[str] = []
        recorded_synthesis: list[str] = []
        test_case = self

        class RecordingBackend(MockBackend):
            def process(self, message: str, attachments: list[str]) -> str:
                recorded_messages.append(message)
                test_case.assertEqual(len(attachments), 1)
                return "Spoken reply"

        class RecordingVoicePipeline:
            def transcribe_audio(self, audio_path: str, _temp_dir: str) -> str:
                recorded_transcriptions.append(audio_path)
                return "Transcribed voice memo"

            def synthesize_response(self, text: str, temp_dir: str) -> str:
                recorded_synthesis.append(text)
                output_path = os.path.join(temp_dir, "response.mp3")

                with open(output_path, "wb") as handle:
                    handle.write(b"mp3-data")

                return output_path

        s3_client.head_object.return_value = {"ContentType": "audio/webm"}

        with tempfile.TemporaryDirectory() as temp_root_dir:
            conversation_temp_dir = os.path.join(
                temp_root_dir,
                "woodwire",
                "conversation-123",
            )

            def download_file(_bucket: str, key: str, filename: str) -> None:
                self.assertTrue(filename.startswith(conversation_temp_dir))

                with open(filename, "wb") as handle:
                    handle.write(key.encode("utf-8"))

            s3_client.download_file.side_effect = download_file
            bot = self.create_bot(
                ai_backend=RecordingBackend(),
                s3_client=s3_client,
                sqs_client=sqs_client,
                temp_root_dir=temp_root_dir,
                voice_pipeline=RecordingVoicePipeline(),
            )

            response_key = bot.handle_message(
                build_message(
                    "",
                    attachments=["attachments/conversation-123/voice-note.webm"],
                )
            )

            self.assertEqual(response_key, "outbox/conversation-123/1782820800-response.md")
            self.assertEqual(recorded_messages, ["Transcribed voice memo"])
            self.assertEqual(
                recorded_transcriptions,
                [os.path.join(conversation_temp_dir, "attachment-00-voice-note.webm")],
            )
            self.assertEqual(recorded_synthesis, ["Spoken reply"])
            self.assertFalse(os.path.exists(conversation_temp_dir))

        self.assertEqual(s3_client.put_object.call_count, 3)
        marker_call, response_call, audio_call = s3_client.put_object.call_args_list
        self.assertEqual(marker_call.kwargs["Key"], "outbox/conversation-123/processing.json")
        self.assertEqual(response_call.kwargs["Key"], response_key)
        self.assertEqual(audio_call.kwargs["Key"], "outbox/conversation-123/1782820800-response.mp3")
        self.assertEqual(audio_call.kwargs["ContentType"], "audio/mpeg")
        self.assertEqual(audio_call.kwargs["Body"], b"mp3-data")

    def test_schema_version_2_decrypts_audio_and_encrypts_responses(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        decrypted_audio_payload = b"voice-note-bytes"
        encrypted_text = base64.b64encode(
            encrypt_payload_bytes(b"Encrypted hello", self.e2ee_key)
        ).decode("ascii")
        recorded_messages: list[str] = []
        recorded_audio_bytes: list[bytes] = []
        test_case = self
        config = BotConfig(
            aws_access_key_id=self.config.aws_access_key_id,
            aws_region=self.config.aws_region,
            aws_secret_access_key=self.config.aws_secret_access_key,
            e2ee_key=self.e2ee_key,
            s3_bucket_name=self.config.s3_bucket_name,
            sqs_queue_url=self.config.sqs_queue_url,
        )

        class RecordingBackend(MockBackend):
            def process(self, message: str, attachments: list[str]) -> str:
                recorded_messages.append(message)
                test_case.assertEqual(len(attachments), 1)
                return "Encrypted reply"

        class RecordingVoicePipeline:
            def __init__(self, test_case: "WoodwireBotTests") -> None:
                self.test_case = test_case

            def transcribe_audio(self, audio_path: str, _temp_dir: str) -> str:
                with open(audio_path, "rb") as handle:
                    recorded_audio_bytes.append(handle.read())
                return "Voice memo transcript"

            def synthesize_response(self, text: str, temp_dir: str) -> str:
                self.test_case.assertEqual(text, "Encrypted reply")
                output_path = os.path.join(temp_dir, "response.mp3")

                with open(output_path, "wb") as handle:
                    handle.write(b"encrypted-mp3")

                return output_path

        s3_client.head_object.return_value = {"ContentType": "audio/webm"}

        with tempfile.TemporaryDirectory() as temp_root_dir:
            conversation_temp_dir = os.path.join(
                temp_root_dir,
                "woodwire",
                "conversation-123",
            )

            def download_file(_bucket: str, _key: str, filename: str) -> None:
                self.assertTrue(filename.startswith(conversation_temp_dir))
                with open(filename, "wb") as handle:
                    handle.write(encrypt_payload_bytes(decrypted_audio_payload, self.e2ee_key))

            s3_client.download_file.side_effect = download_file
            bot = self.create_bot(
                ai_backend=RecordingBackend(),
                config=config,
                s3_client=s3_client,
                sqs_client=sqs_client,
                temp_root_dir=temp_root_dir,
                voice_pipeline=RecordingVoicePipeline(self),
            )

            response_key = bot.handle_message(
                build_message(
                    encrypted_text,
                    attachments=["attachments/conversation-123/voice-note.webm"],
                    schema_version=2,
                )
            )

            self.assertEqual(response_key, "outbox/conversation-123/1782820800-response.md")
            self.assertEqual(
                recorded_messages,
                ["Encrypted hello\n\nVoice memo transcript:\nVoice memo transcript"],
            )
            self.assertEqual(recorded_audio_bytes, [decrypted_audio_payload])

        marker_call, response_call, audio_call = s3_client.put_object.call_args_list
        self.assertEqual(marker_call.kwargs["Key"], "outbox/conversation-123/processing.json")
        self.assertEqual(
            decrypt_payload_bytes(response_call.kwargs["Body"], self.e2ee_key),
            b"Encrypted reply",
        )
        self.assertEqual(
            decrypt_payload_bytes(audio_call.kwargs["Body"], self.e2ee_key),
            b"encrypted-mp3",
        )

    def test_schema_version_2_requires_e2ee_key(self) -> None:
        bot = self.create_bot()

        encrypted_text = base64.b64encode(
            encrypt_payload_bytes(b"Encrypted hello", self.e2ee_key)
        ).decode("ascii")

        with self.assertRaisesRegex(ValueError, "Encrypted messages require WOODWIRE_E2EE_KEY"):
            bot.handle_message(build_message(encrypted_text, schema_version=2))

    def test_audio_attachment_falls_back_to_text_only_when_voice_engine_unavailable(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        recorded_messages: list[str] = []
        logger = Mock()
        test_case = self

        class RecordingBackend(MockBackend):
            def process(self, message: str, attachments: list[str]) -> str:
                recorded_messages.append(message)
                test_case.assertEqual(len(attachments), 1)
                return "Typed reply"

        class UnavailableVoicePipeline:
            def transcribe_audio(self, _audio_path: str, _temp_dir: str) -> str:
                raise VoiceEngineUnavailableError("STT engine faster-whisper is unavailable")

            def synthesize_response(self, _text: str, _temp_dir: str) -> str:
                raise AssertionError("TTS should be skipped when STT is unavailable")

        s3_client.head_object.return_value = {"ContentType": "audio/ogg"}

        with tempfile.TemporaryDirectory() as temp_root_dir:
            def download_file(_bucket: str, key: str, filename: str) -> None:
                with open(filename, "wb") as handle:
                    handle.write(key.encode("utf-8"))

            s3_client.download_file.side_effect = download_file
            bot = self.create_bot(
                ai_backend=RecordingBackend(),
                logger=logger,
                s3_client=s3_client,
                sqs_client=sqs_client,
                temp_root_dir=temp_root_dir,
                voice_pipeline=UnavailableVoicePipeline(),
            )

            response_key = bot.handle_message(
                build_message(
                    "Fallback text",
                    attachments=["attachments/conversation-123/voice-note.ogg"],
                )
            )

        self.assertEqual(response_key, "outbox/conversation-123/1782820800-response.md")
        self.assertEqual(recorded_messages, ["Fallback text"])
        self.assertEqual(s3_client.put_object.call_count, 2)
        logger.warning.assert_called_once()

    def test_handle_message_rejects_empty_text_without_attachments(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        bot = self.create_bot(s3_client=s3_client, sqs_client=sqs_client)

        with self.assertRaisesRegex(
            ValueError,
            "Message payload is missing both text and attachments",
        ):
            bot.handle_message(build_message(""))

    def test_combine_message_text_prefers_both_text_and_transcript(self) -> None:
        self.assertEqual(
            combine_message_text("Typed note", "Voice note"),
            "Typed note\n\nVoice memo transcript:\nVoice note",
        )

    def test_combine_message_text_returns_transcript_when_text_is_empty(self) -> None:
        self.assertEqual(combine_message_text("", "Voice note"), "Voice note")

    def test_combine_message_text_returns_text_when_transcript_missing(self) -> None:
        self.assertEqual(combine_message_text("Typed note", None), "Typed note")

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

    def test_processing_failure_deletes_processing_marker(self) -> None:
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

        # Verify delete_object was called for the processing marker
        delete_calls = s3_client.delete_object.call_args_list
        self.assertEqual(len(delete_calls), 1)
        delete_args = delete_calls[0]
        self.assertEqual(delete_args[1]["Bucket"], "woodwire-chat")
        self.assertEqual(delete_args[1]["Key"], "outbox/conversation-123/processing.json")

    def test_marker_deletion_failure_does_not_mask_original_exception(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        logger = Mock()

        class FailingBackend:
            def process(self, _message: str, _attachments: list[str]) -> str:
                raise ValueError("processor boom")

        s3_client.delete_object.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "Access Denied"}},
            "DeleteObject",
        )

        bot = self.create_bot(
            ai_backend=FailingBackend(),
            s3_client=s3_client,
            sqs_client=sqs_client,
            logger=logger,
        )

        # The original exception should be raised, not the deletion error
        with self.assertRaisesRegex(ValueError, "processor boom"):
            bot.handle_message(build_message())

        # Verify warning was logged exactly once about marker deletion failure
        logger.warning.assert_called_once()
        warning_call_args = logger.warning.call_args[0]
        # logger.warning("Failed to delete processing marker %s: %s", key, error)
        self.assertEqual(len(warning_call_args), 3)
        self.assertIn("Failed to delete processing marker", warning_call_args[0])
        self.assertEqual(warning_call_args[1], "outbox/conversation-123/processing.json")

    def test_handle_message_rejects_unsupported_schema_version(self) -> None:
        sqs_client = Mock()
        s3_client = Mock()
        logger = Mock()

        bot = self.create_bot(
            s3_client=s3_client,
            sqs_client=sqs_client,
            logger=logger,
        )

        message = {
            "Body": json.dumps(
                {
                    "schemaVersion": 999,
                    "attachments": [],
                    "conversationId": "conversation-123",
                    "createdAt": "2026-06-30T12:00:00.000Z",
                    "text": "Hello",
                }
            ),
            "MessageId": "message-123",
            "ReceiptHandle": "receipt-123",
        }

        with self.assertRaisesRegex(ValueError, "Message schema version 999 is not supported"):
            bot.handle_message(message)

        sqs_client.delete_message.assert_not_called()
        logger.warning.assert_called_once()

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

    def test_read_schema_version_defaults_to_1_when_missing(self) -> None:
        payload = {"conversationId": "conversation-123", "text": "Hello"}
        self.assertEqual(read_schema_version(payload), 1)

    def test_read_schema_version_returns_valid_version(self) -> None:
        payload = {"schemaVersion": 1, "conversationId": "conversation-123"}
        self.assertEqual(read_schema_version(payload), 1)

    def test_read_schema_version_raises_for_invalid_type(self) -> None:
        payload = {"schemaVersion": "1"}
        with self.assertRaisesRegex(ValueError, "Message schemaVersion must be a positive integer"):
            read_schema_version(payload)

    def test_read_schema_version_raises_for_negative_version(self) -> None:
        payload = {"schemaVersion": 0}
        with self.assertRaisesRegex(ValueError, "Message schemaVersion must be a positive integer"):
            read_schema_version(payload)

    def test_read_schema_version_returns_unsupported_future_version(self) -> None:
        payload = {"schemaVersion": 999}
        # Function should return the version without error
        # The unsupported version check happens in handle_message
        self.assertEqual(read_schema_version(payload), 999)


if __name__ == "__main__":
    unittest.main()
