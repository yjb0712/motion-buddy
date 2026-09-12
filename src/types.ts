export type Route = 'home' | 'workout' | 'summary' | 'avatar' | 'inventory'
export type Slot = 'head' | 'top' | 'bottom' | 'shoes' | 'gloves' | 'prop' | 'badge' | 'effect'
export type Rarity = 'N' | 'R' | 'SR' | 'SSR'
export type HeartRateZone = 1 | 2 | 3 | 4 | 5
export type WorkoutPhase = 'standing' | 'descending' | 'bottom' | 'ascending'
export type RewardTrack = 'rep_count' | 'heart_rate'
export type RepEventKind = 'detected' | 'manual_add' | 'manual_remove'
export type EncouragementStyle = 'quiet' | 'warm' | 'energetic'

export interface Equipment {
  id: string
  name: string
  slot: Slot
  rarity: Rarity
  image: string
  accent: string
  condition: string
  owned: boolean
}

export interface RepEvent {
  id: string
  kind: RepEventKind
  delta: 1 | -1
  occurredAt: string
  source: 'mediapipe' | 'demo' | 'user'
}

export interface WorkoutMetrics {
  reps: number
  targetReps: number
  detectedReps: number
  manualAdjustment: number
  repEvents: RepEvent[]
  feedback: string
  phase: WorkoutPhase
  trackingStatus: 'ready' | 'tracking' | 'insufficient'
}

export interface ZoneDurations {
  zone1Seconds: number
  zone2Seconds: number
  zone3Seconds: number
  zone4Seconds: number
  zone5Seconds: number
}

export interface CalorieEstimate {
  status: 'estimated' | 'unavailable'
  valueKcal: number | null
  algorithmVersion: 'keytel-hr-v1'
  source: 'ble-heart-rate'
  validHeartRateSeconds: number
  inputs: { averageBpm: number | null; age: number; weightKg: number | null; gender: 'male' | 'female' }
  limitation: string
  unavailableReason: string | null
}

export interface RewardLedgerEntry {
  id: string
  sessionId: string
  kind: 'session_completed' | 'confirmed_reps' | 'estimated_calories'
  amount: number
  evidence: Record<string, string | number | null>
  createdAt: string
  algorithmVersion: 'reward-v2'
}

export interface WorkoutSession extends WorkoutMetrics, ZoneDurations {
  id: string
  schemaVersion: 2
  exerciseType: 'squat'
  rewardTrack: RewardTrack
  startTime: string
  endTime: string | null
  durationSeconds: number
  currentBpm: number | null
  averageBpm: number | null
  maxBpm: number | null
  heartRateSource: 'ble' | null
  profileSnapshot: { age: number; weightKg: number | null; gender: 'male' | 'female' }
  calorieEstimate: CalorieEstimate
  xpEarned: number
  rewardEntries: RewardLedgerEntry[]
  unlocked: string[]
}

export interface DailyMissionProgress {
  date: string
  squatReps: number
  activeSeconds: number
  completedWorkouts: number
}

export interface SavedReflection {
  id: string
  sessionId: string
  feeling: 'easy' | 'good' | 'tired' | 'uncomfortable'
  savedAt: string
  source: 'user_report'
}

export interface CompanionMemory {
  consent: boolean
  preferredAddress: string
  encouragementStyle: EncouragementStyle
  favoriteExercise: string
  reflections: SavedReflection[]
  updatedAt: string | null
}

export interface AppState {
  gender: 'male' | 'female'
  nickname: string
  age: number
  weightKg: number | null
  heightCm: number | null
  level: number
  xp: number
  streakDays: number
  workouts: number
  totalSquats: number
  equipment: Equipment[]
  equipped: Partial<Record<Slot, string>>
  history: WorkoutSession[]
  rewardLedger: RewardLedgerEntry[]
  dailyMissionProgress: DailyMissionProgress
  memory: CompanionMemory
}
