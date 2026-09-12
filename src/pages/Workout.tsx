import { useState } from 'react'
import { Header } from '../components/Header'
import { Icon } from '../components/Icons'
import { PoseCanvas } from '../components/PoseCanvas'
import { useHeartRateMonitor } from '../hooks/useHeartRateMonitor'
import { usePose } from '../hooks/usePose'
import { useSquatMetrics } from '../hooks/useSquatMetrics'
import { useWorkoutSession } from '../hooks/useWorkoutSession'
import { useVoiceCompanion, type TurnResult, type VoiceState } from '../hooks/useVoiceCompanion'
import { useStore } from '../lib/store'
import { askCompanionAboutFrame, streamCompanionTurn } from '../services/companionApi'
import type { VoiceCommand } from '../lib/voiceCommands'
import type { RewardTrack, WorkoutSession } from '../types'

const voiceStatus: Record<VoiceState, { title: string; hint: string }> = {
  off: { title: '麦克风已关闭', hint: '点麦克风重新开启' },
  'wake-listening': { title: '动伴在线', hint: '说“你好动伴”叫我' },
  awake: { title: '我在听', hint: '直接说就好' },
  thinking: { title: '我在想', hint: '马上回答你' },
  speaking: { title: '动伴正在说话', hint: '开口说话就能打断我' },
  error: { title: '语音暂时中断', hint: '检查权限后点麦克风重试' },
}
const WAKE_REPLY = '我在呢，你说。'
const compactSpeech = (text: string) => text.replace(/[，。！？、,.!?\s]/g, '')

export function Workout({ back, finish }: { back: () => void; finish: (session: WorkoutSession) => void }) {
  const { state, updateProfile, updateMemory } = useStore()
  const [active, setActive] = useState(false)
  const [simulatedPose, setSimulatedPose] = useState(false)
  const [showTips, setShowTips] = useState(false)
  const [rewardTrack, setRewardTrack] = useState<RewardTrack>('rep_count')
  const pose = usePose(active && !simulatedPose)
  const heartRate = useHeartRateMonitor(state.age)
  const counter = useSquatMetrics(pose.landmarks, simulatedPose, active, 20)
  const { metrics, adjustReps } = counter
  const workout = useWorkoutSession(metrics, heartRate, active, false, rewardTrack, { age: state.age, weightKg: state.weightKg, gender: state.gender })
  const session = workout.session

  const captureCurrentFrame = () => {
    const video = pose.videoRef.current
    if (!video || video.readyState < 2) return null
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 360 / Math.max(1, video.videoWidth))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', .68)
  }

  const handleVoiceUtterance = async (command: VoiceCommand): Promise<TurnResult> => {
    if (command.intent === 'vision') {
      if (simulatedPose) return { kind: 'text', text: '现在是次数演示，没有真实摄像头画面。开始摄像头陪练后再叫我看。' }
      const image = captureCurrentFrame()
      if (!image) return { kind: 'text', text: '我现在还没拿到清楚的摄像头画面，你站好后再叫我看一次。' }
      const response = await askCompanionAboutFrame(
        state,
        session?.id || 'pre-session',
        `${command.text}\n只描述当前画面、机位和能否看清关键身体部位。用户没有要求时，不评价动作对错。`,
        'training',
        image,
      )
      return { kind: 'text', text: response.reply }
    }
    if (command.wokeNow && compactSpeech(command.text).length <= 5) return { kind: 'text', text: WAKE_REPLY }
    return {
      kind: 'stream',
      run: (onEvent, signal) => streamCompanionTurn(state, session?.id || 'pre-session', command.text, 'training', onEvent, signal),
    }
  }

  const voice = useVoiceCompanion(handleVoiceUtterance)
  const canStartHeartRate = rewardTrack !== 'heart_rate' || (Boolean(state.weightKg) && heartRate.connected)

  const startRealPose = () => {
    if (!canStartHeartRate) return
    setSimulatedPose(false)
    setActive(true)
    voice.enable()
    if (voice.supported) voice.primeSpeech(WAKE_REPLY, '/audio/wake-serena.mp3')
    window.setTimeout(() => { void pose.start() }, 30)
  }
  const startDemo = () => {
    setRewardTrack('rep_count')
    setSimulatedPose(true)
    setActive(true)
    voice.enable()
    if (voice.supported) voice.primeSpeech(WAKE_REPLY, '/audio/wake-serena.mp3')
  }
  const leaveWorkout = () => { voice.disable(); back() }
  const done = () => {
    voice.disable()
    const completed = workout.finish()
    if (completed) finish(completed)
  }

  if (!active) return <div className="page workout-page setup">
    <Header title="深蹲 SQUAT" back={back}/>
    <div className="setup-visual"><div className="scan-ring"><Icon name="spark" size={42}/></div><span className="eyebrow">准备训练</span><h2>今天想怎么记录？</h2><p>开始后画面会铺满屏幕，麦克风保持在线。说“你好动伴”就能叫我。</p></div>
    <div className="reward-track" role="group" aria-label="成长记录方式">
      <button className={rewardTrack === 'rep_count' ? 'active' : ''} onClick={() => setRewardTrack('rep_count')}><b>次数成长</b><small>按确认后的深蹲次数获得 XP</small></button>
      <button className={rewardTrack === 'heart_rate' ? 'active' : ''} onClick={() => setRewardTrack('heart_rate')}><b>心率成长</b><small>按 BLE 心率估算消耗获得 XP</small></button>
    </div>
    <button className="primary" disabled={!canStartHeartRate} onClick={startRealPose}><span>📷</span> 开始视频陪练</button>
    <button className="secondary" onClick={startDemo}><Icon name="play"/> 使用次数演示</button>
    <p className="permission-note">开始时会请求摄像头和麦克风权限；训练页会一直显示麦克风状态。</p>
    <button className="text-btn tips-toggle" onClick={() => setShowTips(value => !value)}>{showTips ? '收起动作要领' : '我想先看动作要领'}</button>
    {showTips && <div className="requested-tips"><b>深蹲记住三件事</b><p>双脚踩稳；屁股和膝盖一起往下；起身时把地面踩开。做到自己舒服的深度，不舒服就停。</p></div>}
    <div className="profile-strip"><label>年龄<input type="number" min="12" max="90" value={state.age} onChange={event => updateProfile({ age: Number(event.target.value) || 24 })}/></label><label>体重 kg<input type="number" min="25" max="250" placeholder="心率估算需要" value={state.weightKg ?? ''} onChange={event => updateProfile({ weightKg: event.target.value ? Number(event.target.value) : null })}/></label></div>
    <div className="ble-setup"><div><Icon name="bluetooth"/><span><b>{heartRate.deviceName || 'BLE 心率带'}</b><small>{heartRate.status === 'unsupported' ? '当前浏览器不支持 Web Bluetooth' : heartRate.connected && heartRate.signalInterrupted ? '心率信号中断' : heartRate.connected && !heartRate.lastPacketAt ? '等待心率数据…' : heartRate.connected ? `${heartRate.currentBpm || '--'} BPM · Zone ${heartRate.currentZone || '--'}` : heartRate.status === 'disconnected' ? '心率带已断开' : heartRate.errorMessage || '标准 0x180D / 0x2A37'}</small></span></div><button disabled={heartRate.status === 'connecting' || heartRate.status === 'unsupported' || heartRate.connected} onClick={heartRate.connect}>{heartRate.status === 'connecting' ? '正在连接…' : heartRate.connected ? '已连接' : '连接心率带'}</button></div>
    {rewardTrack === 'heart_rate' && !canStartHeartRate && <p className="setup-warning">心率成长需要先填写体重并连接心率带；数据不齐时不发这部分奖励。</p>}
    <details className="memory-settings"><summary>陪伴记忆设置</summary><label><input type="checkbox" checked={state.memory.consent} onChange={event => updateMemory({ consent: event.target.checked })}/>允许在这台设备保存我的称呼、偏好和训练感受</label>{state.memory.consent && <div><input aria-label="希望怎么称呼你" placeholder="希望怎么称呼你" value={state.memory.preferredAddress} onChange={event => updateMemory({ preferredAddress: event.target.value })}/><select aria-label="鼓励风格" value={state.memory.encouragementStyle} onChange={event => updateMemory({ encouragementStyle: event.target.value as typeof state.memory.encouragementStyle })}><option value="quiet">少说一点</option><option value="warm">温和陪伴</option><option value="energetic">热情一点</option></select></div>}</details>
  </div>

  const status = voiceStatus[voice.voiceState]
  const transcript = voice.interimText || (voice.voiceState === 'thinking' ? voice.lastHeard : voice.lastReply)
  const cameraNotice = !simulatedPose && pose.status !== 'ready'
    ? pose.status === 'loading' ? '正在准备本地计数…' : pose.status === 'denied' ? '摄像头权限没有开启' : pose.status === 'error' ? '本地计数模型加载失败' : '正在打开摄像头…'
    : null

  return <div className={`workout-call voice-${voice.voiceState}`}>
    <PoseCanvas videoRef={pose.videoRef} demo={simulatedPose}/>
    <div className="call-shade"/>
    <header className="call-topbar">
      <button className="call-icon-button" onClick={leaveWorkout} aria-label="返回"><Icon name="back"/></button>
      <div className="call-identity"><b>动伴陪练</b><span><i/>{simulatedPose ? '演示计数中' : '本地计数中'}</span></div>
      <button className={`mic-status ${voice.listening ? 'online' : ''}`} onClick={voice.voiceState === 'off' || voice.voiceState === 'error' ? voice.enable : voice.disable} aria-label={voice.voiceState === 'off' ? '打开麦克风' : '关闭麦克风'}>
        <span>{voice.voiceState === 'off' || voice.voiceState === 'error' ? '麦克风关' : '麦克风开'}</span>
      </button>
    </header>

    <section className="rep-overlay" aria-label={`已完成 ${metrics.reps} 次`}>
      <small>已完成</small><div><b>{metrics.reps}</b><span>/ {metrics.targetReps} 次</span></div>
    </section>

    {cameraNotice && <div className="camera-notice">{cameraNotice}</div>}

    <section className="voice-overlay" aria-live="polite">
      <div className={`voice-orb ${voice.listening ? 'hearing' : ''}`}><span/><span/><span/></div>
      <div className="voice-copy"><b>{status.title}</b><small>{status.hint}</small></div>
      {transcript && <p className="voice-transcript">{transcript}</p>}
      {voice.voiceError && <p className="call-error">{voice.voiceError}</p>}
      {voice.playbackReady && <button className="call-play-reply" onClick={voice.replay}>▶ 播放动伴回复</button>}
    </section>

    <footer className="call-controls">
      <div className="rep-adjust" aria-label="手动修正次数">
        <button onClick={() => adjustReps(-1)} disabled={metrics.reps <= 0} aria-label="少记一次">−</button>
        <span>修正次数</span>
        <button onClick={() => adjustReps(1)} aria-label="多记一次">＋</button>
      </div>
      <button className={`call-mic ${voice.voiceState !== 'off' && voice.voiceState !== 'error' ? 'active' : ''}`} onClick={voice.voiceState === 'off' || voice.voiceState === 'error' ? voice.enable : voice.disable} aria-label={voice.voiceState === 'off' ? '打开麦克风' : '关闭麦克风'}>🎙</button>
      <button className="finish-call" onClick={done}><Icon name="check" size={19}/> 完成本组</button>
    </footer>
  </div>
}
