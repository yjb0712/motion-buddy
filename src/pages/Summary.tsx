import { useEffect, useState } from 'react'
import { AvatarFigure } from '../components/AvatarFigure'
import { Icon } from '../components/Icons'
import { equipmentSeed } from '../lib/data'
import { useStore } from '../lib/store'
import type { SavedReflection, WorkoutSession } from '../types'

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
const feelingLabels: Record<SavedReflection['feeling'], string> = { easy: '比较轻松', good: '刚刚好', tired: '有点累', uncomfortable: '有不舒服' }

export function Summary({ result, avatar, home }: { result: WorkoutSession; avatar: () => void; home: () => void }) {
  const { state, saveReflection } = useStore()
  const [reward, setReward] = useState(result.unlocked.length > 0)
  const [savedFeeling, setSavedFeeling] = useState<SavedReflection['feeling'] | null>(state.memory.reflections.find(item => item.sessionId === result.id)?.feeling || null)
  useEffect(() => { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance('训练完成，辛苦了'); speechSynthesis.speak(u) } }, [])
  const zones = [result.zone1Seconds, result.zone2Seconds, result.zone3Seconds, result.zone4Seconds, result.zone5Seconds]
  const unlockedItem = equipmentSeed.find(item => item.id === result.unlocked[0])
  const remember = (feeling: SavedReflection['feeling']) => { if (saveReflection(result.id, feeling)) setSavedFeeling(feeling) }
  return <div className="page summary-page"><div className="summary-hero"><span className="eyebrow">WORKOUT COMPLETE</span><h2>训练完成！</h2><p>{result.reps} 次都已经记进你的训练记录。</p><div className="summary-avatar"><AvatarFigure view="front"/></div><div className="xp-earned">+{result.xpEarned} <small>XP</small></div></div><section className="summary-sheet">
    <div className="result-title"><div><small>本次确认次数</small><b>{result.reps}<em> 次</em></b></div><span>{result.rewardTrack === 'rep_count' ? '次数成长' : '心率成长'}</span></div>
    <div className="summary-grid"><div><small>训练时长</small><b>{fmt(result.durationSeconds)}</b></div><div><small>识别 / 手动</small><b>{result.detectedReps} / {result.manualAdjustment > 0 ? '+' : ''}{result.manualAdjustment}</b></div><div><small>平均心率</small><b>{result.averageBpm !== null ? `${result.averageBpm} BPM` : '无数据'}</b></div><div><small>估算消耗</small><b>{result.calorieEstimate.status === 'estimated' ? `约 ${result.calorieEstimate.valueKcal} kcal` : '无法估算'}</b></div></div>
    {result.heartRateSource === 'ble' && <div className="zone-summary">{zones.map((seconds,index)=><div key={index}><span>Zone {index+1}</span><b>{fmt(seconds)}</b></div>)}</div>}
    <p className="estimate-note">{result.calorieEstimate.status === 'estimated' ? result.calorieEstimate.limitation : `消耗未估算：${result.calorieEstimate.unavailableReason || '没有完整数据'}。`}</p>
    <div className="reward-row"><Icon name="spark"/><span><b>成长账本已记录</b><small>{result.rewardEntries.map(entry => entry.kind === 'session_completed' ? `完成 +${entry.amount}` : entry.kind === 'confirmed_reps' ? `确认次数 +${entry.amount}` : `估算消耗 +${entry.amount}`).join(' · ') || '本次没有满足发放条件'}</small></span><em>+{result.xpEarned} XP</em></div>
    <div className="feeling-check"><b>这组做完是什么感觉？</b><small>{state.memory.consent ? '你的回答会保存在这台设备，供下次陪伴时参考。' : '你还没有允许保存陪伴记忆，可在训练准备页开启。'}</small><div>{(Object.keys(feelingLabels) as SavedReflection['feeling'][]).map(feeling => <button disabled={!state.memory.consent} className={savedFeeling === feeling ? 'active' : ''} key={feeling} onClick={() => remember(feeling)}>{feelingLabels[feeling]}</button>)}</div></div>
    <button className="primary" onClick={avatar}>查看我的形象 <Icon name="arrow"/></button><button className="text-btn" onClick={home}>返回首页</button>
  </section>{reward && unlockedItem && <div className="modal-backdrop"><div className="reward-modal"><button className="modal-close" onClick={() => setReward(false)}>×</button><span className="eyebrow">EQUIPMENT UNLOCKED</span><img className="pixel-art reward-equipment-image" src={unlockedItem.image} alt={unlockedItem.name}/><h3>新装备到手</h3><p>{unlockedItem.condition}</p><div className="unlocked-item"><img className="pixel-art unlocked-equipment-image" src={unlockedItem.image} alt={unlockedItem.name}/><div><small>训练成长奖励</small><b>{unlockedItem.name}</b></div><em>{unlockedItem.rarity}</em></div><button className="primary" onClick={() => { setReward(false); avatar() }}>立即去装备</button></div></div>}</div>
}
