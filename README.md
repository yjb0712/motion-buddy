# 动伴 Motion Buddy Web

面向手机浏览器的陪伴训练原型。训练中由本地 MediaPipe 负责深蹲计数，BLE 心率带提供真实心率数据；动伴负责数数、倾听和按用户请求讲动作要领，不主动给动作打分或判错。

## 已经能跑通的闭环

- 摄像头 + MediaPipe Pose 浏览器端深蹲计数，视频帧不上传
- 每次识别与用户手动 `+1/-1` 修正都保存为 RepEvent
- Web Bluetooth 标准心率服务（0x180D / 0x2A37），支持 uint8/uint16 Measurement、心率区间和断连状态
- 两种互斥奖励方式：确认次数，或 BLE 心率估算消耗；同一 Session 不会重复结算
- 心率估算保存年龄、体重、性别、平均心率、有效时长和 `keytel-hr-v1` 算法版本，并在页面明确标记为估算
- XP 使用 RewardLedger 保存逐条来源；装备按累计次数、训练次数或连续天数解锁
- 用户明确授权后，才在当前设备保存称呼、鼓励偏好和组后感受；撤回授权会清除这部分记忆
- 进入摄像头陪练或次数演示后，麦克风明确显示为在线；说“你好动伴”唤醒，后续语句自动发送给 `qwen3.5-plus`，回复由 `qwen3-tts-flash` 的 `Serena` 声音播放
- 训练结束页的点评按本次数据实时生成（次数、时长、心率、XP、连续天数），不再说“辛苦了”这种套话
- 说“你好动伴，看看画面”或在唤醒后说“帮我看看画面”才调用 `qwen3-vl-flash`；上传前缩到最长边 360px 的 JPEG，以降低等待和费用
- 训练页以摄像头画面为主，MediaPipe 姿态点只在后台用于计数，不在用户画面上绘制骨架、连线或动作评分
- 服务端 Response Policy 会拦截用户未询问时夹带的动作处方；疼痛、眩晕等表达直接走固定停止提示

## 本地运行

安装依赖：

```bash
pnpm install
python -m pip install -r server/requirements.txt
```

复制 `.env.example` 为 `.env`，只在服务端填写 `MODEL_API_KEY`。密钥不能使用 `VITE_` 前缀，也不能写入前端代码。

分别启动 API 和网页：

```bash
pnpm run dev:api
pnpm dev -- --port 5175
```

浏览器打开 `http://127.0.0.1:5175/`。BLE 心率带需要 Chrome 或 Edge，并通过 HTTPS 或 localhost 访问。Vite 会把 `/api` 转发到 `127.0.0.1:8001`；本机的 `8000` 已被其他项目占用，所以不要混用。

## 数据边界

- 次数是本地姿态状态机的观测结果，用户可以修正；它不是动作质量评分。
- 心率区间使用 `220 - 年龄` 的简化最大心率估计，消耗使用人群公式，力量训练与个体差异会影响误差，因此只用于训练记录和游戏奖励。
- “看当前画面”只发送用户主动触发时的一张压缩图片，无法据此评价完整动作过程。
- localStorage 适合黑客松单机原型；账号同步、跨设备长期记忆和删除审计仍需要正式数据库与登录系统。

## 当前语音边界（已实测，2026-09-12 流式改造后）

- 回复改为流式管线：服务端把 `qwen-flash` 的流式输出按标点切句，每句立刻并行调用 TTS 合成，前端按句序无缝播放。不再等整段回复生成完才出声。阿里官方直连实测（2026-09-12）：对话 1.1s、问完到出第一声约 3s、TTS 单句 1.3s（对比中转站时代的 3.5s/9.4s/4.9s 全面提速）。
- 对话保留 session 内最近 3 轮上下文，动伴能接住“我刚说啥”这类追问；跨设备的长期记忆仍需正式数据库。
- 说话时可以打断：播放期单独开一路带回声消除的麦克风做能量检测，检测到用户开口立即停播、清空待播队列并回到聆听态。喇叭外放过大或环境嘈杂可能误触发/漏触发，阈值需真机再调。
- 识别引擎默认走服务端代理的 DashScope Paraformer 实时识别（16kHz PCM 经 `/ws/asr` WebSocket 转发，密钥不进前端，需在 `.env` 设 `VITE_REALTIME_ASR=1`），静默 600ms 判定一句话结束；连接失败自动降级回浏览器原生识别，功能不丢。
- 训练结束页的点评由模型按本次训练数据生成一句 ≤30 字的口语总结，Serena 音色播报；服务端失败时退化为本地模板句。
- 单独说唤醒词时播放随应用发布的 `Serena` 短回应，不请求大模型或云端 TTS。
- “先别听了”会结束当前对话并回到等待唤醒；“关闭麦克风”或界面麦克风按钮会彻底停止识别。
- 模型渠道已切阿里官方 DashScope（`https://dashscope.aliyuncs.com/compatible-mode/v1`）。注意官方兼容层没有 TTS（404），qwen3-tts-flash 走原生 `multimodal-generation` 端点，服务端已自动适配（wav 返回）。LLM 与 TTS 可分别配渠道（`TTS_API_BASE_URL` / `TTS_API_KEY`，不填沿用主渠道）。
- Chrome/Edge 若阻止延迟自动播放，页面会显示“播放语音回复”按钮，由用户点一下播放。
- 私有化备选：[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) 支持语气控制、声音设计、3 秒参考音频克隆和流式生成；[CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 支持情绪指令、零样本声音克隆和双向流式 TTS。两者都需要独立 GPU 服务；声音克隆必须使用获得授权的真人参考音频。参考项目：[OpenAvatarChat](https://github.com/HumanAIGC/OpenAvatarChat)（全链路数字人，需 GPU）、[TEN Framework](https://github.com/ten-framework/ten-framework)（打断与轮次管理）、[pipecat](https://github.com/pipecat-ai/pipecat)（分句流水线架构参考）。

## 验证

```bash
pnpm run test:core
pnpm run test:server
pnpm build
```

核心测试覆盖 BLE 数据解析、心率区间、消耗估算、奖励幂等，以及唤醒、视觉路由、结束对话和关闭麦克风的语义。服务端测试覆盖健康检查、缺少密钥时的明确失败，以及不评分的对话边界。
