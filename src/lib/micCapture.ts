export type MicCapture = { stop: () => void }

// 3200 个样本 ≈ 200ms（16kHz）
const CHUNK_SAMPLES = 3200

const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(${CHUNK_SAMPLES})
    this.offset = 0
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (input) {
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        this.buffer[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        if (this.offset === this.buffer.length) {
          const chunk = this.buffer.slice(0)
          this.port.postMessage(chunk, [chunk.buffer])
          this.offset = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

/** 开一路单声道麦克风，用 AudioWorklet 采成 16kHz Int16 PCM 逐块回调。 */
export async function startMicCapture(onChunk: (pcm: ArrayBuffer) => void, sampleRate = 16000): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  try {
    const context = new AudioContext({ sampleRate })
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }
    const node = new AudioWorkletNode(context, 'pcm-capture')
    node.port.onmessage = event => onChunk(event.data as ArrayBuffer)
    context.createMediaStreamSource(stream).connect(node)
    return {
      stop: () => {
        node.port.onmessage = null
        node.disconnect()
        stream.getTracks().forEach(track => track.stop())
        void context.close().catch(() => undefined)
      },
    }
  } catch (error) {
    stream.getTracks().forEach(track => track.stop())
    throw error
  }
}
