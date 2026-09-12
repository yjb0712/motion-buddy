import { useCallback, useEffect, useMemo, useRef } from 'react'

const CHECK_INTERVAL_MS = 100
const ABOVE_THRESHOLD_CHECKS = 5
const CALIBRATION_SAMPLES = 6
const MIN_THRESHOLD = 0.05
const NOISE_FLOOR_FACTOR = 3.5
const GRACE_MS = 800

/**
 * 播放期的打断检测：单独开一路带回声消除的麦克风，
 * 先用前 600ms 校准底噪，之后能量连续超阈值就判定用户开口。
 * 拿不到这一路麦克风时静默降级（只是没有打断能力）。
 */
export function useBargeInDetector(onDetected: () => void) {
  const stopRef = useRef<(() => void) | null>(null)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  const stop = useCallback(() => {
    stopRef.current?.()
  }, [])

  const start = useCallback(() => {
    stopRef.current?.()
    let stopped = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let timer: number | null = null
    const cleanup = () => {
      if (stopped) return
      stopped = true
      if (timer !== null) window.clearInterval(timer)
      stream?.getTracks().forEach(track => track.stop())
      void context?.close().catch(() => undefined)
      if (stopRef.current === cleanup) stopRef.current = null
    }
    stopRef.current = cleanup
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        if (stopped) return
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        context.createMediaStreamSource(stream).connect(analyser)
        const buffer = new Float32Array(analyser.fftSize)
        let noiseFloor = 0
        let calibrationSamples = 0
        let aboveCount = 0
        const startedAt = Date.now()
        timer = window.setInterval(() => {
          // 播放起音阶段喇叭和 AEC 还没稳定，留出宽限期不打断
          if (Date.now() - startedAt < GRACE_MS) return
          analyser.getFloatTimeDomainData(buffer)
          let sum = 0
          for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index]
          const rms = Math.sqrt(sum / buffer.length)
          if (calibrationSamples < CALIBRATION_SAMPLES) {
            noiseFloor = Math.max(noiseFloor, rms)
            calibrationSamples += 1
            return
          }
          const threshold = Math.max(MIN_THRESHOLD, noiseFloor * NOISE_FLOOR_FACTOR)
          aboveCount = rms > threshold ? aboveCount + 1 : 0
          if (aboveCount >= ABOVE_THRESHOLD_CHECKS) {
            cleanup()
            onDetectedRef.current()
          }
        }, CHECK_INTERVAL_MS)
      } catch {
        cleanup()
      }
    })()
  }, [])

  useEffect(() => () => stopRef.current?.(), [])

  // 引用必须稳定：调用方把它放进 useCallback/effect 依赖，每次渲染换新对象会让对方的重置 effect 反复触发
  return useMemo(() => ({ start, stop }), [start, stop])
}
