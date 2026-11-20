const { HmacSHA256 } = require('crypto-js')

const MIMO_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
const API_KEY_URL = 'https://platform.xiaomimimo.com/console/api-keys'
const SAMPLE_CONVERTER_URL = 'https://mimo-tts.geekyspace.cn/'
const DEFAULT_MODEL = 'mimo-v2.5-tts'
const DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const CACHE_TTL_SECONDS = 600
const CACHE_MAX_ENTRIES = 10
const CACHE_MAX_TOTAL_SIZE = 8 * 1024 * 1024
const CACHE_MAX_ITEM_SIZE = 2 * 1024 * 1024
const audioCache = new Map()
const inFlight = new Map()
let cacheSize = 0

const STYLES = {
  natural: '用自然的口语表达，咬字清楚，语速适中。',
  soft: '语气温柔，音量轻一些，语速放慢，句间稍作停顿。',
  news: '像新闻主播一样，发音清晰，语气沉稳，节奏匀速。',
  lively: '像分享好消息一样，声音明亮，语调上扬，语速稍快。',
  story: '像讲故事一样叙述，重要词语适当加重，情绪随情节起伏。',
  none: '',
}

function supportLanguages() {
  return ['zh-Hans', 'zh-Hant', 'en']
}

function sampleError(message) {
  return Object.assign(new Error(message), { troubleshootingLink: SAMPLE_CONVERTER_URL })
}

function normalizeSample(input) {
  if (!input) throw sampleError('请先填写「高级：音色复刻样本」。')
  const sample = /^(data:audio\/(?:wav|mpeg|mp3);base64,)([A-Za-z0-9+/]+={0,2})$/i.exec(input)
  if (!sample || sample[2].length % 4 !== 0) {
    throw sampleError('请粘贴 WAV 或 MP3 的完整 Base64 Data URL 作为音色样本。')
  }
  if (sample[2].length > 10000000) {
    throw sampleError('音色样本的 Base64 内容不能超过 10 MB。')
  }
  return sample[1].toLowerCase() + sample[2]
}

function buildPayload(text) {
  const model = $option.model || DEFAULT_MODEL
  const preset = $option.stylePreset || 'natural'
  let instruction = ($option.style || '').trim() || (STYLES[preset] || '')
  const audio = { format: 'wav' }

  switch (model) {
    case DEFAULT_MODEL: {
      const voice = $option.voice || '冰糖'
      const { menuValues } = $info.options.find(option => option.identifier === 'voice')
      if (!menuValues.some(option => option.value === voice)) {
        throw new Error('请从「预置音色」菜单重新选择音色。')
      }
      audio.voice = voice
      break
    }
    case DESIGN_MODEL: {
      const description = ($option.voiceDescription || '').trim()
      if (!description) throw new Error('请先填写音色描述。')
      instruction = instruction ? description + '\n朗读要求：' + instruction : description
      audio.optimize_text_preview = false
      break
    }
    case CLONE_MODEL:
      audio.voice = normalizeSample(($option.voiceSample || '').trim())
      break
    default:
      throw new Error('请选择支持的小米 MiMo TTS 模型。')
  }

  const messages = []
  if (instruction) messages.push({ role: 'user', content: instruction })
  messages.push({ role: 'assistant', content: text })
  return { model, messages, audio, stream: false }
}

function responseError(response) {
  const status = response && response.response && response.response.statusCode
  if (status === 401) {
    return { type: 'secretKey', message: '小米 MiMo 拒绝了 API Key，请检查插件配置。', troubleshootingLink: API_KEY_URL }
  }
  if (status === 403) {
    return { type: 'api', message: '当前账号没有权限调用所选的小米 MiMo 模型。' }
  }
  if (status === 429) {
    return { type: 'api', message: '小米 MiMo 请求过于频繁或达到用量限制，请稍后再试。' }
  }
  if (status && (status < 200 || status >= 300)) {
    return { type: 'network', message: '小米 MiMo 请求失败（HTTP ' + status + '）。' }
  }
  if (!response || response.error) {
    return { type: 'network', message: '无法连接小米 MiMo，请检查网络后重试。' }
  }
  return null
}

function removeCachedAudio(key) {
  const entry = audioCache.get(key)
  audioCache.delete(key)
  cacheSize -= entry.value.length
  $timer.invalidate(entry.timer)
}

function getCachedAudio(key) {
  const entry = audioCache.get(key)
  if (!entry) return
  if (Date.now() >= entry.expiresAt) {
    removeCachedAudio(key)
    return
  }
  audioCache.delete(key)
  audioCache.set(key, entry)
  return entry.value
}

function hasCompleteWav(value) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = value.length / 4 * 3 - padding
  if (bytes <= 44) return false

  // The little-endian RIFF size excludes the first eight bytes of the file.
  const hex = $data.fromBase64(value.slice(0, 16)).toHex()
  const size = parseInt(hex.slice(14, 16) + hex.slice(12, 14) + hex.slice(10, 12) + hex.slice(8, 10), 16)
  return size + 8 === bytes
}

function cacheAudio(key, value) {
  if (value.length > CACHE_MAX_ITEM_SIZE || !hasCompleteWav(value)) return
  while (audioCache.size >= CACHE_MAX_ENTRIES || cacheSize + value.length > CACHE_MAX_TOTAL_SIZE) {
    removeCachedAudio(audioCache.keys().next().value)
  }

  const entry = { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 }
  entry.timer = $timer.schedule({
    interval: CACHE_TTL_SECONDS,
    repeats: false,
    handler() {
      if (audioCache.get(key) !== entry) return
      audioCache.delete(key)
      cacheSize -= entry.value.length
    },
  })
  audioCache.set(key, entry)
  cacheSize += value.length
}

function requestAudio(apiKey, payload) {
  return new Promise((resolve) => {
    $http.request({
      method: 'POST',
      url: MIMO_URL,
      header: { 'Content-Type': 'application/json', 'api-key': apiKey },
      timeout: 55,
      body: payload,
      handler(response) {
        const error = responseError(response)
        if (error) {
          resolve({ error })
          return
        }

        let value
        try {
          const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          value = data.choices[0].message.audio.data
          const header = typeof value === 'string' && $data.fromBase64(value.slice(0, 16))
          if (!header || !/^52494646[0-9a-f]{8}57415645$/i.test(header.toHex())) value = null
        } catch {
          value = null
        }

        if (value) resolve({ result: { type: 'base64', value } })
        else resolve({ error: { type: 'api', message: '小米 MiMo 没有返回有效的 WAV 音频。' } })
      },
    })
  }).catch(() => ({ error: { type: 'network', message: '无法连接小米 MiMo，请检查网络后重试。' } }))
}

async function synthesize(text, useCache) {
  const apiKey = ($option.apiKey || '').trim()
  if (!apiKey) {
    return {
      error: { type: 'secretKey', message: '请先填写 MIMO_API_KEY。', troubleshootingLink: API_KEY_URL },
    }
  }
  if (!text) {
    return { error: { type: 'param', message: '请输入要合成的文本。' } }
  }

  let payload
  try {
    payload = buildPayload(text)
  } catch (error) {
    const details = { type: 'param', message: error.message }
    if (error.troubleshootingLink) details.troubleshootingLink = error.troubleshootingLink
    return { error: details }
  }

  if (!useCache) return requestAudio(apiKey, payload)

  const key = HmacSHA256(JSON.stringify(payload), apiKey).toString()
  const cached = getCachedAudio(key)
  if (cached) return { result: { type: 'base64', value: cached } }
  if (inFlight.has(key)) return inFlight.get(key)

  const request = requestAudio(apiKey, payload).then((response) => {
    if (response.result) cacheAudio(key, response.result.value)
    return response
  }).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, request)
  return request
}

function tts(query, completion) {
  const text = query && typeof query.text === 'string' ? query.text.trim() : ''
  synthesize(text, true).then(completion)
}

function pluginValidate(completion) {
  const englishVoice = ($option.model || DEFAULT_MODEL) === DEFAULT_MODEL && ['Mia', 'Chloe', 'Milo', 'Dean'].includes($option.voice)
  const text = englishVoice ? 'Hello. This is a speech synthesis test.' : '你好，这是一段语音合成测试。'
  synthesize(text, false).then(({ error }) => {
    completion(error ? { result: false, error } : { result: true })
  })
}

function pluginTimeoutInterval() {
  return 60
}

// Bob loads plugin functions from CommonJS exports.
exports.supportLanguages = supportLanguages
exports.tts = tts
exports.pluginValidate = pluginValidate
exports.pluginTimeoutInterval = pluginTimeoutInterval
