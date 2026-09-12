import emeraldStarMedal from '../assets/equipment/badge/emerald_star_medal.png'
import purpleStarShorts from '../assets/equipment/bottom/purple_star_shorts.png'
import sakuraGloves from '../assets/equipment/gloves/sakura_gloves.png'
import penguinHood from '../assets/equipment/head/penguin_hood.png'
import sunsetBandana from '../assets/equipment/head/sunset_bandana.png'
import shibaBottle from '../assets/equipment/prop/shiba_bottle.png'
import cometRunningShoes from '../assets/equipment/shoes/comet_running_shoes.png'
import oceanWaveTop from '../assets/equipment/top/ocean_wave_top.png'
import type { AppState, Equipment } from '../types'

export const equipmentSeed: Equipment[] = [
  { id: 'penguin_hood', name: '企鹅兜帽', slot: 'head', rarity: 'N', image: penguinHood, accent: '#55c9ff', condition: '正式装备素材', owned: true },
  { id: 'sunset_bandana', name: '落日头巾', slot: 'head', rarity: 'N', image: sunsetBandana, accent: '#ff8c64', condition: '累计完成 3 次训练', owned: false },
  { id: 'ocean_wave_top', name: '海浪上衣', slot: 'top', rarity: 'N', image: oceanWaveTop, accent: '#3fd9f1', condition: '正式装备素材', owned: true },
  { id: 'purple_star_shorts', name: '紫星短裤', slot: 'bottom', rarity: 'N', image: purpleStarShorts, accent: '#9b74f5', condition: '累计完成 50 次深蹲', owned: false },
  { id: 'comet_running_shoes', name: '彗星跑鞋', slot: 'shoes', rarity: 'N', image: cometRunningShoes, accent: '#52c8ff', condition: '正式装备素材', owned: true },
  { id: 'sakura_gloves', name: '樱花手套', slot: 'gloves', rarity: 'N', image: sakuraGloves, accent: '#ff8eb7', condition: '累计完成 20 次深蹲', owned: false },
  { id: 'shiba_bottle', name: '柴犬水壶', slot: 'prop', rarity: 'N', image: shibaBottle, accent: '#f2a34a', condition: '累计完成 5 次训练', owned: false },
  { id: 'emerald_star_medal', name: '翡翠星勋章', slot: 'badge', rarity: 'N', image: emeraldStarMedal, accent: '#21d98a', condition: '连续训练 3 天', owned: false },
]

export const initialState: AppState = {
  gender: 'male', nickname: 'Jero', age: 24, weightKg: null, heightCm: null, level: 1, xp: 0, streakDays: 0, workouts: 0, totalSquats: 0,
  equipment: equipmentSeed,
  equipped: { head: 'penguin_hood', top: 'ocean_wave_top', shoes: 'comet_running_shoes' },
  history: [],
  rewardLedger: [],
  dailyMissionProgress: { date: '', squatReps: 0, activeSeconds: 0, completedWorkouts: 0 },
  memory: { consent: false, preferredAddress: '', encouragementStyle: 'warm', favoriteExercise: '', reflections: [], updatedAt: null },
}
