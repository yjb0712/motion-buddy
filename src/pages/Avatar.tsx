import { useState } from 'react'
import { AvatarFigure } from '../components/AvatarFigure'
import { Header } from '../components/Header'
import { Icon } from '../components/Icons'
import { useStore } from '../lib/store'
import type { Slot } from '../types'

const slots: { key: Slot; label: string }[] = [
  { key: 'head', label: '头部' },
  { key: 'top', label: '上衣' },
  { key: 'bottom', label: '下装' },
  { key: 'shoes', label: '鞋子' },
  { key: 'gloves', label: '手套' },
  { key: 'prop', label: '道具' },
  { key: 'badge', label: '勋章' },
  { key: 'effect', label: '特效' },
]

export function Avatar({ inventory }: { inventory: () => void }) {
  const { state } = useStore()
  const [tab, setTab] = useState<'equip' | 'history'>('equip')
  const activeMinutes = Math.round(state.history.reduce((sum, session) => sum + session.zone1Seconds + session.zone2Seconds + session.zone3Seconds + session.zone4Seconds + session.zone5Seconds, 0) / 60)
  const estimatedCalories = Math.round(state.history.reduce((sum, session) => sum + (session.calorieEstimate.valueKcal || 0), 0))
  const facts: Array<[string, string]> = [
    ['训练', `${state.workouts} 次`],
    ['深蹲', `${state.totalSquats} 次`],
    ['心率记录', `${activeMinutes} 分钟`],
    ['估算消耗', `约 ${estimatedCalories} kcal`],
    ['连续训练', `${state.streakDays} 天`],
  ]

  return <div className="page avatar-page">
    <Header title="我的形象"/>
    <div className="avatar-showcase">
      <div className="speech small">每一次训练<br/>都在变强！</div>
      <AvatarFigure view="front"/>
      <b>{state.nickname}</b>
      <div className="level-row"><span>Lv.{state.level}</span><div className="progress"><i style={{ width: `${state.xp / 10}%` }}/></div><small>{state.xp}/1000 XP</small></div>
    </div>
    <div className="segmented"><button className={tab === 'equip' ? 'active' : ''} onClick={() => setTab('equip')}>装备</button><button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>训练事实</button></div>
    {tab === 'equip' ? <>
      <div className="slot-grid">{slots.map(slot => {
        const item = state.equipment.find(equipment => equipment.id === state.equipped[slot.key])
        return <button key={slot.key} onClick={inventory} className={item ? 'filled' : ''}>
          {item ? <img className="pixel-art slot-image" src={item.image} alt={item.name}/> : <span className="slot-empty">暂无素材</span>}
          <b>{slot.label}</b><small>{item?.name || '未装备'}</small>
        </button>
      })}</div>
      <button className="primary inventory-cta" onClick={inventory}><Icon name="bag"/>更换装备</button>
    </> : <div className="facts-list">{facts.map(([name, value]) => <div key={name}><span>{name}</span><b>{value}</b></div>)}<p>这些数字来自已保存的训练记录；消耗值是心率公式估算，不代表精确能量测量。</p></div>}
  </div>
}
