from __future__ import annotations

import unittest

from bot.main import combine_message_text
from bot.voice import is_supported_audio_content_type


class VoiceHelpersTests(unittest.TestCase):
    def test_is_supported_audio_content_type_accepts_supported_types(self) -> None:
        self.assertTrue(is_supported_audio_content_type("audio/webm"))
        self.assertTrue(is_supported_audio_content_type("audio/mp4"))
        self.assertTrue(is_supported_audio_content_type("audio/ogg"))
        self.assertTrue(is_supported_audio_content_type("Audio/WebM; codecs=opus"))

    def test_is_supported_audio_content_type_rejects_other_types(self) -> None:
        self.assertFalse(is_supported_audio_content_type("audio/mpeg"))
        self.assertFalse(is_supported_audio_content_type("image/png"))
        self.assertFalse(is_supported_audio_content_type(""))

    def test_combine_message_text_prefers_both_text_and_transcript(self) -> None:
        self.assertEqual(
            combine_message_text("Typed note", "Voice note"),
            "Typed note\n\nVoice memo transcript:\nVoice note",
        )

    def test_combine_message_text_returns_transcript_when_text_is_empty(self) -> None:
        self.assertEqual(combine_message_text("", "Voice note"), "Voice note")

    def test_combine_message_text_returns_text_when_transcript_missing(self) -> None:
        self.assertEqual(combine_message_text("Typed note", None), "Typed note")


if __name__ == "__main__":
    unittest.main()
