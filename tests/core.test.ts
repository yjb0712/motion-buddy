import assert from 'node:assert/strict'
import { estimateHeartRateCalories, getHeartRateZone } from '../src/lib/heartRate'
import { applyWorkout, buildRewardEntries, calculateWorkoutXP } from '../src/lib/rewards'
import { parseHeartRateMeasurement } from '../src/services/bleHeartRate'
import { chooseRecognitionText, containsWakePhrase, interpretVoiceCommand } from '../src/lib/voiceCommands'
import type { AppState, WorkoutSession } from '../src/types'

const uint8 = new DataView(Uint8Array.from([0x00, 147]).buffer)
const uint16 = new DataView(Uint8Array.from([0x01, 0x34, 0x01]).buffer)
assert.equal(parseHeartRateMeasurement(uint8), 147, 'flags bit0=0 应按 uint8 解析')
assert.equal(parseHeartRateMeasurement(uint16), 308, 'flags bit0=1 应按 little-endian uint16 解析')

assert.equal(getHeartRateZone(110, 20), 1)
assert.equal(getHeartRateZone(120, 20), 2)
assert.equal(getHeartRateZone(140, 20), 3)
assert.equal(getHeartRateZone(160, 20), 4)
assert.equal(getHeartRateZone(180, 20), 5)

const zones = { zone1Seconds: 0, zone2Seconds: 30, zone3Seconds: 300, zone4Seconds: 30, zone5Seconds: 0 }
const profile = { age: 24, weightKg: 75, gender: 'male' as const }
const estimate = estimateHeartRateCalories(zones, 145, profile)
assert.equal(estimate.status, 'estimated')
assert.equal(estimate.algorithmVersion, 'keytel-hr-v1')
assert.ok((estimate.valueKcal || 0) > 0)
assert.equal(estimateHeartRateCalories(zones, 145, { ...profile, weightKg: null }).unavailableReason, '缺少体重')

const baseSession: WorkoutSession = {
  id: 'test', schemaVersion: 2, exerciseType: 'squat', rewardTrack: 'rep_count', startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationSeconds: 360,
  reps: 20, targetReps: 20, detectedReps: 20, manualAdjustment: 0, repEvents: [], feedback: '', phase: 'standing', trackingStatus: 'tracking',
  currentBpm: 150, averageBpm: 145, maxBpm: 170, heartRateSource: 'ble', ...zones,
  profileSnapshot: profile, calorieEstimate: estimate, xpEarned: 0, rewardEntries: [], unlocked: [],
}
assert.equal(calculateWorkoutXP(baseSession), 80, '次数成长只发完成奖励和确认次数奖励')
assert.deepEqual(buildRewardEntries(baseSession).map(entry => entry.kind), ['session_completed', 'confirmed_reps'])

const heartSession = { ...baseSession, id: 'heart', rewardTrack: 'heart_rate' as const }
assert.deepEqual(buildRewardEntries(heartSession).map(entry => entry.kind), ['session_completed', 'estimated_calories'])
assert.equal(calculateWorkoutXP(heartSession), 20 + Math.floor(estimate.valueKcal || 0), '心率成长不得重复发次数奖励')

const state: AppState = {
  gender: 'male', nickname: 'test', age: 24, weightKg: 75, heightCm: null, level: 1, xp: 0, streakDays: 0, workouts: 0, totalSquats: 0,
  equipment: [], equipped: {}, history: [], rewardLedger: [], dailyMissionProgress: { date: '', squatReps: 0, activeSeconds: 0, completedWorkouts: 0 },
  memory: { consent: false, preferredAddress: '', encouragementStyle: 'warm', favoriteExercise: '', reflections: [], updatedAt: null },
}
const first = applyWorkout(state, baseSession)
const duplicate = applyWorkout(first.next, baseSession)
assert.equal(first.next.workouts, 1)
assert.equal(duplicate.next.workouts, 1, '同一 session 重复结算不能再次发奖')
assert.equal(duplicate.next.rewardLedger.length, first.next.rewardLedger.length)

assert.equal(interpretVoiceCommand('今天天气不错', false).intent, 'ignore', '未唤醒时不得发送普通语句')
assert.deepEqual(interpretVoiceCommand('你好动伴', false), { intent: 'chat', text: '你好动伴', nextAwake: true, wokeNow: true })
assert.equal(interpretVoiceCommand('你好动伴，看看画面', false).intent, 'vision', '唤醒词可以直接携带视觉请求')
assert.equal(interpretVoiceCommand('帮我看看画面', true).intent, 'vision', '唤醒后视觉请求应路由到视觉模型')
assert.equal(interpretVoiceCommand('先别听了', true).intent, 'sleep', '结束对话后继续等待下一次唤醒')
assert.equal(interpretVoiceCommand('关闭麦克风', true).intent, 'disable', '用户必须能彻底停止监听')
assert.equal(containsWakePhrase('你好，动办'), true, '常见同音误识别仍应唤醒')
assert.equal(containsWakePhrase('你好动漫'), true, '单字识别偏差仍应唤醒')
assert.equal(containsWakePhrase('你好东西'), false, '不能把普通问候宽松成任意唤醒')
assert.equal(chooseRecognitionText(['你好东西', '你好动伴'], false), '你好动伴', '多个候选中应优先选择可唤醒文本')

console.log('Core tests passed: data integrity, rewards, and wake-word voice routing')
