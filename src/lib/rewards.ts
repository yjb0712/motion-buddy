import type { AppState, DailyMissionProgress, RewardLedgerEntry, WorkoutSession } from '../types'
import { totalHeartRateSeconds } from './heartRate'

const rewardEntry = (session: WorkoutSession, kind: RewardLedgerEntry['kind'], amount: number, evidence: RewardLedgerEntry['evidence']): RewardLedgerEntry => ({
  id: `${session.id}:${kind}`, sessionId: session.id, kind, amount, evidence,
  createdAt: session.endTime || new Date().toISOString(), algorithmVersion: 'reward-v2',
})

export function buildRewardEntries(session: WorkoutSession): RewardLedgerEntry[] {
  const entries: RewardLedgerEntry[] = []
  if (session.endTime && (session.durationSeconds >= 10 || session.reps > 0)) {
    entries.push(rewardEntry(session, 'session_completed', 20, { durationSeconds: session.durationSeconds }))
  }
  if (session.rewardTrack === 'rep_count' && session.reps > 0) {
    entries.push(rewardEntry(session, 'confirmed_reps', session.reps * 3, {
      confirmedReps: session.reps, detectedReps: session.detectedReps, manualAdjustment: session.manualAdjustment,
    }))
  }
  if (session.rewardTrack === 'heart_rate' && session.calorieEstimate.status === 'estimated' && session.calorieEstimate.valueKcal !== null) {
    entries.push(rewardEntry(session, 'estimated_calories', Math.floor(session.calorieEstimate.valueKcal), {
      estimatedKcal: session.calorieEstimate.valueKcal,
      algorithm: session.calorieEstimate.algorithmVersion,
      validHeartRateSeconds: session.calorieEstimate.validHeartRateSeconds,
    }))
  }
  return entries
}

export function calculateWorkoutXP(session: WorkoutSession) {
  return buildRewardEntries(session).reduce((sum, entry) => sum + entry.amount, 0)
}

export const localDateKey = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

export function calculateDailyMissionProgress(history: WorkoutSession[], date = new Date()): DailyMissionProgress {
  const dateKey = localDateKey(date)
  const today = history.filter(session => session.startTime && localDateKey(new Date(session.startTime)) === dateKey)
  return {
    date: dateKey,
    squatReps: today.reduce((sum, session) => sum + session.reps, 0),
    activeSeconds: today.reduce((sum, session) => sum + totalHeartRateSeconds(session), 0),
    completedWorkouts: today.filter(session => Boolean(session.endTime)).length,
  }
}

export function calculateStreakDays(history: WorkoutSession[]) {
  const trainedDates = new Set(history.filter(session => session.startTime).map(session => localDateKey(new Date(session.startTime))))
  let cursor = new Date(), streak = 0
  if (!trainedDates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (trainedDates.has(localDateKey(cursor))) { streak += 1; cursor.setDate(cursor.getDate() - 1) }
  return streak
}

export function applyWorkout(state: AppState, rawSession: WorkoutSession) {
  const duplicate = state.history.find(session => session.id === rawSession.id)
  if (duplicate) return { next: state, session: duplicate }

  const rewardEntries = buildRewardEntries(rawSession)
  const xpEarned = rewardEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const session: WorkoutSession = { ...rawSession, xpEarned, rewardEntries, unlocked: [] }
  const history = [session, ...state.history].slice(0, 100)
  const workouts = state.workouts + 1
  const totalSquats = state.totalSquats + session.reps
  const streakDays = calculateStreakDays(history)
  const unlockRules: Record<string, boolean> = {
    sakura_gloves: totalSquats >= 20,
    purple_star_shorts: totalSquats >= 50,
    sunset_bandana: workouts >= 3,
    shiba_bottle: workouts >= 5,
    emerald_star_medal: streakDays >= 3,
  }
  const unlocked: string[] = []
  const equipment = state.equipment.map(item => {
    if (!item.owned && unlockRules[item.id]) { unlocked.push(item.id); return { ...item, owned: true } }
    return item
  })
  session.unlocked = unlocked

  let level = state.level, xp = state.xp + xpEarned
  while (xp >= 1000) { xp -= 1000; level += 1 }
  const next: AppState = {
    ...state, xp, level, streakDays, workouts, totalSquats, equipment, history,
    rewardLedger: [...rewardEntries, ...state.rewardLedger].slice(0, 500),
    dailyMissionProgress: calculateDailyMissionProgress(history),
  }
  return { next, session }
}
