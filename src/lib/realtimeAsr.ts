import { startMicCapture, type MicCapture } from './micCapture'

const SAMPLE_RATE = 16000
const SILENCE_FINAL_MS = 600
const STARTED_TIMEOUT_MS = 6000

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
  let socketIsNew = false
  let startedWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null
  let mic: MicCapture | null = null
  let starting = false
  let closed = false
  let finalTimer: number | null = null
  let lastText = ''

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
      startedWaiter?.resolve()
      startedWaiter = null
    } else if (message.type === 'partial') {
      lastText = message.text || ''
      if (lastText) {
        callbacks.onPartial(lastText)
        scheduleFinal()
      }
    } else if (message.type === 'error') {
      startedWaiter?.reject(new Error(message.detail || '识别服务出错'))
      startedWaiter = null
      callbacks.onError(message.detail || '识别服务出错')
    }
  }

  const ensureSocket = () => new Promise<{ target: WebSocket; isNew: boolean }>((resolve, reject) => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      resolve({ target: socket, isNew: false })
      return
    }
    const next = new WebSocket(`${wsBase}/ws/asr`)
    socket = next
    socketIsNew = true
    next.onopen = () => {
      next.send(JSON.stringify({ type: 'start', sample_rate: SAMPLE_RATE }))
      resolve({ target: next, isNew: true })
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
    const timer = window.setTimeout(() => {
      startedWaiter = null
      reject(new Error('识别服务启动超时'))
    }, STARTED_TIMEOUT_MS)
    startedWaiter = {
      resolve: () => {
        window.clearTimeout(timer)
        if (target.readyState === WebSocket.OPEN) resolve()
        else reject(new Error('识别服务已断开'))
      },
      reject: (error: Error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    }
  })

  return {
    async start() {
      if (closed || starting) return
      starting = true
      try {
        const { target, isNew } = await ensureSocket()
        if (closed) return
        // 只有新建连接才有 run-task 握手；复用的连接不再重复等 started
        if (isNew && socketIsNew) {
          socketIsNew = false
          await waitForStarted(target)
        }
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
