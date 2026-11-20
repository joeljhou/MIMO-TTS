const MIMO_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
const DEFAULT_MODEL = 'mimo-v2.5-tts'
const DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const MODELS = new Set([DEFAULT_MODEL, DESIGN_MODEL, CLONE_MODEL])
const VOICES = new Set(['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default'])
const MAX_REFERENCE_BASE64 = 10_000_000

export function jsonError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

export function buildPayload(fields, test = false) {
  const model = fields.model || DEFAULT_MODEL
  const text = test ? '你好，这是一次语音连接测试。' : String(fields.text || '').trim()
  const style = String(fields.style || '').trim()
  const description = String(fields.description || '').trim()
  const voice = fields.voice || '冰糖'
  const reference = String(fields.reference || '')

  if (!MODELS.has(model) || text.length < 1 || text.length > 100 || style.length > 200 || description.length > 300) {
    throw jsonError('请检查模型及文本长度。')
  }

  let instruction = style
  const audio = { format: 'wav' }
  if (model === DESIGN_MODEL) {
    if (!description && !test) throw jsonError('请先填写音色描述。')
    instruction = description || '清晰自然的普通话声音，语速适中。'
    if (style) instruction += `\n朗读要求：${style}`
    audio.optimize_text_preview = false
  } else if (model === CLONE_MODEL) {
    const match = reference.match(/^data:(audio\/mpeg|audio\/wav);base64,(.+)$/)
    if (!match || match[2].length < 1 || match[2].length > MAX_REFERENCE_BASE64) {
      throw jsonError('请上传 MP3 或 WAV 参考音频，文件最大 7.5 MB。')
    }
    try {
      Buffer.from(match[2], 'base64')
    } catch {
      throw jsonError('参考音频编码无效，请重新上传。')
    }
    audio.voice = reference
  } else {
    if (!VOICES.has(voice)) throw jsonError('请选择小米预置音色。')
    audio.voice = voice
  }

  const messages = [{ role: 'assistant', content: text }]
  if (instruction) messages.unshift({ role: 'user', content: instruction })
  return { model, messages, audio, stream: false }
}

export async function callMimo(apiKey, payload) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(MIMO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(result?.error?.message || `小米 MiMo 返回 HTTP ${response.status}。`)
      error.status = response.status
      throw error
    }
    const encoded = result?.choices?.[0]?.message?.audio?.data
    if (!encoded) throw Object.assign(new Error('小米 MiMo 没有返回音频数据。'), { status: 502 })
    const audio = Buffer.from(encoded, 'base64')
    if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
      throw Object.assign(new Error('小米 MiMo 没有返回有效的 WAV 音频。'), { status: 502 })
    }
    return audio
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('小米 MiMo 请求超时，请重试。'), { status: 504 })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function handleTts(req, res, test = false) {
  const apiKey = String(req.headers['api-key'] || '').trim()
  if (!apiKey) return res.status(401).json({ error: '请先填写 MIMO_API_KEY。' })
  try {
    const payload = buildPayload(req.body || {}, test)
    const audio = await callMimo(apiKey, payload)
    if (test) return res.status(200).json({ ok: true })
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(audio)
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502
    return res.status(status).json({ error: error.message || '请求失败。' })
  }
}
