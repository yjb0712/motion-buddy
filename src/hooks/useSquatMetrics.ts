import { useEffect, useRef, useState } from 'react'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { RepEvent, WorkoutMetrics, WorkoutPhase } from '../types'
import { observeSquatFrame } from '../lib/squatMetrics'

const newId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `rep-${Date.now()}-${Math.random()}`
const event = (kind: RepEvent['kind'], source: RepEvent['source'], delta: 1 | -1): RepEvent => ({ id: newId(), kind, source, delta, occurredAt: new Date().toISOString() })
const initialMetrics = (targetReps: number): WorkoutMetrics => ({
  reps: 0, targetReps, detectedReps: 0, manualAdjustment: 0, repEvents: [],
  feedback: '站到画面中央，准备开始', phase: 'standing', trackingStatus: 'ready',
})

export function useSquatMetrics(landmarks: NormalizedLandmark[] | null, simulated: boolean, active: boolean, targetReps = 20) {
  const [metrics, setMetrics] = useState<WorkoutMetrics>(() => initialMetrics(targetReps))
  const phaseRef = useRef<WorkoutPhase>('standing')
  const reachedBottom = useRef(false)

  useEffect(() => {
    if (!active || simulated) return
    const frame = landmarks ? observeSquatFrame(landmarks) : null
    if (!frame) {
      setMetrics(current => ({ ...current, trackingStatus: 'insufficient', feedback: '我暂时没看清腿部，站回画面里就能继续数' }))
      return
    }
    let phase: WorkoutPhase = phaseRef.current
    let feedback = '我在看着，按你的节奏来'
    if (frame.kneeAngle < 100) {
      phase = 'bottom'; reachedBottom.current = true; feedback = '到底部了，准备起身'
    } else if (frame.kneeAngle < 145) {
      phase = reachedBottom.current ? 'ascending' : 'descending'
      feedback = phase === 'ascending' ? '正在起身' : '正在下蹲'
    } else if (frame.kneeAngle > 158) {
      phase = 'standing'
      if (reachedBottom.current) {
        reachedBottom.current = false
        const repEvent = event('detected', 'mediapipe', 1)
        setMetrics(current => ({
          ...current, reps: current.reps + 1, detectedReps: current.detectedReps + 1,
          repEvents: [...current.repEvents, repEvent], feedback: `第 ${current.reps + 1} 次，记下了`, phase, trackingStatus: 'tracking',
        }))
        phaseRef.current = phase
        return
      }
      feedback = '站稳了，准备下一次'
    }
    phaseRef.current = phase
    setMetrics(current => ({ ...current, phase, feedback, trackingStatus: 'tracking' }))
  }, [landmarks, simulated, active])

  useEffect(() => {
    if (!active || !simulated) return
    let tick = 0
    const timer = window.setInterval(() => {
      tick += 1
      const sequence: WorkoutPhase[] = ['descending', 'bottom', 'ascending', 'standing']
      const phase = sequence[tick % sequence.length]
      const completed = phase === 'standing'
      setMetrics(current => {
        if (!completed) return { ...current, phase, trackingStatus: 'tracking', feedback: phase === 'bottom' ? 'Demo · 到底部了' : phase === 'ascending' ? 'Demo · 正在起身' : 'Demo · 正在下蹲' }
        const repEvent = event('detected', 'demo', 1)
        return { ...current, reps: current.reps + 1, detectedReps: current.detectedReps + 1, repEvents: [...current.repEvents, repEvent], phase, trackingStatus: 'tracking', feedback: `Demo · 第 ${current.reps + 1} 次` }
      })
    }, 550)
    return () => clearInterval(timer)
  }, [active, simulated])

  const adjustReps = (delta: 1 | -1) => setMetrics(current => {
    if (delta < 0 && current.reps <= 0) return current
    const kind = delta > 0 ? 'manual_add' : 'manual_remove'
    return {
      ...current,
      reps: Math.max(0, current.reps + delta),
      manualAdjustment: current.manualAdjustment + delta,
      repEvents: [...current.repEvents, event(kind, 'user', delta)],
      feedback: delta > 0 ? '已补记一次' : '已撤销一次',
    }
  })

  return { metrics, adjustReps }
}
