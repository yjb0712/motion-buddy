"""DashScope Paraformer 实时语音识别的 WebSocket 代理。

前端只连本服务的 /ws/asr，密钥留在服务端。协议：
前端 -> 代理：JSON {type:"start", sample_rate} / 二进制 PCM 帧 / JSON {type:"finish"}
代理 -> 前端：JSON {type:"started"} / {type:"partial", text} / {type:"finished"} / {type:"error", detail}
"""

import asyncio
import contextlib
import json
import os
import uuid

import websockets
from fastapi import WebSocket, WebSocketDisconnect

ASR_WS_URL = os.getenv("ASR_WS_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/inference/")
ASR_MODEL = os.getenv("ASR_MODEL", "paraformer-realtime-v2")


def _api_key_str() -> str:
    return (os.getenv("MODEL_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or "").strip()


async def asr_proxy(ws: WebSocket) -> None:
    await ws.accept()
    key = _api_key_str()
    if not key:
        await ws.send_json({"type": "error", "detail": "服务端尚未配置 MODEL_API_KEY"})
        await ws.close()
        return

    try:
        init = await ws.receive_json()
    except WebSocketDisconnect:
        return
    sample_rate = int(init.get("sample_rate", 16000))
    task_id = str(uuid.uuid4())
    run_task = {
        "header": {"action": "run-task", "task_id": task_id, "streaming": "out"},
        "payload": {
            "model": ASR_MODEL,
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "parameters": {"format": "pcm", "sample_rate": sample_rate, "language_hints": ["zh"]},
            "input": {},
        },
    }
    finish_task = {"header": {"action": "finish-task", "task_id": task_id, "streaming": "out"}, "payload": {"input": {}}}

    try:
        async with websockets.connect(ASR_WS_URL, additional_headers={"Authorization": f"Bearer {key}", "user-agent": "MotionBuddy/0.1"}, max_size=None) as upstream:
            await upstream.send(json.dumps(run_task))

            async def pump_upstream() -> None:
                async for raw in upstream:
                    if isinstance(raw, bytes):
                        continue
                    try:
                        message = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    event = (message.get("header") or {}).get("event")
                    if event == "task-started":
                        await ws.send_json({"type": "started"})
                    elif event == "result-generated":
                        sentence = ((message.get("payload") or {}).get("output") or {}).get("sentence") or {}
                        text = sentence.get("text", "")
                        if text:
                            await ws.send_json({"type": "partial", "text": text})
                    elif event == "task-finished":
                        await ws.send_json({"type": "finished"})
                        return
                    elif event == "task-failed":
                        detail = (message.get("header") or {}).get("error_message") or "识别服务失败"
                        await ws.send_json({"type": "error", "detail": detail})
                        return

            upstream_pump = asyncio.create_task(pump_upstream())
            try:
                while True:
                    message = await ws.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    text = message.get("text")
                    if text is not None:
                        command = json.loads(text)
                        if command.get("type") == "finish":
                            await upstream.send(json.dumps(finish_task))
                            # pump 任务收到 task-finished 会给前端发 finished 再结束
                            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
                                await asyncio.wait_for(asyncio.shield(upstream_pump), timeout=5)
                            break
                    data = message.get("bytes")
                    if data is not None:
                        await upstream.send(data)
            except WebSocketDisconnect:
                pass
            finally:
                upstream_pump.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await upstream_pump
    except Exception as exc:  # 连接上游失败（网络/鉴权）
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "detail": f"识别服务连接失败：{exc}"})
    finally:
        with contextlib.suppress(Exception):
            await ws.close()
