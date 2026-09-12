import { startMicCapture, type MicCapture } from './micCapture'

const SAMPLE_RATE = 16000
const SILENCE_FINAL_MS = 600

export type RealtimeAsr = {
  /** 连接（若未连）并开始推麦克风音频。幂等。 */
  start: () => Promise<void>
  /** 停止推音频，静默期里攒的文本作为最终结果吐出。识别连接保留复用。 */
  pause: () => void
  /** 结束任务并断开。 */
  close: () => void
}

export function createRealtimeAsr(callbacks: {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (detail: string) => void
}): RealtimeAsr {
  let socket: WebSocket | null = null
  let mic: MicCapture | null = null
  let starting = false
  let closed = false
  let finalTimer: number | null = null
  let lastText = ''
  let notifyStarted: (() => void) | null = null

  const wsBase = (() => {
    const envBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
    if (envBase) return envBase.replace(/^http/, 'ws')
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  })()

  const clearFinalTimer = () => {
    if (finalTimer !== null) {
      window.clearTimeout(finalTimer)
      finalTimer = null
    }
  }

  const flushFinal = () => {
    clearFinalTimer()
    const text = lastText.trim()
    lastText = ''
    if (text) callbacks.onFinal(text)
  }

  const scheduleFinal = () => {
    clearFinalTimer()
    finalTimer = window.setTimeout(flushFinal, SILENCE_FINAL_MS)
  }

  const handleMessage = (event: MessageEvent) => {
    let message: { type?: string; text?: string; detail?: string }
    try {
      message = JSON.parse(event.data as string)
    } catch {
      return
    }
    if (message.type === 'started') {
      notifyStarted?.()
    } else if (message.type === 'partial') {
      lastText = message.text || ''
      if (lastText) {
        callbacks.onPartial(lastText)
        scheduleFinal()
      }
    } else if (message.type === 'error') {
      callbacks.onError(message.detail || '识别服务出错')
    }
  }

  const ensureSocket = () => new Promise<WebSocket>((resolve, reject) => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      resolve(socket)
      return
    }
    const next = new WebSocket(`${wsBase}/ws/asr`)
    socket = next
    next.onopen = () => {
      next.send(JSON.stringify({ type: 'start', sample_rate: SAMPLE_RATE }))
      resolve(next)
    }
    next.onmessage = handleMessage
    next.onerror = () => {
      if (socket === next) socket = null
      reject(new Error('识别服务连接失败'))
    }
    next.onclose = () => {
      if (socket === next) socket = null
    }
  })

  const waitForStarted = (target: WebSocket) => new Promise<void>((resolve, reject) => {
    if (notifyStarted) return
    const timer = window.setTimeout(() => {
      notifyStarted = null
      reject(new Error('识别服务启动超时'))
    }, 4000)
    notifyStarted = () => {
      window.clearTimeout(timer)
      notifyStarted = null
      if (target.readyState === WebSocket.OPEN) resolve()
      else reject(new Error('识别服务已断开'))
    }
  })

  return {
    async start() {
      if (closed || starting) return
      starting = true
      try {
        const target = await ensureSocket()
        if (closed) return
        await waitForStarted(target)
        if (closed) return
        if (!mic) {
          mic = await startMicCapture(pcm => {
            if (target.readyState === WebSocket.OPEN) target.send(pcm)
          }, SAMPLE_RATE)
        }
      } finally {
        starting = false
      }
    },
    pause() {
      flushFinal()
      mic?.stop()
      mic = null
    },
    close() {
      closed = true
      flushFinal()
      mic?.stop()
      mic = null
      const closing = socket
      socket = null
      if (closing && closing.readyState === WebSocket.OPEN) {
        try { closing.send(JSON.stringify({ type: 'finish' })) } catch { /* socket already gone */ }
        window.setTimeout(() => closing.close(), 500)
      }
    },
  }
}
