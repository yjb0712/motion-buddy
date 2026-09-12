import type { AppState } from '../types'

export type TrainingState = 'preparing' | 'training' | 'paused' | 'finished'
type ApiResponse = { reply: string; model: string; mode: 'text' | 'vision' }
export type TurnEvent =
  | { type: 'sentence'; text: string }
  | { type: 'audio'; mp3: string }
  | { type: 'tts_error'; detail: string }

const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const retryableStatus = new Set([429, 502, 503, 504])
const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds))
const memoryPayload = (state: AppState) => state.memory.consent ? {
  preferred_address: state.memory.preferredAddress,
  encouragement_style: state.memory.encouragementStyle,
  favorite_exercise: state.memory.favoriteExercise,
  last_user_feeling: state.memory.reflections[0]?.feeling || '',
} : undefined

async function request(path: string, body: Record<string, unknown>): Promise<ApiResponse> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 35_000)
    try {
      const response = await fetch(`${apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      const payload = await response.json().catch(() => ({}))
      if (response.ok) return payload as ApiResponse
      lastError = new Error(typeof payload.detail === 'string' ? payload.detail : '动伴暂时没有连上服务')
      if (!retryableStatus.has(response.status) || attempt > 0) throw lastError
    } catch (error) {
      lastError = error instanceof DOMException && error.name === 'AbortError'
        ? new Error('动伴等得有点久，请再说一次')
        : error instanceof Error ? error : new Error('动伴暂时没有连上服务')
      if (attempt > 0) throw lastError
    } finally {
      window.clearTimeout(timer)
    }
    await wait(350)
  }
  throw lastError || new Error('动伴暂时没有连上服务')
}

export const askCompanion = (state: AppState, sessionId: string, message: string, trainingState: TrainingState) => request('/api/companion/chat', {
  session_id: sessionId, message, training_state: trainingState, memory: memoryPayload(state),
})

export type SummaryLineData = {
  reps: number
  durationSeconds: number
  averageBpm: number | null
  calorieKcal: number | null
  xpEarned: number
  streakDays: number
  rewardTrack: 'rep_count' | 'heart_rate'
}

export async function fetchSummaryLine(state: AppState, sessionId: string, data: SummaryLineData) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(`${apiBase}/api/companion/summary-line`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        reps: data.reps,
        duration_seconds: data.durationSeconds,
        average_bpm: data.averageBpm,
        calorie_kcal: data.calorieKcal,
        xp_earned: data.xpEarned,
        streak_days: data.streakDays,
        reward_track: data.rewardTrack,
        memory: memoryPayload(state),
      }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : '总结语生成失败')
    return payload.line as string
  } finally {
    window.clearTimeout(timer)
  }
}

export const askCompanionAboutFrame = (state: AppState, sessionId: string, message: string, trainingState: TrainingState, imageDataUrl: string) => request('/api/companion/vision', {
  session_id: sessionId, message, training_state: trainingState, memory: memoryPayload(state), image_data_url: imageDataUrl,
})

export async function streamCompanionSpeech(text: string) {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 45_000)
    try {
      const response = await fetch(`${apiBase}/api/companion/speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal,
      })
      if (response.ok) return response
      const payload = await response.json().catch(() => ({}))
      lastError = new Error(typeof payload.detail === 'string' ? payload.detail : '语音输出暂时不可用')
      if (!retryableStatus.has(response.status) || attempt > 0) throw lastError
    } catch (error) {
      lastError = error instanceof DOMException && error.name === 'AbortError'
        ? new Error('语音生成超时，请再试一次')
        : error instanceof Error ? error : new Error('语音输出暂时不可用')
      if (attempt > 0) throw lastError
    } finally {
      window.clearTimeout(timer)
    }
    await wait(350)
  }
  throw lastError || new Error('语音输出暂时不可用')
}

export const decodeAudioBase64 = (mp3Base64: string) => {
  const binary = atob(mp3Base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: 'audio/mpeg' })
}

export const companionTurn = (state: AppState, sessionId: string, message: string, trainingState: TrainingState) => ({
  sessionId, message, trainingState, memory: memoryPayload(state),
})

export async function streamCompanionTurn(
  state: AppState,
  sessionId: string,
  message: string,
  trainingState: TrainingState,
  onEvent: (event: TurnEvent) => void,
  signal?: AbortSignal,
) {
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  signal?.addEventListener('abort', onExternalAbort)
  const firstPacket = window.setTimeout(() => controller.abort(), 12_000)
  let gotEvent = false
  try {
    const response = await fetch(`${apiBase}/api/companion/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(companionTurn(state, sessionId, message, trainingState)),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(typeof payload.detail === 'string' ? payload.detail : '动伴暂时没有连上服务')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        let name = 'message'
        let data = ''
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        if (!gotEvent) { gotEvent = true; window.clearTimeout(firstPacket) }
        if (name === 'sentence') onEvent({ type: 'sentence', text: JSON.parse(data).text })
        else if (name === 'audio') onEvent({ type: 'audio', mp3: JSON.parse(data).mp3 })
        else if (name === 'tts_error') onEvent({ type: 'tts_error', detail: JSON.parse(data).detail })
        separator = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    throw error instanceof DOMException && error.name === 'AbortError'
      ? new Error(gotEvent ? '动伴说到一半断线了，再说一次' : '动伴等得有点久，请再说一次')
      : error instanceof Error ? error : new Error('动伴暂时没有连上服务')
  } finally {
    window.clearTimeout(firstPacket)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
