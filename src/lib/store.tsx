import { createContext, useContext, useEffect, useState } from 'react'
import { equipmentSeed, initialState } from './data'
import type { AppState, CompanionMemory, SavedReflection, Slot, WorkoutSession } from '../types'
import { applyWorkout, calculateDailyMissionProgress } from './rewards'
import { emptyZoneDurations } from './heartRate'

type ProfileUpdate = Partial<Pick<AppState, 'nickname' | 'age' | 'weightKg' | 'heightCm' | 'gender'>>
type Store = {
  state: AppState
  finishWorkout: (session: WorkoutSession) => WorkoutSession
  equip: (slot: Slot, id: string) => void
  updateProfile: (profile: ProfileUpdate) => void
  updateMemory: (memory: Partial<Omit<CompanionMemory, 'reflections'>>) => void
  saveReflection: (sessionId: string, feeling: SavedReflection['feeling']) => boolean
  reset: () => void
}
const StoreContext = createContext<Store | null>(null)
const keys = {
  legacy: 'motion-buddy-state', profile: 'motion-buddy:userProfile', history: 'motion-buddy:workoutHistory',
  progress: 'motion-buddy:progress', unlocked: 'motion-buddy:unlockedEquipment', equipped: 'motion-buddy:equippedItems',
  rewards: 'motion-buddy:rewardLedger', memory: 'motion-buddy:companionMemory',
}

const read = <T,>(key: string): T | null => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : null } catch { return null } }
const unavailableCalories = (age: number, weightKg: number | null, gender: 'male' | 'female') => ({
  status: 'unavailable' as const, valueKcal: null, algorithmVersion: 'keytel-hr-v1' as const, source: 'ble-heart-rate' as const,
  validHeartRateSeconds: 0, inputs: { averageBpm: null, age, weightKg, gender },
  limitation: '旧记录没有可复算的完整心率输入。', unavailableReason: '旧版记录',
})

function normalizeSession(value: unknown, profile: Pick<AppState, 'age' | 'weightKg' | 'gender'>): WorkoutSession | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<WorkoutSession> & Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.startTime !== 'string' || typeof item.reps !== 'number') return null
  const zones = { ...emptyZoneDurations(), ...item }
  return {
    id: item.id, schemaVersion: 2, exerciseType: 'squat', rewardTrack: item.rewardTrack === 'heart_rate' ? 'heart_rate' : 'rep_count',
    startTime: item.startTime, endTime: typeof item.endTime === 'string' ? item.endTime : null,
    durationSeconds: typeof item.durationSeconds === 'number' ? item.durationSeconds : 0,
    reps: Math.max(0, item.reps), targetReps: typeof item.targetReps === 'number' ? item.targetReps : 20,
    detectedReps: typeof item.detectedReps === 'number' ? item.detectedReps : Math.max(0, item.reps),
    manualAdjustment: typeof item.manualAdjustment === 'number' ? item.manualAdjustment : 0,
    repEvents: Array.isArray(item.repEvents) ? item.repEvents : [],
    feedback: typeof item.feedback === 'string' ? item.feedback : '', phase: item.phase || 'standing',
    trackingStatus: item.trackingStatus || 'ready',
    currentBpm: typeof item.currentBpm === 'number' ? item.currentBpm : null,
    averageBpm: typeof item.averageBpm === 'number' ? item.averageBpm : null,
    maxBpm: typeof item.maxBpm === 'number' ? item.maxBpm : null,
    heartRateSource: item.heartRateSource === 'ble' ? 'ble' : null,
    zone1Seconds: Number(zones.zone1Seconds) || 0, zone2Seconds: Number(zones.zone2Seconds) || 0,
    zone3Seconds: Number(zones.zone3Seconds) || 0, zone4Seconds: Number(zones.zone4Seconds) || 0, zone5Seconds: Number(zones.zone5Seconds) || 0,
    profileSnapshot: item.profileSnapshot || profile,
    calorieEstimate: item.calorieEstimate || unavailableCalories(profile.age, profile.weightKg, profile.gender),
    xpEarned: typeof item.xpEarned === 'number' ? item.xpEarned : 0,
    rewardEntries: Array.isArray(item.rewardEntries) ? item.rewardEntries : [],
    unlocked: Array.isArray(item.unlocked) ? item.unlocked : [],
  }
}

function loadState(): AppState {
  const legacy = read<Partial<AppState>>(keys.legacy)
  const profile = read<Partial<Pick<AppState, 'gender' | 'nickname' | 'age' | 'weightKg' | 'heightCm'>>>(keys.profile)
  const gender = profile?.gender === 'female' || legacy?.gender === 'female' ? 'female' : 'male'
  const age = Number(profile?.age ?? legacy?.age ?? initialState.age)
  const weightKg = typeof profile?.weightKg === 'number' ? profile.weightKg : typeof legacy?.weightKg === 'number' ? legacy.weightKg : null
  const rawHistory = read<unknown[]>(keys.history) || (legacy?.history as unknown[] | undefined) || []
  const history = rawHistory.map(item => normalizeSession(item, { age, weightKg, gender })).filter((item): item is WorkoutSession => Boolean(item))
  const progress = read<Partial<Pick<AppState, 'level' | 'xp' | 'workouts' | 'totalSquats'>>>(keys.progress)
  const unlockedIds = new Set(read<string[]>(keys.unlocked) || legacy?.equipment?.filter(item => item.owned).map(item => item.id) || [])
  const validIds = new Set(equipmentSeed.map(item => item.id))
  const savedEquipped = read<AppState['equipped']>(keys.equipped) || legacy?.equipped || {}
  const equipped = Object.fromEntries(Object.entries(savedEquipped).filter(([, id]) => typeof id === 'string' && validIds.has(id) && (equipmentSeed.find(item => item.id === id)?.owned || unlockedIds.has(id)))) as AppState['equipped']
  const equipment = equipmentSeed.map(item => ({ ...item, owned: item.owned || unlockedIds.has(item.id) }))
  const memory = read<CompanionMemory>(keys.memory)
  const rewardLedger = read<AppState['rewardLedger']>(keys.rewards) || history.flatMap(session => session.rewardEntries)
  return {
    ...initialState, ...legacy, ...profile, ...progress, gender, age, weightKg,
    history, rewardLedger, equipment, equipped: { ...initialState.equipped, ...equipped },
    dailyMissionProgress: calculateDailyMissionProgress(history),
    memory: memory ? { ...initialState.memory, ...memory, reflections: Array.isArray(memory.reflections) ? memory.reflections : [] } : initialState.memory,
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(loadState)
  useEffect(() => {
    localStorage.setItem(keys.profile, JSON.stringify({ gender: state.gender, nickname: state.nickname, age: state.age, weightKg: state.weightKg, heightCm: state.heightCm }))
    localStorage.setItem(keys.history, JSON.stringify(state.history))
    localStorage.setItem(keys.progress, JSON.stringify({ level: state.level, xp: state.xp, workouts: state.workouts, totalSquats: state.totalSquats }))
    localStorage.setItem(keys.unlocked, JSON.stringify(state.equipment.filter(item => item.owned).map(item => item.id)))
    localStorage.setItem(keys.equipped, JSON.stringify(state.equipped))
    localStorage.setItem(keys.rewards, JSON.stringify(state.rewardLedger))
    localStorage.setItem(keys.memory, JSON.stringify(state.memory))
  }, [state])

  const finishWorkout = (raw: WorkoutSession) => {
    const { next, session } = applyWorkout(state, raw)
    setState(next)
    return session
  }
  const equip = (slot: Slot, id: string) => setState(current => ({ ...current, equipped: { ...current.equipped, [slot]: id } }))
  const updateProfile = (profile: ProfileUpdate) => setState(current => ({ ...current, ...profile }))
  const updateMemory = (memory: Partial<Omit<CompanionMemory, 'reflections'>>) => setState(current => {
    if (memory.consent === false) return { ...current, memory: { ...initialState.memory } }
    return { ...current, memory: { ...current.memory, ...memory, updatedAt: new Date().toISOString() } }
  })
  const saveReflection = (sessionId: string, feeling: SavedReflection['feeling']) => {
    if (!state.memory.consent) return false
    const reflection: SavedReflection = { id: `${sessionId}:${Date.now()}`, sessionId, feeling, savedAt: new Date().toISOString(), source: 'user_report' }
    setState(current => ({ ...current, memory: { ...current.memory, reflections: [reflection, ...current.memory.reflections.filter(item => item.sessionId !== sessionId)].slice(0, 30), updatedAt: reflection.savedAt } }))
    return true
  }
  const reset = () => { Object.values(keys).forEach(key => localStorage.removeItem(key)); setState(initialState) }
  return <StoreContext.Provider value={{ state, finishWorkout, equip, updateProfile, updateMemory, saveReflection, reset }}>{children}</StoreContext.Provider>
}

export const useStore = () => {
  const value = useContext(StoreContext)
  if (!value) throw new Error('StoreProvider missing')
  return value
}
