import type { AppState } from '../types'

export type TrainingState = 'preparing' | 'training' | 'paused' | 'finished'
type ApiResponse = { reply: string; model: string; mode: 'text' | 'vision' }

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
