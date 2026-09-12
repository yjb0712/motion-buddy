import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import (
    MemoryContext,
    app,
    apply_response_policy,
    cut_sentences,
    is_technique_request,
    prepare_speech_text,
    system_prompt,
)


class AppTests(unittest.TestCase):
    def test_health_does_not_expose_key(self):
        response = TestClient(app).get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("apiKey", response.json())

    def test_prompt_enforces_product_boundary(self):
        prompt = system_prompt("training", MemoryContext(preferred_address="冰冰"))
        self.assertIn("不主动给动作打分", prompt)
        self.assertIn("用户明确询问", prompt)
        self.assertIn("冰冰", prompt)

    def test_missing_key_is_explicit(self):
        with patch.dict("os.environ", {"MODEL_API_KEY": "", "DASHSCOPE_API_KEY": ""}):
            response = TestClient(app).post("/api/companion/chat", json={"session_id": "s1", "message": "陪我练", "training_state": "training"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("MODEL_API_KEY", response.json()["detail"])

    def test_unsolicited_technique_is_blocked(self):
        unsafe = "先站直，脚尖外八，膝盖不要超过脚尖。"
        result = apply_response_policy("我有点紧张，陪我开始", unsafe, MemoryContext(preferred_address="冰冰"))
        self.assertNotIn("膝盖", result)
        self.assertIn("我在呢", result)
        self.assertFalse(is_technique_request("我有点紧张，陪我开始"))
        self.assertTrue(is_technique_request("深蹲应该怎么做"))

    def test_discomfort_uses_fixed_stop_message(self):
        result = apply_response_policy("我膝盖疼", "坚持一下就好了", None)
        self.assertIn("先停下来", result)
        self.assertNotIn("坚持", result)

    def test_speech_text_is_clean_spoken_language(self):
        self.assertEqual(prepare_speech_text("**我在呢** ～\n你慢慢说"), "我在呢。你慢慢说。")

    def test_cut_sentences_keeps_remainder(self):
        sentences, remainder = cut_sentences("好嘞。我在呢！继续")
        self.assertEqual(sentences, ["好嘞。", "我在呢！"])
        self.assertEqual(remainder, "继续")

    def test_cut_sentences_handles_quotes_and_empty(self):
        sentences, remainder = cut_sentences("“走一个。”剩余半句")
        self.assertEqual(sentences, ["“走一个。”"])
        self.assertEqual(remainder, "剩余半句")
        self.assertEqual(cut_sentences("没有标点"), ([], "没有标点"))

    def test_stream_endpoint_requires_key(self):
        with patch.dict("os.environ", {"MODEL_API_KEY": "", "DASHSCOPE_API_KEY": ""}):
            response = TestClient(app).post("/api/companion/chat/stream", json={"session_id": "s1", "message": "陪我练", "training_state": "training"})
        self.assertEqual(response.status_code, 503)

    def test_ws_asr_requires_key(self):
        with patch.dict("os.environ", {"MODEL_API_KEY": "", "DASHSCOPE_API_KEY": ""}):
            with TestClient(app).websocket_connect("/ws/asr") as ws:
                ws.send_json({"sample_rate": 16000})
                message = ws.receive_json()
        self.assertEqual(message["type"], "error")
        self.assertIn("MODEL_API_KEY", message["detail"])


if __name__ == "__main__":
    unittest.main()
