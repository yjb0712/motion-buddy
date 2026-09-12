import asyncio
import base64
import json
import os
import re
from collections import deque
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator

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
# 对话和语音可以走不同渠道（比如 LLM 用智谱官方、TTS 继续用中转）：不填 TTS_* 时沿用主渠道
TTS_API_BASE_URL = os.getenv("TTS_API_BASE_URL", "").strip().rstrip("/") or MODEL_API_BASE_URL
TTS_URL = f"{TTS_API_BASE_URL}/audio/speech"

HISTORY_TURNS_PER_SESSION = 3
chat_history: dict[str, deque] = {}


def history_messages(session_id: str) -> list[dict]:
    return list(chat_history.get(session_id, ()))


def remember_turn(session_id: str, message: str, reply: str) -> None:
    history = chat_history.setdefault(session_id, deque(maxlen=HISTORY_TURNS_PER_SESSION * 2))
    history.append({"role": "user", "content": message})
    history.append({"role": "assistant", "content": reply})


SENTENCE_ENDINGS = "。！？!?；;"
SENTENCE_TRAILERS = "”’\"')）"


def cut_sentences(buffer: str) -> tuple[list[str], str]:
    """按终止标点把缓冲切成完整句，返回 (完整句列表, 剩余缓冲)。"""
    sentences: list[str] = []
    start = 0
    for index, char in enumerate(buffer):
        if char in SENTENCE_ENDINGS:
            end = index + 1
            while end < len(buffer) and buffer[end] in SENTENCE_TRAILERS:
                end += 1
            sentence = buffer[start:end].strip()
            if sentence:
                sentences.append(sentence)
            start = end
    return sentences, buffer[start:]


class MemoryContext(BaseModel):
    preferred_address: str = Field(default="", max_length=30)
    encouragement_style: Literal["quiet", "warm", "energetic"] = "warm"
    favorite_exercise: str = Field(default="", max_length=50)
    last_user_feeling: str = Field(default="", max_length=30)

    @field_validator("preferred_address", "favorite_exercise", "last_user_feeling", mode="before")
    @classmethod
    def _truncate_text(cls, value):
        # 前端输入自由文本，超长截断而不是整条拒绝（422 会让用户以为服务挂了）
        return str(value)[:30] if value else ""

    @field_validator("encouragement_style", mode="before")
    @classmethod
    def _fallback_style(cls, value):
        return value if value in ("quiet", "warm", "energetic") else "warm"


class CompanionRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=1000)
    training_state: Literal["preparing", "training", "paused", "finished"]
    memory: MemoryContext | None = None

    @field_validator("session_id", "message", mode="before")
    @classmethod
    def _coerce_text(cls, value):
        return str(value) if value is not None else ""


class VisionRequest(CompanionRequest):
    image_data_url: str = Field(min_length=30, max_length=2_500_000)


class CompanionResponse(BaseModel):
    reply: str
    model: str
    mode: Literal["text", "vision"]


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class SummaryLineRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=100)
    reps: int = Field(ge=0, le=10000)
    duration_seconds: int = Field(ge=0, le=86400)
    average_bpm: int | None = Field(default=None, ge=30, le=250)
    calorie_kcal: float | None = Field(default=None, ge=0, le=5000)
    xp_earned: int = Field(ge=0, le=100000)
    streak_days: int = Field(ge=0, le=3650)
    reward_track: Literal["rep_count", "heart_rate"] = "rep_count"
    memory: MemoryContext | None = None


app = FastAPI(title="Motion Buddy API", version="0.1.0")


@app.exception_handler(RequestValidationError)
async def log_validation_error(request: Request, exc: RequestValidationError):
    """被校验拦下的请求把原始内容和原因都记进日志，避免只能看到 422 干瞪眼。"""
    print("== 422 请求体:", str(exc.body)[:400])
    for error in exc.errors()[:5]:
        print("== 422 原因:", error.get("loc"), error.get("msg"))
    return JSONResponse(status_code=422, content={"detail": [{"msg": "请求参数校验未通过，详见服务端日志"}]})


app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://127.0.0.1:5175,http://localhost:5175").split(",")],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

from server.asr_proxy import asr_proxy  # noqa: E402  密钥留在服务端的流式识别代理

app.add_api_websocket_route("/ws/asr", asr_proxy)


STYLE_LINES = {
    "quiet": "话少，常常一两个字就够，不主动找话题。",
    "warm": "温和陪着，语气软一点，像顺毛摸。",
    "energetic": "有劲头，像一起拉练的队友，短促有力。",
}


def system_prompt(training_state: str, memory: MemoryContext | None, vision: bool = False) -> str:
    address = memory.preferred_address if memory and memory.preferred_address else "你"
    style = memory.encouragement_style if memory else "warm"
    memory_line = f"用户允许使用的偏好：称呼 {address}，鼓励风格 {style}。" if memory else "用户没有授权长期记忆，不要假装记得过去。本次对话里说过的你可以直接接话，只是别声称记得其他时间的对话。"
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
6. 像熟悉的朋友自然接话，可以说“好嘞”“我在呢”“走一个”，但不要每句都喊口号，不用分数和等级评价动作。
7. 说话风格：{STYLE_LINES.get(style, STYLE_LINES["warm"])} 禁止“辛苦了”“恭喜你”“坚持就是胜利”这类套话。"""


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


def chat_payload(model: str, messages: list[dict], temperature: float = 0.5, stream: bool = False) -> dict:
    payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": 140}
    if model.lower().startswith("glm"):
        payload["thinking"] = {"type": "disabled"}  # 智谱模型不关思考会把回答写进 reasoning_content，content 变空
    else:
        payload["enable_thinking"] = False
    if stream:
        payload["stream"] = True
    return payload


async def call_dashscope(model: str, messages: list[dict], temperature: float = 0.5) -> str:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
            response = await client.post(
                CHAT_URL,
                headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
                json=chat_payload(model, messages, temperature),
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="模型响应超时，请再说一次") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="暂时无法连接模型服务") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"模型服务请求失败（HTTP {response.status_code}）")
    return _extract_text(response.json())


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def stream_chat_delta(model: str, messages: list[dict]):
    """逐段 yield 大模型流式回复的文本增量。"""
    payload = chat_payload(model, messages, stream=True)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
            async with client.stream(
                "POST",
                CHAT_URL,
                headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    raise HTTPException(status_code=502, detail=f"模型服务请求失败（HTTP {response.status_code}）")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or [{}]
                    piece = (choices[0].get("delta") or {}).get("content")
                    if piece:
                        yield piece
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="模型响应超时，请再说一次") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="暂时无法连接模型服务") from exc


async def tts_speech_bytes(text: str) -> bytes:
    """合成一段语音并返回完整音频字节（含重试）。TTS 渠道的 key 独立配置，缺省沿用主渠道。"""
    payload = {
        "model": TTS_MODEL,
        "input": prepare_speech_text(text),
        "voice": TTS_VOICE,
        "response_format": "mp3",
        "speed": TTS_SPEED,
        "instructions": TTS_INSTRUCTIONS,
    }
    tts_key = (os.getenv("TTS_API_KEY") or "").strip() or _api_key()
    last_status: int | None = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as client:
                response = await client.post(
                    TTS_URL,
                    headers={"Authorization": f"Bearer {tts_key}", "Content-Type": "application/json"},
                    json=payload,
                )
        except (httpx.TimeoutException, httpx.HTTPError):
            if attempt == 0:
                await asyncio.sleep(0.35)
                continue
            raise HTTPException(status_code=504, detail="语音生成超时，请再试一次")

        last_status = response.status_code
        if response.status_code < 400:
            return response.content
        if response.status_code not in (429, 500, 502, 503, 504) or attempt > 0:
            break
        await asyncio.sleep(0.35)

    raise HTTPException(status_code=502, detail=f"语音服务请求失败（HTTP {last_status or 'unknown'}）")


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
        *history_messages(request.session_id),
        {"role": "user", "content": request.message},
    ])
    reply = apply_response_policy(request.message, reply, request.memory)
    remember_turn(request.session_id, request.message, reply)
    return CompanionResponse(reply=reply, model=TEXT_MODEL, mode="text")


def policy_sentence(sentence: str, allow_prescription_check: bool, memory: MemoryContext | None) -> tuple[str, bool]:
    """对单句执行回复策略。返回 (最终句子, 是否触发处方拦截)。"""
    if allow_prescription_check and any(word in sentence for word in PRESCRIPTION_WORDS):
        address = memory.preferred_address if memory and memory.preferred_address else ""
        prefix = f"{address}，" if address else ""
        return f"{prefix}我在呢。先按你舒服的节奏来，准备好就走一个。", True
    return sentence, False


async def _safe_tts(text: str) -> bytes | None:
    try:
        return await tts_speech_bytes(text)
    except HTTPException:
        return None


async def chat_turn_events(request: CompanionRequest):
    """LLM 流式 → 切句 → 每句立刻并行合成 TTS，音频按句序吐出。SSE：sentence / audio / done。"""
    message = request.message
    if any(word in message for word in DISCOMFORT_WORDS):
        fixed = apply_response_policy(message, "", request.memory)
        yield sse_event("sentence", {"text": fixed})
        audio = await _safe_tts(fixed)
        if audio:
            yield sse_event("audio", {"mp3": base64.b64encode(audio).decode()})
        else:
            yield sse_event("tts_error", {"detail": "语音生成失败"})
        yield sse_event("done", {"reason": "policy"})
        return

    messages = [
        {"role": "system", "content": system_prompt(request.training_state, request.memory)},
        *history_messages(request.session_id),
        {"role": "user", "content": message},
    ]
    buffer = ""
    full_reply = ""
    pending: list[asyncio.Task] = []
    blocked = False

    def audio_event(task: asyncio.Task) -> str:
        audio = task.result()
        if audio:
            return sse_event("audio", {"mp3": base64.b64encode(audio).decode()})
        return sse_event("tts_error", {"detail": "语音生成失败"})

    try:
        async for delta in stream_chat_delta(TEXT_MODEL, messages):
            buffer += delta
            sentences, buffer = cut_sentences(buffer)
            for sentence in sentences:
                final, blocked = policy_sentence(sentence, not is_technique_request(message), request.memory)
                full_reply += final
                yield sse_event("sentence", {"text": final})
                pending.append(asyncio.create_task(_safe_tts(final)))
                if blocked:
                    break
            # 已合成完成的音频按句序先吐，没好的继续并行合成
            while pending and pending[0].done():
                yield audio_event(pending.pop(0))
            if blocked:
                break
        tail = buffer.strip()
        if tail and not blocked:
            final, _ = policy_sentence(tail, not is_technique_request(message), request.memory)
            full_reply += final
            yield sse_event("sentence", {"text": final})
            pending.append(asyncio.create_task(_safe_tts(final)))
        # 流结束，按句序等齐剩余音频
        while pending:
            audio = await pending.pop(0)
            if audio:
                yield sse_event("audio", {"mp3": base64.b64encode(audio).decode()})
            else:
                yield sse_event("tts_error", {"detail": "语音生成失败"})
    finally:
        for task in pending:
            task.cancel()
        if full_reply:
            remember_turn(request.session_id, message, full_reply)
    yield sse_event("done", {})


@app.post("/api/companion/chat/stream")
async def companion_chat_stream(request: CompanionRequest):
    _api_key()
    return StreamingResponse(
        chat_turn_events(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def summary_line_prompt(request: SummaryLineRequest) -> str:
    address = request.memory.preferred_address if request.memory and request.memory.preferred_address else "你"
    style = request.memory.encouragement_style if request.memory else "warm"
    minutes, seconds = divmod(request.duration_seconds, 60)
    bpm = f"{request.average_bpm} BPM" if request.average_bpm else "没有心率数据"
    calorie = f"约 {request.calorie_kcal:.0f} kcal" if request.calorie_kcal else "没有消耗数据"
    track = "按确认次数" if request.reward_track == "rep_count" else "按心率消耗"
    return f"""刚陪用户练完一组深蹲，用一句不超过 30 个汉字的口语点评这次训练。称呼用户"{address}"。
说话风格：{STYLE_LINES.get(style, STYLE_LINES["warm"])}
禁止"辛苦了""恭喜你""坚持就是胜利"这类套话，禁止分数、等级和医学结论，不要感叹号，不要引号。
本次数据：确认 {request.reps} 次，时长 {minutes}分{seconds}秒，平均心率 {bpm}，估算消耗 {calorie}，获得 {request.xp_earned} XP，连续训练 {request.streak_days} 天，奖励方式{track}。
挑一两个具体数字随口提起，像朋友收摊时的那句话。直接输出这一句。"""


@app.post("/api/companion/summary-line")
async def companion_summary_line(request: SummaryLineRequest):
    line = await call_dashscope(
        TEXT_MODEL,
        [{"role": "user", "content": summary_line_prompt(request)}],
        temperature=0.9,
    )
    line = line.strip().strip("“”\"'").replace("！", "。")
    if not line:
        raise HTTPException(status_code=502, detail="模型没有返回文本")
    return {"line": line[:60]}


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
    content = await tts_speech_bytes(request.text)
    return Response(
        content=content,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-TTS-Voice": TTS_VOICE},
    )
