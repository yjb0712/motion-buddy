import { useCallback, useEffect, useRef, useState } from 'react'
import { chooseRecognitionText, containsWakePhrase, interpretVoiceCommand, type VoiceCommand } from '../lib/voiceCommands'
import { createRealtimeAsr, type RealtimeAsr } from '../lib/realtimeAsr'
import { decodeAudioBase64, streamCompanionSpeech, type TurnEvent } from '../services/companionApi'
import { useBargeInDetector } from './useBargeInDetector'

export type VoiceState = 'off' | 'wake-listening' | 'awake' | 'thinking' | 'speaking' | 'error'

export type TurnResult =
  | { kind: 'text'; text: string }
  | { kind: 'stream'; run: (onEvent: (event: TurnEvent) => void, signal: AbortSignal) => Promise<void> }

type UtteranceHandler = (command: VoiceCommand) => Promise<TurnResult | null>

export function useVoiceCompanion(onUtterance: UtteranceHandler) {
  const [voiceState, setVoiceState] = useState<VoiceState>('off')
  const [listening, setListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [lastHeard, setLastHeard] = useState('')
  const [lastReply, setLastReply] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [playbackReady, setPlaybackReady] = useState(false)
  const asrRef = useRef<{ recognition?: SpeechRecognition; stop: () => void } | null>(null)
  const realtimeRef = useRef<RealtimeAsr | null>(null)
  const realtimeBrokenRef = useRef(false)
  const handleFinalTextRef = useRef<(text: string) => void>(() => undefined)
  const restartTimerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioSettleRef = useRef<(() => void) | null>(null)
  const streamStopRef = useRef<(() => void) | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
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
    const session = asrRef.current
    asrRef.current = null
    session?.stop()
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

  const handleBargeIn = useCallback(() => {
    if (!speakingRef.current) return
    speakingRef.current = false
    turnBusyRef.current = false
    awakeRef.current = true
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    streamStopRef.current?.()
    audioRef.current?.pause()
    audioSettleRef.current?.()
    releaseAudioUrl()
    setInterimText('')
    resumeListening()
  }, [releaseAudioUrl, resumeListening])
  const bargeIn = useBargeInDetector(handleBargeIn)

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { resumeListening(); return }
    pauseForTurnRef.current = true
    speakingRef.current = true
    pauseRecognition()
    setVoiceState('speaking')
    setLastReply(text)
    setPlaybackReady(false)
    bargeIn.start()
    try {
      const blob = await getSpeechBlob(text)
      await playSpeechBlob(blob)
      bargeIn.stop()
      resumeListening()
    } catch (error) {
      bargeIn.stop()
      setVoiceError(error instanceof Error ? error.message : '语音输出暂时不可用')
      setVoiceState('error')
      resumeListening()
    }
  }, [bargeIn, getSpeechBlob, pauseRecognition, playSpeechBlob, resumeListening])

  const speakStream = useCallback(async (run: (onEvent: (event: TurnEvent) => void, signal: AbortSignal) => Promise<void>) => {
    pauseForTurnRef.current = true
    speakingRef.current = true
    pauseRecognition()
    setVoiceState('speaking')
    setLastReply('')
    setPlaybackReady(false)
    bargeIn.start()
    const controller = new AbortController()
    streamAbortRef.current = controller

    const urls: string[] = []
    const audios: HTMLAudioElement[] = []
    let nextIndex = 0
    let playing = false
    let streamDone = false
    let finished = false
    let settle: () => void = () => undefined
    const done = new Promise<void>(resolve => { settle = resolve })

    const stopAll = () => {
      if (finished) return
      finished = true
      bargeIn.stop()
      controller.abort()
      if (streamAbortRef.current === controller) streamAbortRef.current = null
      audios.forEach(audio => {
        audio.onended = null
        audio.onerror = null
        try { audio.pause() } catch { /* already stopped */ }
      })
      urls.forEach(url => URL.revokeObjectURL(url))
      streamStopRef.current = null
      settle()
    }
    streamStopRef.current = stopAll

    const playNext = async () => {
      if (playing || finished) return
      const audio = audios[nextIndex]
      if (!audio) {
        if (streamDone) stopAll()
        return
      }
      playing = true
      nextIndex += 1
      audioRef.current = audio
      const played = new Promise<void>(resolve => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
      })
      try { await audio.play() } catch {
        playing = false
        setPlaybackReady(true)
        setVoiceError('浏览器拦截了自动播放，点一下播放后我会继续听')
        return
      }
      await played
      playing = false
      void playNext()
    }

    const onEvent = (event: TurnEvent) => {
      if (finished) return
      if (event.type === 'sentence') setLastReply(previous => previous + event.text)
      else if (event.type === 'audio') {
        const url = URL.createObjectURL(decodeAudioBase64(event.mp3))
        urls.push(url)
        const audio = new Audio(url)
        audios.push(audio)
        void playNext()
      }
    }

    try {
      await run(onEvent, controller.signal)
      streamDone = true
      if (!playing) void playNext()
    } catch (error) {
      if (controller.signal.aborted) return
      if (nextIndex === 0 && !playing) {
        stopAll()
        setVoiceError(error instanceof Error ? error.message : '动伴暂时没有连上服务')
        setVoiceState('error')
        resumeListening()
        return
      }
      streamDone = true
      if (!playing) stopAll()
    }
    await done
    bargeIn.stop()
    resumeListening()
  }, [bargeIn, pauseRecognition, resumeListening])

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
      const result = await onUtteranceRef.current(command)
      if (!result) resumeListening()
      else if (result.kind === 'text') await speak(result.text)
      else await speakStream(result.run)
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '动伴暂时没有连上服务')
      setVoiceState('error')
      resumeListening()
    }
  }, [pauseRecognition, resumeListening, speak, speakStream])
  handleFinalTextRef.current = handleFinalText

  const startBrowserRecognition = useCallback(() => {
    if (asrRef.current) return
    if (!Recognition) {
      setVoiceError('当前浏览器不支持持续语音识别，请使用最新版 Chrome')
      setVoiceState('error')
      return
    }
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
      setListening(false)
      if (asrRef.current?.recognition === recognition) {
        asrRef.current = null
        scheduleRestart()
      }
    }
    asrRef.current = {
      recognition,
      stop: () => {
        recognition.onend = null
        try { recognition.abort() } catch { /* already stopped */ }
      },
    }
    try { recognition.start() }
    catch {
      asrRef.current = null
      scheduleRestart()
    }
  }, [Recognition, clearRestartTimer, handleFinalText, scheduleRestart])

  const getRealtimeAsr = useCallback(() => {
    if (realtimeBrokenRef.current) return null
    if (!realtimeRef.current) {
      realtimeRef.current = createRealtimeAsr({
        onPartial: text => {
          setInterimText(text)
          if (!awakeRef.current && containsWakePhrase(text)) {
            awakeRef.current = true
            setVoiceState('awake')
          }
        },
        onFinal: text => handleFinalTextRef.current(text),
        onError: () => {
          realtimeBrokenRef.current = true
          scheduleRestart()
        },
      })
    }
    return realtimeRef.current
  }, [scheduleRestart])

  const startRecognition = useCallback(() => {
    if (!enabledRef.current || pauseForTurnRef.current || speakingRef.current || asrRef.current) return
    clearRestartTimer()
    const realtime = getRealtimeAsr()
    if (realtime) {
      setListening(true)
      setVoiceError(null)
      setVoiceState(awakeRef.current ? 'awake' : 'wake-listening')
      void realtime.start().catch(() => {
        realtimeBrokenRef.current = true
        realtimeRef.current?.close()
        realtimeRef.current = null
        startBrowserRecognition()
      })
      return
    }
    startBrowserRecognition()
  }, [clearRestartTimer, getRealtimeAsr, startBrowserRecognition])
  startRecognitionRef.current = startRecognition

  const enable = useCallback(() => {
    if (!Recognition && !getRealtimeAsr()) {
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
  }, [Recognition, getRealtimeAsr])

  const disable = useCallback(() => {
    enabledRef.current = false
    awakeRef.current = false
    turnBusyRef.current = false
    pauseForTurnRef.current = true
    speakingRef.current = false
    clearRestartTimer()
    pauseRecognition()
    bargeIn.stop()
    streamStopRef.current?.()
    realtimeRef.current?.pause()
    audioRef.current?.pause()
    audioSettleRef.current?.()
    releaseAudioUrl()
    setPlaybackReady(false)
    setInterimText('')
    setVoiceState('off')
  }, [bargeIn, clearRestartTimer, pauseRecognition, releaseAudioUrl])

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
