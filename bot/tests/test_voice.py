from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
