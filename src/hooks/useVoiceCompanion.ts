import { useCallback, useEffect, useRef, useState } from 'react'
import { chooseRecognitionText, containsWakePhrase, interpretVoiceCommand, type VoiceCommand } from '../lib/voiceCommands'
import { streamCompanionSpeech } from '../services/companionApi'

export type VoiceState = 'off' | 'wake-listening' | 'awake' | 'thinking' | 'speaking' | 'error'
type UtteranceHandler = (command: VoiceCommand) => Promise<string | null>

export function useVoiceCompanion(onUtterance: UtteranceHandler) {
  const [voiceState, setVoiceState] = useState<VoiceState>('off')
  const [listening, setListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [lastHeard, setLastHeard] = useState('')
  const [lastReply, setLastReply] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [playbackReady, setPlaybackReady] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const restartTimerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioSettleRef = useRef<(() => void) | null>(null)
  const speechCacheRef = useRef(new Map<string, Promise<Blob>>())
  const enabledRef = useRef(false)
  const awakeRef = useRef(false)
  const turnBusyRef = useRef(false)
  const pauseForTurnRef = useRef(false)
  const speakingRef = useRef(false)
  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  const supported = Boolean(Recognition)

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current)
    restartTimerRef.current = null
  }, [])

  const releaseAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = null
  }, [])

  const pauseRecognition = useCallback(() => {
    clearRestartTimer()
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onend = null
      try { recognition.abort() } catch { /* recognition already stopped */ }
    }
    setListening(false)
  }, [clearRestartTimer])

  const startRecognitionRef = useRef<() => void>(() => undefined)
  const scheduleRestart = useCallback(() => {
    clearRestartTimer()
    if (!enabledRef.current || pauseForTurnRef.current || speakingRef.current) return
    restartTimerRef.current = window.setTimeout(() => startRecognitionRef.current(), 220)
  }, [clearRestartTimer])

  const resumeListening = useCallback(() => {
    pauseForTurnRef.current = false
    speakingRef.current = false
    turnBusyRef.current = false
    if (!enabledRef.current) {
      setVoiceState('off')
      return
    }
    setVoiceState(awakeRef.current ? 'awake' : 'wake-listening')
    scheduleRestart()
  }, [scheduleRestart])

  const getSpeechBlob = useCallback((text: string) => {
    const cached = speechCacheRef.current.get(text)
    if (cached) return cached
    const pending = streamCompanionSpeech(text)
      .then(response => response.blob())
      .catch(error => {
        speechCacheRef.current.delete(text)
        throw error
      })
    speechCacheRef.current.set(text, pending)
    if (speechCacheRef.current.size > 4) {
      const oldest = speechCacheRef.current.keys().next().value
      if (oldest) speechCacheRef.current.delete(oldest)
    }
    return pending
  }, [])

  const primeSpeech = useCallback((text: string, assetUrl?: string) => {
    if (!assetUrl || speechCacheRef.current.has(text)) {
      void getSpeechBlob(text).catch(() => undefined)
      return
    }
    const pending = fetch(assetUrl)
      .then(response => {
        if (!response.ok) throw new Error('本地唤醒语音加载失败')
        return response.blob()
      })
      .catch(error => {
        speechCacheRef.current.delete(text)
        throw error
      })
    speechCacheRef.current.set(text, pending)
    void pending.catch(() => undefined)
  }, [getSpeechBlob])

  const playSpeechBlob = useCallback(async (blob: Blob) => {
    audioRef.current?.pause()
    audioSettleRef.current?.()
    releaseAudioUrl()
    const audio = new Audio()
    audioRef.current = audio
    const url = URL.createObjectURL(blob)
    audioUrlRef.current = url
    audio.src = url

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        audioSettleRef.current = null
        releaseAudioUrl()
        resolve()
      }
      const fail = () => {
        if (settled) return
        settled = true
        audioSettleRef.current = null
        releaseAudioUrl()
        reject(new Error('语音播放失败'))
      }
      audioSettleRef.current = finish
      audio.onended = finish
      audio.onerror = fail
      void audio.play().catch(() => {
        setPlaybackReady(true)
        setVoiceError('浏览器拦截了自动播放，点一下播放后我会继续听')
      })
    })
  }, [releaseAudioUrl])

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { resumeListening(); return }
    pauseForTurnRef.current = true
    speakingRef.current = true
    pauseRecognition()
    setVoiceState('speaking')
    setLastReply(text)
    setPlaybackReady(false)
    try {
      const blob = await getSpeechBlob(text)
      await playSpeechBlob(blob)
      resumeListening()
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '语音输出暂时不可用')
      setVoiceState('error')
      resumeListening()
    }
  }, [getSpeechBlob, pauseRecognition, playSpeechBlob, resumeListening])

  const handleFinalText = useCallback(async (text: string) => {
    if (turnBusyRef.current) return
    const command = interpretVoiceCommand(text, awakeRef.current)
    if (command.intent === 'ignore') return
    setLastHeard(text)
    setInterimText('')

    if (command.intent === 'disable') {
      enabledRef.current = false
      awakeRef.current = false
      pauseForTurnRef.current = true
      pauseRecognition()
      setVoiceState('off')
      return
    }
    if (command.intent === 'sleep') {
      awakeRef.current = false
      setVoiceState('wake-listening')
      return
    }

    awakeRef.current = command.nextAwake
    turnBusyRef.current = true
    pauseForTurnRef.current = true
    pauseRecognition()
    setVoiceState('thinking')
    try {
      const reply = await onUtteranceRef.current(command)
      if (reply) await speak(reply)
      else resumeListening()
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '动伴暂时没有连上服务')
      setVoiceState('error')
      resumeListening()
    }
  }, [pauseRecognition, resumeListening, speak])

  const startRecognition = useCallback(() => {
    if (!Recognition || !enabledRef.current || pauseForTurnRef.current || speakingRef.current || recognitionRef.current) return
    clearRestartTimer()
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 5
    recognition.onstart = () => {
      setListening(true)
      setVoiceError(null)
      setVoiceState(awakeRef.current ? 'awake' : 'wake-listening')
    }
    recognition.onresult = event => {
      let interim = ''
      let final = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const alternatives = Array.from({ length: result.length }, (_, alternativeIndex) => result[alternativeIndex]?.transcript || '')
        const transcript = chooseRecognitionText(alternatives, awakeRef.current)
        if (event.results[index].isFinal) final += transcript
        else interim += transcript
      }
      setInterimText(interim)
      if (interim && !awakeRef.current && containsWakePhrase(interim)) {
        awakeRef.current = true
        setVoiceState('awake')
      }
      if (final.trim()) void handleFinalText(final.trim())
    }
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        enabledRef.current = false
        awakeRef.current = false
        setVoiceError('麦克风权限没有开启')
        setVoiceState('error')
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        setVoiceError(`语音识别中断：${event.error}`)
      }
    }
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      setListening(false)
      scheduleRestart()
    }
    recognitionRef.current = recognition
    try { recognition.start() }
    catch {
      recognitionRef.current = null
      scheduleRestart()
    }
  }, [Recognition, clearRestartTimer, handleFinalText, scheduleRestart])
  startRecognitionRef.current = startRecognition

  const enable = useCallback(() => {
    if (!Recognition) {
      setVoiceError('当前浏览器不支持持续语音识别，请使用最新版 Chrome')
      setVoiceState('error')
      return
    }
    enabledRef.current = true
    awakeRef.current = false
    pauseForTurnRef.current = false
    speakingRef.current = false
    turnBusyRef.current = false
    setVoiceError(null)
    setVoiceState('wake-listening')
    startRecognitionRef.current()
  }, [Recognition])

  const disable = useCallback(() => {
    enabledRef.current = false
    awakeRef.current = false
    turnBusyRef.current = false
    pauseForTurnRef.current = true
    speakingRef.current = false
    clearRestartTimer()
    pauseRecognition()
    audioRef.current?.pause()
    audioSettleRef.current?.()
    releaseAudioUrl()
    setPlaybackReady(false)
    setInterimText('')
    setVoiceState('off')
  }, [clearRestartTimer, pauseRecognition, releaseAudioUrl])

  const replay = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    try {
      setVoiceError(null)
      setPlaybackReady(false)
      setVoiceState('speaking')
      await audio.play()
    } catch {
      setVoiceError('浏览器没有允许播放声音')
      setPlaybackReady(true)
    }
  }, [])

  useEffect(() => () => disable(), [disable])

  return {
    supported, voiceState, listening, interimText, lastHeard, lastReply,
    voiceError, playbackReady, enable, disable, speak, replay, primeSpeech,
  }
}
