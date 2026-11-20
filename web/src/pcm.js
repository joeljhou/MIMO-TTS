const SAMPLE_RATE = 24_000

export class PcmPlayback {
  constructor(onEnd) {
    this.context = new AudioContext()
    this.onEnd = onEnd
    this.sources = new Set()
    this.nextStart = 0
    this.paused = false
    this.finished = false
  }

  resume() {
    return this.context.resume()
  }

  togglePause() {
    this.paused = !this.paused
    return this.paused ? this.context.suspend() : this.context.resume()
  }

  append(bytes) {
    const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const buffer = this.context.createBuffer(1, bytes.byteLength / 2, SAMPLE_RATE)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < channel.length; index++) {
      channel[index] = samples.getInt16(index * 2, true) / 32768
    }

    const now = this.context.currentTime
    const start = this.nextStart > now ? this.nextStart : now + 0.03
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      this.finishIfDrained()
    }
    source.start(start)
    this.nextStart = start + buffer.duration
  }

  finish() {
    this.finished = true
    this.finishIfDrained()
  }

  finishIfDrained() {
    if (!this.finished || this.sources.size) return
    this.close()
    this.onEnd()
  }

  close() {
    for (const source of this.sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    if (this.context.state !== 'closed') void this.context.close().catch(() => {})
  }
}

function wavBlob(chunks, length) {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const ascii = new TextEncoder()
  header.set(ascii.encode('RIFF'), 0)
  view.setUint32(4, length + 36, true)
  header.set(ascii.encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  header.set(ascii.encode('data'), 36)
  view.setUint32(40, length, true)
  return new Blob([header, ...chunks], { type: 'audio/wav' })
}

export async function readPcmWav(body, signal, onSamples) {
  if (!body) throw new Error('浏览器未收到音频流。')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let pending = ''
  let length = 0
  let trailingByte = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) throw new Error('音频传输提前结束，请重试。')
      const lines = (pending + decoder.decode(value, { stream: true })).split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.error) throw new Error(frame.error)
        if (frame.done) {
          if (!length || trailingByte !== null) throw new Error('收到的 PCM 音频不完整，请重试。')
          return wavBlob(chunks, length)
        }
        let bytes = Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0))
        if (trailingByte !== null) {
          const joined = new Uint8Array(bytes.length + 1)
          joined[0] = trailingByte
          joined.set(bytes, 1)
          bytes = joined
        }
        trailingByte = bytes.length % 2 ? bytes[bytes.length - 1] : null
        const aligned = bytes.subarray(0, bytes.length - bytes.length % 2)
        if (!aligned.length) continue
        length += aligned.length
        chunks.push(aligned)
        onSamples(aligned)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
