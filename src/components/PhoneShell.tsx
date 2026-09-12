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
    <div className="phone">
      <main ref={screenRef} className={`screen ${hideNav ? 'no-nav' : ''}`}>{children}</main>
      {!hideNav && <nav className="bottom-nav">{tabs.map(t => <button key={t.route} className={route === t.route ? 'active' : ''} onClick={() => go(t.route)}><Icon name={t.icon} size={21}/><span>{t.label}</span></button>)}</nav>}
    </div>
  </div>
}
