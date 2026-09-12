import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export interface SquatFrameObservation {
  kneeAngle: number
  visible: true
}

const angle = (a: NormalizedLandmark, b: NormalizedLandmark, c: NormalizedLandmark) => {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)
  let degrees = Math.abs(radians * 180 / Math.PI)
  if (degrees > 180) degrees = 360 - degrees
  return degrees
}

export function observeSquatFrame(points: NormalizedLandmark[]): SquatFrameObservation | null {
  if (points.length < 29) return null
  const required = [23, 24, 25, 26, 27, 28]
  if (required.some(index => (points[index].visibility ?? 1) < .45)) return null
  const leftKnee = angle(points[23], points[25], points[27])
  const rightKnee = angle(points[24], points[26], points[28])
  return { kneeAngle: (leftKnee + rightKnee) / 2, visible: true }
}
