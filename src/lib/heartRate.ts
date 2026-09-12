import type { CalorieEstimate, HeartRateZone, ZoneDurations } from '../types'

export const emptyZoneDurations = (): ZoneDurations => ({
  zone1Seconds: 0, zone2Seconds: 0, zone3Seconds: 0, zone4Seconds: 0, zone5Seconds: 0,
})

export function getHeartRateZone(bpm: number | null, age: number): HeartRateZone | null {
  if (!bpm || bpm <= 0) return null
  const ratio = bpm / Math.max(1, 220 - age)
  if (ratio < 0.6) return 1
  if (ratio < 0.7) return 2
  if (ratio < 0.8) return 3
  if (ratio < 0.9) return 4
  return 5
}

export function incrementZone(durations: ZoneDurations, zone: HeartRateZone | null, seconds = 1): ZoneDurations {
  const next: ZoneDurations = {
    zone1Seconds: durations.zone1Seconds, zone2Seconds: durations.zone2Seconds, zone3Seconds: durations.zone3Seconds,
    zone4Seconds: durations.zone4Seconds, zone5Seconds: durations.zone5Seconds,
  }
  if (!zone) return next
  const key = `zone${zone}Seconds` as keyof ZoneDurations
  next[key] += seconds
  return next
}

export const totalHeartRateSeconds = (durations: ZoneDurations) =>
  durations.zone1Seconds + durations.zone2Seconds + durations.zone3Seconds + durations.zone4Seconds + durations.zone5Seconds

export function estimateHeartRateCalories(
  durations: ZoneDurations,
  averageBpm: number | null,
  profile: { age: number; weightKg: number | null; gender: 'male' | 'female' },
): CalorieEstimate {
  const validHeartRateSeconds = totalHeartRateSeconds(durations)
  const base: CalorieEstimate = {
    status: 'unavailable', valueKcal: null, algorithmVersion: 'keytel-hr-v1', source: 'ble-heart-rate',
    validHeartRateSeconds, inputs: { averageBpm, ...profile },
    limitation: '基于心率的人群公式估算，力量训练、个体差异和设备误差都会影响结果；仅用于训练记录。',
    unavailableReason: null,
  }
  if (!profile.weightKg || profile.weightKg <= 0) return { ...base, unavailableReason: '缺少体重' }
  if (!averageBpm || averageBpm <= 0) return { ...base, unavailableReason: '缺少有效平均心率' }
  if (validHeartRateSeconds < 30) return { ...base, unavailableReason: '有效心率时长不足 30 秒' }

  const kcalPerMinute = profile.gender === 'male'
    ? (-55.0969 + 0.6309 * averageBpm + 0.1988 * profile.weightKg + 0.2017 * profile.age) / 4.184
    : (-20.4022 + 0.4472 * averageBpm - 0.1263 * profile.weightKg + 0.074 * profile.age) / 4.184
  return {
    ...base,
    status: 'estimated',
    valueKcal: Math.round(Math.max(0, kcalPerMinute) * (validHeartRateSeconds / 60) * 10) / 10,
  }
}
