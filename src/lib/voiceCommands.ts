export type VoiceIntent = 'ignore' | 'chat' | 'vision' | 'sleep' | 'disable'

export type VoiceCommand = {
  intent: VoiceIntent
  text: string
  nextAwake: boolean
  wokeNow: boolean
}

const compact = (text: string) => text.trim().replace(/[，。！？、,.!?\s]/g, '')

const editDistance = (left: string, right: string) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = previous
    }
  }
  return row[right.length]
}

export function containsWakePhrase(text: string) {
  const normalized = compact(text)
  if (['你号动伴', '您好动伴', '哈喽动伴'].some(alias => normalized.includes(alias))) return true
  if (normalized.includes('动伴你好')) return true
  const greetingAt = normalized.indexOf('你好')
  if (greetingAt < 0) return false
  const candidate = normalized.slice(greetingAt, greetingAt + 4)
  return candidate.length === 4 && editDistance(candidate, '你好动伴') <= 1
}

export function chooseRecognitionText(alternatives: string[], awake: boolean) {
  return alternatives.find(text => interpretVoiceCommand(text, awake).intent !== 'ignore') || alternatives[0] || ''
}

export function interpretVoiceCommand(rawText: string, awake: boolean): VoiceCommand {
  const text = rawText.trim()
  const normalized = compact(text)
  if (!normalized) return { intent: 'ignore', text: '', nextAwake: awake, wokeNow: false }

  if (normalized.includes('关闭麦克风') || normalized.includes('关掉麦克风')) {
    return { intent: 'disable', text, nextAwake: false, wokeNow: false }
  }

  if (awake && (normalized.includes('结束对话') || normalized.includes('先别听了') || normalized.includes('停止对话'))) {
    return { intent: 'sleep', text, nextAwake: false, wokeNow: false }
  }

  const wokeNow = containsWakePhrase(text)
  if (!awake && !wokeNow) return { intent: 'ignore', text, nextAwake: false, wokeNow: false }

  const isVision = normalized.includes('看看画面') || normalized.includes('看下画面') || normalized.includes('看一下画面')
  return { intent: isVision ? 'vision' : 'chat', text, nextAwake: true, wokeNow }
}
