from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import boto3
from botocore.exceptions import BotoCoreError, ClientError

LONG_POLL_WAIT_SECONDS = 20
VISIBILITY_TIMEOUT_SECONDS = 120
INITIAL_BACKOFF_SECONDS = 1
MAX_BACKOFF_SECONDS = 60
PROCESSING_MARKER_KEY = "processing.json"
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
        env = environ or os.environ
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


class WoodwireBot:
    def __init__(
        self,
        config: BotConfig,
        *,
        sqs_client: Any | None = None,
        s3_client: Any | None = None,
        logger: logging.Logger | None = None,
        now: Callable[[], datetime] | None = None,
        processor: Callable[[dict[str, Any]], str] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config
        self.logger = logger or logging.getLogger("woodwire.bot")
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.processor = processor or build_default_response
        self.sleep = sleep
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
        response_key = self.write_response(conversation_id, self.processor(payload))

        self.sqs_client.delete_message(
            QueueUrl=self.config.sqs_queue_url,
            ReceiptHandle=receipt_handle,
        )
        self.logger.info("Response written to s3://%s/%s", self.config.s3_bucket_name, response_key)
        self.logger.info("Message deleted from queue: %s", message_id)
        return response_key

    def write_processing_marker(self, conversation_id: str) -> None:
        key = f"outbox/{conversation_id}/{PROCESSING_MARKER_KEY}"
        body = json.dumps({"status": "processing"}).encode("utf-8")
        self.s3_client.put_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
            Body=body,
            ContentType="application/json",
        )

    def write_response(self, conversation_id: str, response_text: str) -> str:
        timestamp = int(self.now().timestamp())
        key = f"outbox/{conversation_id}/{timestamp}-response.md"
        self.s3_client.put_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
            Body=response_text.encode("utf-8"),
            ContentType="text/markdown; charset=utf-8",
        )
        return key


def build_default_response(payload: dict[str, Any]) -> str:
    text = str(payload.get("text", "")).strip()
    return f"# Woodwire Response\n\nEcho: {text}\n"


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

    bot = WoodwireBot(config, logger=logger)
    install_signal_handlers(bot)
    bot.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
