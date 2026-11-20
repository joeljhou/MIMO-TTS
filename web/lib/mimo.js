import { once } from 'node:events'

const MIMO_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
const DEFAULT_MODEL = 'mimo-v2.5-tts'
const DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const MODELS = new Set([DEFAULT_MODEL, DESIGN_MODEL, CLONE_MODEL])
const VOICES = new Set(['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default'])
const MAX_REFERENCE_BASE64 = 4_400_000

function inputError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

export function buildPayload(fields, test = false, stream = false) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw inputError('请求格式无效。')
  const model = fields.model || DEFAULT_MODEL
  const text = test ? '你好，这是一次语音连接测试。' : String(fields.text || '').trim()
  const style = String(fields.style || '').trim()
  const description = String(fields.description || '').trim()
  const voice = fields.voice || '冰糖'
  const reference = String(fields.reference || '')

  if (!MODELS.has(model) || text.length < 1 || text.length > 100 || style.length > 200 || description.length > 300) {
    throw inputError('请检查模型及文本长度。')
  }
  if (stream && model !== DEFAULT_MODEL) {
    throw inputError('低延迟流式播放仅支持预置音色模型。')
  }

  let instruction = style
  const audio = { format: stream ? 'pcm16' : 'wav' }
  if (model === DESIGN_MODEL) {
    if (!description && !test) throw inputError('请先填写音色描述。')
    instruction = description || '清晰自然的普通话声音，语速适中。'
    if (style) instruction += '\n朗读要求：' + style
    audio.optimize_text_preview = false
  } else if (model === CLONE_MODEL) {
    const comma = reference.indexOf(',')
    const encoded = reference.slice(comma + 1)
    const prefix = reference.slice(0, comma)
    if (comma === -1 || !['data:audio/mpeg;base64', 'data:audio/wav;base64'].includes(prefix) || !encoded || encoded.length > MAX_REFERENCE_BASE64) {
      throw inputError('请上传 MP3 或 WAV 参考音频，文件最大 3.3 MB。')
    }
    if (Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw inputError('参考音频编码无效，请重新上传。')
    audio.voice = reference
  } else {
    if (!VOICES.has(voice)) throw inputError('请选择小米预置音色。')
    audio.voice = voice
  }

  const messages = [{ role: 'assistant', content: text }]
  if (instruction) messages.unshift({ role: 'user', content: instruction })
  return { model, messages, audio, stream }
}

async function openMimo(apiKey, payload, signal) {
  const response = await fetch(MIMO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: payload.stream ? 'text/event-stream' : 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal,
    redirect: 'error',
  })
  if (response.ok) return response

  await response.body?.cancel().catch(() => {})
  const messages = {
    401: '小米 MiMo 拒绝了 API Key，请检查模型配置。',
    403: '当前 API Key 无权调用小米 MiMo TTS。',
    429: '小米 MiMo 请求过于频繁，请稍后再试。',
  }
  throw Object.assign(new Error(messages[response.status] || '小米 MiMo 返回 HTTP ' + response.status + '。'), { status: response.status })
}

export async function callMimo(apiKey, payload, signal) {
  const response = await openMimo(apiKey, payload, signal)
  const result = await response.json().catch(() => ({}))
  const encoded = result?.choices?.[0]?.message?.audio?.data
  if (!encoded) throw Object.assign(new Error('小米 MiMo 没有返回音频数据。'), { status: 502 })
  const audio = Buffer.from(encoded, 'base64')
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('小米 MiMo 没有返回有效的 WAV 音频。'), { status: 502 })
  }
  return audio
}

async function streamMimo(apiKey, payload, res, signal) {
  const response = await openMimo(apiKey, payload, signal)
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel()
    throw Object.assign(new Error('小米 MiMo 没有返回音频流。'), { status: 502 })
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let eventLines = []
  let receivedAudio = false

  const send = async (message) => {
    if (!res.write(JSON.stringify(message) + '\n')) await once(res, 'drain', { signal })
  }

  const handleEvent = async (message) => {
    if (!message) return false
    if (message === '[DONE]') {
      if (!receivedAudio) throw Object.assign(new Error('小米 MiMo 没有返回音频数据。'), { status: 502 })
      await send({ done: true })
      return true
    }

    const chunk = JSON.parse(message)
    const choice = chunk?.choices?.[0]
    if (chunk?.error || (choice?.finish_reason && choice.finish_reason !== 'stop')) {
      throw Object.assign(new Error('小米 MiMo 未完成音频合成，请重试。'), { status: 502 })
    }
    const encoded = choice?.delta?.audio?.data
    if (typeof encoded === 'string' && encoded) {
      receivedAudio = true
      await send({ data: encoded })
    }
    if (choice?.finish_reason) {
      if (!receivedAudio) throw Object.assign(new Error('小米 MiMo 没有返回音频数据。'), { status: 502 })
      await send({ done: true })
      return true
    }
    return false
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (line.startsWith('data:')) eventLines.push(line.slice(5).trimStart())
        if (line || !eventLines.length) continue
        if (await handleEvent(eventLines.join('\n').trim())) {
          res.end()
          return
        }
        eventLines = []
      }
    }
    if (pending.trim() && pending.startsWith('data:')) {
      eventLines.push(pending.slice(5).trimStart())
    }
    if (eventLines.length && await handleEvent(eventLines.join('\n').trim())) {
      res.end()
      return
    }
    throw Object.assign(new Error('小米 MiMo 音频流提前结束，请重试。'), { status: 502 })
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function handleTts(req, res, { test = false, stream = false } = {}) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: '只支持 POST。' })
  }
  const origin = req.headers.origin
  const protocol = req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https'
  if (origin && origin !== protocol + '://' + req.headers.host) {
    return res.status(403).json({ error: '请从本站页面调用此接口。' })
  }

  const apiKey = String(req.headers['api-key'] || '').trim()
  if (!apiKey) return res.status(401).json({ error: '请先填写 MIMO_API_KEY。' })

  const client = new AbortController()
  const onClose = () => client.abort()
  res.once('close', onClose)
  const timeout = AbortSignal.timeout(60_000)
  const signal = AbortSignal.any([client.signal, timeout])

  try {
    let fields = req.body
    if (typeof fields === 'string') {
      try {
        fields = JSON.parse(fields)
      } catch {
        throw inputError('请求格式无效。')
      }
    }
    const payload = buildPayload(fields, test, stream)
    if (stream) {
      await streamMimo(apiKey, payload, res, signal)
      return
    }

    const audio = await callMimo(apiKey, payload, signal)
    if (test) return res.status(200).json({ ok: true })
    res.setHeader('Content-Type', 'audio/wav')
    return res.status(200).send(audio)
  } catch (error) {
    if (client.signal.aborted || res.destroyed) return
    const status = timeout.aborted ? 504 : Number.isInteger(error.status) ? error.status : 502
    const message = timeout.aborted ? '小米 MiMo 请求超时，请重试。'
      : error.status ? error.message : '小米 MiMo 音频响应失败，请稍后重试。'
    if (res.headersSent) return res.end(JSON.stringify({ error: message }) + '\n')
    return res.status(status).json({ error: message })
  } finally {
    res.off('close', onClose)
  }
}
