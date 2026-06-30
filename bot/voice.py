from __future__ import annotations

import logging
import os
import subprocess
from typing import Any, Callable, Protocol

DEFAULT_STT_COMPUTE_TYPE = "int8"
DEFAULT_STT_DEVICE = "cpu"
DEFAULT_STT_ENGINE = "faster-whisper"
DEFAULT_STT_MODEL = "base"
DEFAULT_TTS_ENGINE = "piper"
SUPPORTED_AUDIO_CONTENT_TYPES = frozenset(
    {
        "audio/mp4",
        "audio/ogg",
        "audio/webm",
    }
)


class VoicePipeline(Protocol):
    def transcribe_audio(self, audio_path: str, temp_dir: str) -> str | None: ...

    def synthesize_response(self, text: str, temp_dir: str) -> str | None: ...


class VoiceEngineUnavailableError(RuntimeError):
    """Raised when an optional local voice dependency is unavailable."""


class LocalVoicePipeline:
    def __init__(
        self,
        *,
        stt_engine: str = DEFAULT_STT_ENGINE,
        stt_model: str = DEFAULT_STT_MODEL,
        stt_device: str = DEFAULT_STT_DEVICE,
        stt_compute_type: str = DEFAULT_STT_COMPUTE_TYPE,
        tts_engine: str = DEFAULT_TTS_ENGINE,
        piper_model_path: str = "",
        logger: logging.Logger | None = None,
        run_command: Callable[..., Any] = subprocess.run,
        whisper_model_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.logger = logger or logging.getLogger("woodwire.bot")
        self.run_command = run_command
        self.stt_engine = normalize_engine_name(stt_engine, DEFAULT_STT_ENGINE)
        self.stt_model = stt_model.strip() or DEFAULT_STT_MODEL
        self.stt_device = stt_device.strip() or DEFAULT_STT_DEVICE
        self.stt_compute_type = stt_compute_type.strip() or DEFAULT_STT_COMPUTE_TYPE
        self.tts_engine = normalize_engine_name(tts_engine, DEFAULT_TTS_ENGINE)
        self.piper_model_path = piper_model_path.strip()
        self.whisper_model_factory = whisper_model_factory or build_whisper_model
        self._whisper_model: Any | None = None
        validate_stt_engine(self.stt_engine)
        validate_tts_engine(self.tts_engine)

    @classmethod
    def from_env(
        cls,
        environ: dict[str, str] | None = None,
        *,
        logger: logging.Logger | None = None,
    ) -> "LocalVoicePipeline":
        env = os.environ if environ is None else environ
        return cls(
            stt_engine=env.get("STT_ENGINE", DEFAULT_STT_ENGINE),
            stt_model=env.get("STT_MODEL", DEFAULT_STT_MODEL),
            stt_device=env.get("STT_DEVICE", DEFAULT_STT_DEVICE),
            stt_compute_type=env.get("STT_COMPUTE_TYPE", DEFAULT_STT_COMPUTE_TYPE),
            tts_engine=env.get("TTS_ENGINE", DEFAULT_TTS_ENGINE),
            piper_model_path=env.get("PIPER_MODEL_PATH") or env.get("PIPER_MODEL", ""),
            logger=logger,
        )

    def transcribe_audio(self, audio_path: str, temp_dir: str) -> str | None:
        if self.stt_engine in {"disabled", "none"}:
            return None

        if self.stt_engine == "faster-whisper":
            wav_path = os.path.join(temp_dir, "stt-input.wav")
            self._run_optional_command(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    audio_path,
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    wav_path,
                ],
                unavailable_message=(
                    "STT engine faster-whisper is unavailable because ffmpeg is not installed"
                ),
            )
            model = self._get_whisper_model()
            segments, transcription_info = model.transcribe(wav_path)
            transcript_parts: list[str] = []
            del transcription_info

            for segment in segments:
                segment_text = getattr(segment, "text", "")

                if isinstance(segment_text, str) and segment_text.strip():
                    transcript_parts.append(segment_text.strip())

            return " ".join(transcript_parts).strip() or None

        raise ValueError(f"Unsupported STT_ENGINE value: {self.stt_engine}")

    def synthesize_response(self, text: str, temp_dir: str) -> str | None:
        if self.tts_engine in {"disabled", "none"}:
            return None

        if self.tts_engine == "piper":
            if not self.piper_model_path:
                raise VoiceEngineUnavailableError(
                    "TTS engine piper is unavailable because PIPER_MODEL_PATH is not set"
                )

            wav_path = os.path.join(temp_dir, "tts-output.wav")
            mp3_path = os.path.join(temp_dir, "response.mp3")
            self._run_optional_command(
                [
                    "piper",
                    "--model",
                    self.piper_model_path,
                    "--output_file",
                    wav_path,
                ],
                unavailable_message=(
                    "TTS engine piper is unavailable because the piper binary is not installed"
                ),
                input=text.encode("utf-8"),
            )
            self._run_optional_command(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    wav_path,
                    "-codec:a",
                    "libmp3lame",
                    "-q:a",
                    "2",
                    mp3_path,
                ],
                unavailable_message=(
                    "TTS engine piper is unavailable because ffmpeg is not installed"
                ),
            )
            return mp3_path

        raise ValueError(f"Unsupported TTS_ENGINE value: {self.tts_engine}")

    def _get_whisper_model(self) -> Any:
        if self._whisper_model is not None:
            return self._whisper_model

        self._whisper_model = self.whisper_model_factory(
            self.stt_model,
            device=self.stt_device,
            compute_type=self.stt_compute_type,
        )
        return self._whisper_model

    def _run_optional_command(
        self,
        args: list[str],
        *,
        unavailable_message: str,
        input: bytes | None = None,
    ) -> None:
        try:
            self.run_command(
                args,
                input=input,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as error:
            raise VoiceEngineUnavailableError(unavailable_message) from error


def build_whisper_model(model_name: str, **kwargs: Any) -> Any:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise VoiceEngineUnavailableError(
            "STT engine faster-whisper is unavailable because the faster-whisper package is not installed"
        ) from error

    return WhisperModel(model_name, **kwargs)


def is_supported_audio_content_type(content_type: str) -> bool:
    return normalize_content_type(content_type) in SUPPORTED_AUDIO_CONTENT_TYPES


def normalize_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def normalize_engine_name(engine_name: str, default_value: str) -> str:
    return engine_name.strip().lower() or default_value


def validate_stt_engine(engine_name: str) -> None:
    if engine_name not in {"disabled", "faster-whisper", "none"}:
        raise ValueError(f"Unsupported STT_ENGINE value: {engine_name}")


def validate_tts_engine(engine_name: str) -> None:
    if engine_name not in {"disabled", "none", "piper"}:
        raise ValueError(f"Unsupported TTS_ENGINE value: {engine_name}")
