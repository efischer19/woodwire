from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import boto3
from bot.ai_backend import AIBackend, build_ai_backend
from bot.voice import (
    LocalVoicePipeline,
    VoiceEngineUnavailableError,
    VoicePipeline,
    is_supported_audio_content_type,
    normalize_content_type,
)
from botocore.exceptions import BotoCoreError, ClientError

LONG_POLL_WAIT_SECONDS = 20
VISIBILITY_TIMEOUT_SECONDS = 120
INITIAL_BACKOFF_SECONDS = 1
MAX_BACKOFF_SECONDS = 60
PROCESSING_MARKER_KEY = "processing.json"
TEMP_DIRECTORY_NAME = "woodwire"
AWS_OPERATION_ERRORS = (BotoCoreError, ClientError)


@dataclass(frozen=True)
class BotConfig:
    aws_access_key_id: str
    aws_region: str
    aws_secret_access_key: str
    s3_bucket_name: str
    sqs_queue_url: str

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "BotConfig":
        env = os.environ if environ is None else environ
        required_keys = (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_REGION",
            "SQS_QUEUE_URL",
            "S3_BUCKET_NAME",
        )
        missing = [key for key in required_keys if not env.get(key)]

        if missing:
            missing_names = ", ".join(sorted(missing))
            raise ValueError(f"Missing required environment variables: {missing_names}")

        return cls(
            aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
            aws_region=env["AWS_REGION"],
            aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
            s3_bucket_name=env["S3_BUCKET_NAME"],
            sqs_queue_url=env["SQS_QUEUE_URL"],
        )


@dataclass(frozen=True)
class DownloadedAttachment:
    content_type: str
    key: str
    local_path: str


@dataclass(frozen=True)
class ProcessedPayload:
    response_audio: bytes | None
    response_text: str


class WoodwireBot:
    def __init__(
        self,
        config: BotConfig,
        *,
        sqs_client: Any | None = None,
        s3_client: Any | None = None,
        logger: logging.Logger | None = None,
        now: Callable[[], datetime] | None = None,
        ai_backend: AIBackend | None = None,
        sleep: Callable[[float], None] = time.sleep,
        temp_root_dir: str | None = None,
        voice_pipeline: VoicePipeline | None = None,
    ) -> None:
        self.config = config
        self.logger = logger or logging.getLogger("woodwire.bot")
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.ai_backend = ai_backend or build_ai_backend(os.environ, logger=self.logger)
        self.sleep = sleep
        self.temp_root_dir = temp_root_dir or tempfile.gettempdir()
        self.voice_pipeline = voice_pipeline or LocalVoicePipeline.from_env(
            os.environ,
            logger=self.logger,
        )
        self.running = True
        self.sqs_client = sqs_client or boto3.client(
            "sqs",
            aws_access_key_id=config.aws_access_key_id,
            aws_secret_access_key=config.aws_secret_access_key,
            region_name=config.aws_region,
        )
        self.s3_client = s3_client or boto3.client(
            "s3",
            aws_access_key_id=config.aws_access_key_id,
            aws_secret_access_key=config.aws_secret_access_key,
            region_name=config.aws_region,
        )

    def request_shutdown(self, signum: int | None = None, _frame: Any | None = None) -> None:
        signal_name = signal.Signals(signum).name if signum is not None else "manual request"
        self.logger.info(
            "Shutdown requested via %s; current work will finish before exit",
            signal_name,
        )
        self.running = False

    def run(self) -> None:
        backoff_seconds = INITIAL_BACKOFF_SECONDS
        self.logger.info("Starting SQS consumer loop")

        while self.running:
            try:
                response = self.sqs_client.receive_message(
                    QueueUrl=self.config.sqs_queue_url,
                    MaxNumberOfMessages=1,
                    WaitTimeSeconds=LONG_POLL_WAIT_SECONDS,
                )
                backoff_seconds = INITIAL_BACKOFF_SECONDS
            except AWS_OPERATION_ERRORS as error:
                self.logger.error("SQS polling failed: %s", error)
                self.logger.info("Retrying SQS poll in %s seconds", backoff_seconds)
                self.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, MAX_BACKOFF_SECONDS)
                continue

            messages = response.get("Messages", [])

            if not messages:
                continue

            if not self.running:
                self.logger.info("Shutdown requested before processing a new message")
                break

            try:
                self.handle_message(messages[0])
            except Exception as error:
                self.logger.error("Message processing failed: %s", error)

        self.logger.info("SQS consumer loop stopped")

    def handle_message(self, message: dict[str, Any]) -> str:
        message_id = message.get("MessageId", "unknown")
        receipt_handle = message["ReceiptHandle"]
        payload = parse_message_body(message["Body"])
        conversation_id = read_conversation_id(payload)

        self.logger.info("Message received: %s", message_id)
        self.sqs_client.change_message_visibility(
            QueueUrl=self.config.sqs_queue_url,
            ReceiptHandle=receipt_handle,
            VisibilityTimeout=VISIBILITY_TIMEOUT_SECONDS,
        )
        self.logger.info("Visibility timeout extended to %s seconds", VISIBILITY_TIMEOUT_SECONDS)
        self.logger.info("Processing started for conversation %s", conversation_id)

        self.write_processing_marker(conversation_id)
        processed_payload = self.process_payload(conversation_id, payload)
        response_key = self.write_response(
            conversation_id,
            processed_payload.response_text,
            response_audio=processed_payload.response_audio,
        )

        self.sqs_client.delete_message(
            QueueUrl=self.config.sqs_queue_url,
            ReceiptHandle=receipt_handle,
        )
        self.logger.info("Response written to s3://%s/%s", self.config.s3_bucket_name, response_key)
        self.logger.info("Message deleted from queue: %s", message_id)
        return response_key

    def process_payload(self, conversation_id: str, payload: dict[str, Any]) -> ProcessedPayload:
        message_text = read_message_text(payload, required=False)
        attachment_keys = read_attachment_keys(payload)
        temp_dir: str | None = None

        try:
            if attachment_keys:
                temp_dir = self.build_temp_directory(conversation_id)
                downloaded_attachments = self.download_attachments(temp_dir, attachment_keys)
            else:
                downloaded_attachments = []

            if not message_text and not downloaded_attachments:
                raise ValueError("Message payload is missing text")

            prompt_text, voice_response_enabled = self.build_backend_message(
                message_text,
                downloaded_attachments,
                temp_dir,
            )
            response_text = self.ai_backend.process(
                prompt_text,
                [attachment.local_path for attachment in downloaded_attachments],
            )

            return ProcessedPayload(
                response_audio=self.build_response_audio(
                    downloaded_attachments,
                    response_text,
                    temp_dir,
                    enabled=voice_response_enabled,
                ),
                response_text=response_text,
            )
        finally:
            if temp_dir is not None:
                self.cleanup_temp_directory(temp_dir)

    def write_processing_marker(self, conversation_id: str) -> None:
        key = f"outbox/{conversation_id}/{PROCESSING_MARKER_KEY}"
        body = json.dumps({"status": "processing"}).encode("utf-8")
        self.s3_client.put_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
            Body=body,
            ContentType="application/json",
        )

    def write_response(
        self,
        conversation_id: str,
        response_text: str,
        *,
        response_audio: bytes | None = None,
    ) -> str:
        timestamp = int(self.now().timestamp())
        key_prefix = f"outbox/{conversation_id}/{timestamp}-response"
        key = f"{key_prefix}.md"
        self.s3_client.put_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
            Body=response_text.encode("utf-8"),
            ContentType="text/markdown; charset=utf-8",
        )

        if response_audio is not None:
            self.s3_client.put_object(
                Bucket=self.config.s3_bucket_name,
                Key=f"{key_prefix}.mp3",
                Body=response_audio,
                ContentType="audio/mpeg",
            )

        return key

    def build_temp_directory(self, conversation_id: str) -> str:
        temp_dir = os.path.join(self.temp_root_dir, TEMP_DIRECTORY_NAME, conversation_id)
        os.makedirs(temp_dir, exist_ok=True)
        return temp_dir

    def download_attachments(
        self,
        temp_dir: str,
        attachment_keys: list[str],
    ) -> list[DownloadedAttachment]:
        downloaded_attachments: list[DownloadedAttachment] = []

        for index, key in enumerate(attachment_keys):
            normalized_key = key.strip()
            local_path = os.path.join(temp_dir, build_attachment_filename(normalized_key, index))
            content_type = self.read_attachment_content_type(normalized_key)
            self.s3_client.download_file(
                self.config.s3_bucket_name,
                normalized_key,
                local_path,
            )
            downloaded_attachments.append(
                DownloadedAttachment(
                    content_type=content_type,
                    key=normalized_key,
                    local_path=local_path,
                )
            )

        return downloaded_attachments

    def read_attachment_content_type(self, key: str) -> str:
        response = self.s3_client.head_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
        )
        content_type = response.get("ContentType", "")
        return normalize_content_type(content_type) if isinstance(content_type, str) else ""

    def build_backend_message(
        self,
        message_text: str,
        attachments: list[DownloadedAttachment],
        temp_dir: str | None,
    ) -> tuple[str, bool]:
        transcript = None
        audio_attachments = [
            attachment
            for attachment in attachments
            if is_supported_audio_content_type(attachment.content_type)
        ]
        voice_response_enabled = bool(audio_attachments)

        if audio_attachments and temp_dir is not None:
            try:
                transcript = self.transcribe_audio_attachments(audio_attachments, temp_dir)
            except VoiceEngineUnavailableError as error:
                self.logger.warning(
                    "%s; continuing with text-only processing",
                    error,
                )
                voice_response_enabled = False

        return combine_message_text(message_text, transcript), voice_response_enabled

    def transcribe_audio_attachments(
        self,
        attachments: list[DownloadedAttachment],
        temp_dir: str,
    ) -> str | None:
        transcripts: list[str] = []

        for attachment in attachments:
            transcript = self.voice_pipeline.transcribe_audio(attachment.local_path, temp_dir)

            if isinstance(transcript, str) and transcript.strip():
                transcripts.append(transcript.strip())

        return "\n\n".join(transcripts).strip() or None

    def build_response_audio(
        self,
        attachments: list[DownloadedAttachment],
        response_text: str,
        temp_dir: str | None,
        *,
        enabled: bool,
    ) -> bytes | None:
        has_audio_attachment = any(
            is_supported_audio_content_type(attachment.content_type) for attachment in attachments
        )

        if not enabled or not has_audio_attachment or temp_dir is None:
            return None

        try:
            audio_path = self.voice_pipeline.synthesize_response(response_text, temp_dir)
        except VoiceEngineUnavailableError as error:
            self.logger.warning("%s; skipping audio response upload", error)
            return None

        if not audio_path:
            return None

        with open(audio_path, "rb") as handle:
            return handle.read()

    def cleanup_temp_directory(self, temp_dir: str) -> None:
        try:
            shutil.rmtree(temp_dir)
        except OSError as error:
            self.logger.warning("Failed to remove temp directory %s: %s", temp_dir, error)


def parse_message_body(body: str) -> dict[str, Any]:
    payload = json.loads(body)

    if not isinstance(payload, dict):
        raise ValueError("Message body must decode to a JSON object")

    return payload


def read_conversation_id(payload: dict[str, Any]) -> str:
    conversation_id = payload.get("conversationId")

    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("Message payload is missing conversationId")

    return conversation_id


def read_message_text(payload: dict[str, Any], *, required: bool = True) -> str:
    text = payload.get("text", "")

    if not isinstance(text, str):
        raise ValueError("Message payload text must be a string")

    if required and not text.strip():
        raise ValueError("Message payload is missing text")

    return text.strip()


def read_attachment_keys(payload: dict[str, Any]) -> list[str]:
    attachments = payload.get("attachments", [])

    if not isinstance(attachments, list):
        raise ValueError("Message payload attachments must be a list")

    normalized_attachments: list[str] = []

    for attachment in attachments:
        if not isinstance(attachment, str) or not attachment.strip():
            raise ValueError("Message payload attachments must be non-empty strings")
        normalized_attachments.append(attachment.strip())

    return normalized_attachments


def build_attachment_filename(key: str, index: int) -> str:
    base_name = os.path.basename(key.rstrip("/"))

    path_separators = {os.path.sep}

    if os.path.altsep:
        path_separators.add(os.path.altsep)

    if base_name in {"", ".", ".."} or any(
        separator in base_name for separator in path_separators
    ):
        base_name = "file"

    return f"attachment-{index:02d}-{base_name}"


def combine_message_text(message_text: str, transcript: str | None) -> str:
    if transcript and message_text:
        return f"{message_text}\n\nVoice memo transcript:\n{transcript}"

    if transcript:
        return transcript

    return message_text


def configure_logging() -> logging.Logger:
    logger = logging.getLogger("woodwire.bot")

    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


def install_signal_handlers(bot: WoodwireBot) -> None:
    signal.signal(signal.SIGINT, bot.request_shutdown)
    signal.signal(signal.SIGTERM, bot.request_shutdown)


def main() -> int:
    logger = configure_logging()

    try:
        config = BotConfig.from_env()
    except ValueError as error:
        logger.error("%s", error)
        return 1

    try:
        bot = WoodwireBot(config, logger=logger)
    except ValueError as error:
        logger.error("%s", error)
        return 1

    install_signal_handlers(bot)
    bot.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
