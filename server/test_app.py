import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.app import MemoryContext, app, apply_response_policy, is_technique_request, prepare_speech_text, system_prompt


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


if __name__ == "__main__":
    unittest.main()
