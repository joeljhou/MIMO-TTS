const SAMPLE_RATE = 24_000
const START_BUFFER_FRAMES = SAMPLE_RATE
const STREAM_RATE_MARGIN = 1.15
const START_LEAD_FRAMES = 720
const MIN_LEAD_FRAMES = 256

export class PcmPlayback {
  constructor(onEnd) {
    // Match the PCM so the output device resamples the mixed stream, not each chunk.
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.onEnd = onEnd
    this.sources = new Set()
    this.buffered = []
    this.bufferedFrames = 0
    this.firstChunkTime = null
    this.nextFrame = null
    this.waitForFinish = this.context.sampleRate !== SAMPLE_RATE
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
    const time = performance.now()
    this.firstChunkTime ??= time
    // Estimate the arrival rate before counting the chunk that just arrived.
    const expectedFrames = (time - this.firstChunkTime) / 1000 * SAMPLE_RATE * STREAM_RATE_MARGIN
    const canStream = this.bufferedFrames >= expectedFrames
    this.buffered.push(bytes)
    this.bufferedFrames += bytes.byteLength / 2

    if (this.waitForFinish) return false
    if (this.nextFrame === null) {
      if (this.bufferedFrames < START_BUFFER_FRAMES || !canStream) return false
    } else if (this.nextFrame - this.context.currentTime * SAMPLE_RATE < MIN_LEAD_FRAMES) {
      // Once playback catches up to the stream, wait for the remaining audio.
      this.waitForFinish = true
      this.nextFrame = null
      return false
    }
    this.scheduleBuffered()
    return true
  }

  scheduleBuffered() {
    if (!this.bufferedFrames) return
    const buffer = this.context.createBuffer(1, this.bufferedFrames, SAMPLE_RATE)
    const channel = buffer.getChannelData(0)
    let offset = 0
    for (const bytes of this.buffered) {
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < bytes.byteLength; index += 2) {
        channel[offset++] = samples.getInt16(index, true) / 32768
      }
    }
    this.buffered = []
    this.bufferedFrames = 0

    const startFrame = this.nextFrame ?? Math.ceil(this.context.currentTime * SAMPLE_RATE) + START_LEAD_FRAMES
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      this.finishIfDrained()
    }
    source.start(startFrame / SAMPLE_RATE)
    this.nextFrame = startFrame + buffer.length
  }

  finish() {
    this.finished = true
    this.scheduleBuffered()
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
    this.buffered = []
    this.bufferedFrames = 0
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
