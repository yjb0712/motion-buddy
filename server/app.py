import asyncio
import os
import re
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

TEXT_MODEL = os.getenv("QWEN_TEXT_MODEL", "qwen3.5-plus")
VISION_MODEL = os.getenv("QWEN_VISION_MODEL", "qwen3-vl-flash")
TTS_MODEL = os.getenv("QWEN_TTS_MODEL", "qwen3-tts-flash")
TTS_VOICE = os.getenv("QWEN_TTS_VOICE", "Serena")
TTS_SPEED = float(os.getenv("QWEN_TTS_SPEED", "0.96"))
TTS_INSTRUCTIONS = os.getenv(
    "QWEN_TTS_INSTRUCTIONS",
    "像关系很熟的年轻朋友一样自然说话，声音温暖、有一点俏皮，停顿自然，不要播音腔，不要夸张表演。",
)
MODEL_API_BASE_URL = os.getenv("MODEL_API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
CHAT_URL = f"{MODEL_API_BASE_URL}/chat/completions"
TTS_URL = f"{MODEL_API_BASE_URL}/audio/speech"


class MemoryContext(BaseModel):
    preferred_address: str = Field(default="", max_length=30)
    encouragement_style: Literal["quiet", "warm", "energetic"] = "warm"
    favorite_exercise: str = Field(default="", max_length=50)
    last_user_feeling: str = Field(default="", max_length=30)


class CompanionRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=1000)
    training_state: Literal["preparing", "training", "paused", "finished"]
    memory: MemoryContext | None = None


class VisionRequest(CompanionRequest):
    image_data_url: str = Field(min_length=30, max_length=2_500_000)


class CompanionResponse(BaseModel):
    reply: str
    model: str
    mode: Literal["text", "vision"]


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


app = FastAPI(title="Motion Buddy API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://127.0.0.1:5175,http://localhost:5175").split(",")],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def system_prompt(training_state: str, memory: MemoryContext | None, vision: bool = False) -> str:
    address = memory.preferred_address if memory and memory.preferred_address else "你"
    style = memory.encouragement_style if memory else "warm"
    memory_line = f"用户允许使用的偏好：称呼 {address}，鼓励风格 {style}。" if memory else "用户没有授权长期记忆，不要假装记得过去。"
    vision_line = "你只看到用户主动发送的一张当前画面。只描述画面中能直接观察到的内容和机位，不推断完整动作质量。" if vision else ""
    return f"""你是动伴，一个训练时陪用户说话的伙伴。当前训练状态：{training_state}。
{memory_line}
{vision_line}
规则：
1. 默认负责倾听、简短回应和正向陪伴，不主动给动作打分、判断对错、诊断疲劳或制定训练负荷。
2. 用户明确询问动作怎么做时，才用大白话给 1 到 3 个安全、易执行的要点；一次只说一个调整。
3. 用户说疼痛、不舒服或眩晕时，让他停止当前动作并寻求现场专业帮助，不继续鼓励硬撑。
4. 不把摄像头、次数或心率数据包装成医学结论。心率消耗只能称为估算。
5. 回复控制在 45 个汉字以内，使用适合直接说出口的口语短句。少用书面连接词、排比、编号和感叹号。
6. 像熟悉的朋友自然接话，可以说“好嘞”“我在呢”“走一个”，但不要每句都喊口号，不用分数和等级评价动作。"""


TECHNIQUE_REQUEST_WORDS = ("怎么做", "动作要领", "姿势", "技术", "教我", "该怎么", "怎么蹲", "怎么练", "哪里不对", "帮我看动作")
DISCOMFORT_WORDS = ("疼", "痛", "眩晕", "头晕", "胸闷", "恶心", "不舒服", "喘不过气")
PRESCRIPTION_WORDS = ("脚尖", "膝盖", "膝", "站直", "站稳", "蹲下", "下蹲", "核心", "背部", "腰背", "髋", "脚跟", "重心", "呼气", "吸气")


def is_technique_request(message: str) -> bool:
    return any(word in message for word in TECHNIQUE_REQUEST_WORDS)


def apply_response_policy(message: str, reply: str, memory: MemoryContext | None) -> str:
    address = memory.preferred_address if memory and memory.preferred_address else ""
    prefix = f"{address}，" if address else ""
    if any(word in message for word in DISCOMFORT_WORDS):
        return f"{prefix}先停下来，别硬撑。缓一缓，必要时找现场专业人员。"
    if not is_technique_request(message) and any(word in reply for word in PRESCRIPTION_WORDS):
        return f"{prefix}我在呢。先按你舒服的节奏来，准备好就走一个。"
    return reply[:80].strip()


def _api_key() -> str:
    key = (os.getenv("MODEL_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="服务端尚未配置 MODEL_API_KEY")
    return key


def _extract_text(payload: dict) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="模型返回格式无法识别") from exc
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(item.get("text", "") for item in content if isinstance(item, dict)).strip()
    raise HTTPException(status_code=502, detail="模型没有返回文本")


def prepare_speech_text(text: str) -> str:
    spoken = re.sub(r"[`*_#>]", "", text)
    spoken = re.sub(r"\s+", " ", spoken).strip()
    spoken = spoken.replace("～", "。").replace("~", "。")
    spoken = re.sub(r"\s*([，。！？!?])\s*", r"\1", spoken)
    if spoken and spoken[-1] not in "。！？!?":
        spoken += "。"
    return spoken[:500]


async def call_dashscope(model: str, messages: list[dict]) -> str:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
            response = await client.post(
                CHAT_URL,
                headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
                json={"model": model, "messages": messages, "temperature": 0.5, "max_tokens": 140, "enable_thinking": False},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="模型响应超时，请再说一次") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="暂时无法连接模型服务") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"模型服务请求失败（HTTP {response.status_code}）")
    return _extract_text(response.json())


@app.get("/api/health")
def health():
    return {
        "status": "ok", "modelApiConfigured": bool((os.getenv("MODEL_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or "").strip()),
        "textModel": TEXT_MODEL, "visionModel": VISION_MODEL, "ttsModel": TTS_MODEL, "ttsVoice": TTS_VOICE,
    }


@app.post("/api/companion/chat", response_model=CompanionResponse)
async def companion_chat(request: CompanionRequest):
    reply = await call_dashscope(TEXT_MODEL, [
        {"role": "system", "content": system_prompt(request.training_state, request.memory)},
        {"role": "user", "content": request.message},
    ])
    return CompanionResponse(reply=apply_response_policy(request.message, reply, request.memory), model=TEXT_MODEL, mode="text")


@app.post("/api/companion/vision", response_model=CompanionResponse)
async def companion_vision(request: VisionRequest):
    if not request.image_data_url.startswith(("data:image/jpeg;base64,", "data:image/png;base64,")):
        raise HTTPException(status_code=400, detail="只接受用户主动发送的 JPEG 或 PNG 当前画面")
    reply = await call_dashscope(VISION_MODEL, [
        {"role": "system", "content": system_prompt(request.training_state, request.memory, vision=True)},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": request.image_data_url}},
            {"type": "text", "text": request.message},
        ]},
    ])
    return CompanionResponse(reply=reply, model=VISION_MODEL, mode="vision")


@app.post("/api/companion/speech")
async def companion_speech(request: SpeechRequest):
    payload = {
        "model": TTS_MODEL,
        "input": prepare_speech_text(request.text),
        "voice": TTS_VOICE,
        "response_format": "mp3",
        "speed": TTS_SPEED,
        "instructions": TTS_INSTRUCTIONS,
    }
    last_status: int | None = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
                response = await client.post(
                    TTS_URL,
                    headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            if attempt == 0:
                await asyncio.sleep(0.35)
                continue
            raise HTTPException(status_code=504, detail="语音生成超时，请再试一次") from exc
        except httpx.HTTPError as exc:
            if attempt == 0:
                await asyncio.sleep(0.35)
                continue
            raise HTTPException(status_code=502, detail="暂时无法连接语音服务") from exc

        last_status = response.status_code
        if response.status_code < 400:
            return Response(
                content=response.content,
                media_type="audio/mpeg",
                headers={"Cache-Control": "no-store", "X-TTS-Voice": TTS_VOICE},
            )
        if response.status_code not in (429, 500, 502, 503, 504) or attempt > 0:
            break
        await asyncio.sleep(0.35)

    raise HTTPException(status_code=502, detail=f"语音服务请求失败（HTTP {last_status or 'unknown'}）")
