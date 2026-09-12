import { useEffect, useRef } from 'react'
import type { Route } from '../types'
import { Icon } from './Icons'

const tabs: { route: Route; icon: string; label: string }[] = [
  { route: 'home', icon: 'home', label: '首页' }, { route: 'workout', icon: 'dumbbell', label: '训练' },
  { route: 'avatar', icon: 'user', label: '形象' }, { route: 'inventory', icon: 'bag', label: '背包' },
]

export function PhoneShell({ children, route, go, hideNav = false }: { children: React.ReactNode; route: Route; go: (r: Route) => void; hideNav?: boolean }) {
  const screenRef = useRef<HTMLElement>(null)
  useEffect(() => { screenRef.current?.scrollTo({ top: 0 }) }, [route])
  return <div className="stage">
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <div className="phone">
      <div className="island" />
      <div className="statusbar"><b>9:41</b><span>▮▮▮  ◉  ▰</span></div>
      <main ref={screenRef} className={`screen ${hideNav ? 'no-nav' : ''}`}>{children}</main>
      {!hideNav && <nav className="bottom-nav">{tabs.map(t => <button key={t.route} className={route === t.route ? 'active' : ''} onClick={() => go(t.route)}><Icon name={t.icon} size={21}/><span>{t.label}</span></button>)}</nav>}
      <div className="home-indicator" />
    </div>
    <aside className="desktop-copy"><span className="eyebrow">MOTION BUDDY · 动伴</span><h1>让每一次训练<br/>都看得见成长</h1><p>本地动作计数与心率记录，被转译成经验、装备和一个更懂你的训练伙伴。</p><div className="loop"><span>真实运动</span><i>→</i><span>陪伴记录</span><i>→</i><span>形象成长</span></div></aside>
  </div>
}
