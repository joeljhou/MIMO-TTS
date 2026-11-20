const KEY = 'mimo-tts-api-key'
const VOICE_KEY = 'mimo-tts-voice'
const MODEL_KEY = 'mimo-tts-model'
const STYLE_KEY = 'mimo-tts-style'
const DESCRIPTION_KEY = 'mimo-tts-description'
const DEFAULT_MODEL = 'mimo-v2.5-tts'
const DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const referenceLimitMB = ['localhost', '127.0.0.1'].includes(location.hostname) ? 7.5 : 3.3
const mobile = matchMedia('(max-width: 640px)')
const voices = [
  { id: '冰糖', language: '中文', gender: '女性' },
  { id: '茉莉', language: '中文', gender: '女性' },
  { id: '苏打', language: '中文', gender: '男性' },
  { id: '白桦', language: '中文', gender: '男性' },
  { id: 'Mia', language: '英文', gender: '女性' },
  { id: 'Chloe', language: '英文', gender: '女性' },
  { id: 'Milo', language: '英文', gender: '男性' },
  { id: 'Dean', language: '英文', gender: '男性' },
]

const $ = (id) => document.getElementById(id)
const text = $('text')
const search = $('search')
const list = $('voice-list')
const panel = $('voice-panel')
const settings = $('settings')
const styleDialog = $('style')
const keyInput = $('api-key')
const styleInput = $('style-input')
const modelSelect = $('model-select')
const modelHint = $('model-hint')
const connectionStatus = $('connection-status')
const referenceAudio = $('reference-audio')
const voiceDescription = $('voice-description')
const voiceButton = $('open-voices')
const testButton = $('test-connection')
const presetButtons = document.querySelectorAll('[data-style]')
const play = $('play')
const download = $('download')
const player = new Audio()

let apiKey = localStorage.getItem(KEY) || ''
const savedModel = localStorage.getItem(MODEL_KEY)
let model = [DEFAULT_MODEL, DESIGN_MODEL, CLONE_MODEL].includes(savedModel) ? savedModel : DEFAULT_MODEL
const savedVoice = localStorage.getItem(VOICE_KEY)
let voice = voices.some(({ id }) => id === savedVoice) ? savedVoice : voices[0].id
let style = localStorage.getItem(STYLE_KEY) || ''
let description = localStorage.getItem(DESCRIPTION_KEY) || ''
let sampleFile = null
let audioUrl = ''
let pending = null
let streamSession = null
let connectionTest = null

const modelHints = {
  [DEFAULT_MODEL]: '使用小米预置发音人。',
  [DESIGN_MODEL]: '在「朗读风格」中填写音色描述。',
  [CLONE_MODEL]: '使用 MP3 或 WAV 参考音频复刻音色。',
}

function setStatus(message, error = false) {
  $('status').textContent = message
  $('status').dataset.error = String(error)
}

function updateCount() {
  $('count').value = text.value.length + '/100'
}

function drawVoices() {
  const query = search.value.trim().toLowerCase()
  const terms = query.split(/\s+/)
  const items = voices.filter(({ id, language, gender }) => {
    const searchable = [id, language, gender].join(' ').toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
  list.replaceChildren()
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = '没有找到匹配的发音人'
    list.append(empty)
    return
  }
  for (const { id, language, gender } of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'voice-card'
    button.dataset.voice = id
    button.setAttribute('aria-pressed', String(id === voice))
    const label = document.createElement('span')
    label.className = 'voice-name'
    label.textContent = id

    const metadata = document.createElement('span')
    metadata.className = 'voice-meta'
    const icon = document.createElement('span')
    icon.className = 'gender-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = gender === '男性' ? '♂' : '♀'
    metadata.append(language + ' · ', icon, gender)
    button.append(label, metadata)
    button.setAttribute('aria-label', [id, language, gender].join('，'))
    list.append(button)
  }
}

function setPanel(open, focus = true) {
  panel.hidden = !open || model !== DEFAULT_MODEL
  if (model === DEFAULT_MODEL) voiceButton.setAttribute('aria-expanded', String(!panel.hidden))
  search.value = ''
  drawVoices()
  if (focus) (panel.hidden ? voiceButton : $('close-voices')).focus()
}

function updateModelUi() {
  const preset = model === DEFAULT_MODEL
  voiceButton.querySelector('span').textContent = preset ? '发音人' : model === DESIGN_MODEL ? '音色描述' : '参考音频'
  if (preset) voiceButton.setAttribute('aria-controls', 'voice-panel')
  else {
    voiceButton.removeAttribute('aria-controls')
    voiceButton.removeAttribute('aria-expanded')
  }
  setPanel(!mobile.matches, false)
}

function showSettings(focus = keyInput) {
  keyInput.value = apiKey
  modelSelect.value = model
  referenceAudio.value = ''
  resetConnectionTest()
  updateModelFields()
  settings.showModal()
  focus.focus()
}

function updateModelFields() {
  modelHint.textContent = modelHints[modelSelect.value]
  $('reference-field').hidden = modelSelect.value !== CLONE_MODEL
  const file = referenceAudio.files[0] || sampleFile
  $('reference-hint').textContent = file ? '当前文件：' + file.name : `MP3 或 WAV，最大 ${referenceLimitMB} MB。刷新后需重新选择。`
}

function referenceMime(file) {
  if (!file) throw new Error('请先上传参考音频。')
  if (!file.size || file.size > referenceLimitMB * 1_000_000) throw new Error(`参考音频必须大于 0，且不超过 ${referenceLimitMB} MB。`)
  if (/\.wav$/i.test(file.name)) return 'audio/wav'
  if (/\.mp3$/i.test(file.name)) return 'audio/mpeg'
  throw new Error('参考音频只支持 MP3 或 WAV。')
}

async function readReferenceAudio(file) {
  const mime = referenceMime(file)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve('data:' + mime + ';base64,' + reader.result.split(',')[1])
    reader.onerror = () => reject(new Error('读取参考音频失败。'))
    reader.readAsDataURL(file)
  })
}

async function postAudio(path, key, payload, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}))
    throw new Error(error || '请求失败（HTTP ' + response.status + '）。')
  }
  return response
}

function showConnectionStatus(message, error = false) {
  connectionStatus.hidden = !message
  connectionStatus.dataset.error = String(error)
  connectionStatus.textContent = message
}

function resetConnectionTest() {
  connectionTest?.abort()
  connectionTest = null
  testButton.disabled = false
  showConnectionStatus('')
}

async function testConnection() {
  const key = keyInput.value.trim()
  if (!key) {
    showConnectionStatus('请先填写 API Key。', true)
    keyInput.focus()
    return
  }
  const test = new AbortController()
  connectionTest = test
  testButton.disabled = true
  showConnectionStatus('正在用所选模型合成一句测试语音…')
  const selectedModel = modelSelect.value
  try {
    const payload = { model: selectedModel, voice, description }
    if (selectedModel === CLONE_MODEL) payload.reference = await readReferenceAudio(referenceAudio.files[0] || sampleFile)
    await postAudio('/api/test', key, payload, test.signal)
    if (!test.signal.aborted) showConnectionStatus('连接成功，所选模型可以合成语音。')
  } catch (error) {
    if (!test.signal.aborted) showConnectionStatus('连接测试失败：' + error.message, true)
  } finally {
    if (connectionTest === test) {
      connectionTest = null
      testButton.disabled = false
    }
  }
}

function updateStylePresets() {
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.style === styleInput.value))
  }
}

function showStyle(focus = styleInput) {
  styleInput.value = style
  voiceDescription.value = description
  $('description-field').hidden = model !== DESIGN_MODEL
  updateStylePresets()
  styleDialog.showModal()
  focus.focus()
}

function clearAudio() {
  pending?.abort()
  stopStreamPlayback()
  if (audioUrl) {
    player.pause()
    player.removeAttribute('src')
    player.load()
    URL.revokeObjectURL(audioUrl)
    audioUrl = ''
  }
  setStatus('')
}

function stopStreamPlayback() {
  const session = streamSession
  if (!session) return
  session.controller.abort()
  for (const source of session.sources) {
    try {
      source.stop()
    } catch {
      // The source may have already ended.
    }
  }
  session.context.close()
  streamSession = null
  play.querySelector('span').textContent = '播放'
  play.disabled = false
  download.disabled = !audioUrl
}

function decodePcmChunk(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
  const floats = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    floats[index] = samples[index] / 32768
  }
  return { bytes, floats }
}

function schedulePcmChunk(session, encoded) {
  const { bytes, floats } = decodePcmChunk(encoded)
  session.pcmChunks.push(bytes)
  const buffer = session.context.createBuffer(1, floats.length, 24000)
  buffer.copyToChannel(floats, 0)
  const source = session.context.createBufferSource()
  source.buffer = buffer
  source.connect(session.context.destination)
  const startAt = Math.max(session.nextTime, session.context.currentTime + 0.03)
  source.start(startAt)
  session.nextTime = startAt + buffer.duration
  session.sources.push(source)
  session.activeSources += 1
  source.addEventListener('ended', () => {
    session.activeSources -= 1
    if (session.finished && session.activeSources === 0) {
      session.context.close()
    }
  })
  if (!session.started) {
    session.started = true
    setStatus('正在播放…')
  }
}

function pcmToWav(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const wav = new ArrayBuffer(44 + length)
  const view = new DataView(wav)
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + length, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, length, true)
  let offset = 44
  for (const chunk of chunks) {
    new Uint8Array(wav, offset, chunk.byteLength).set(chunk)
    offset += chunk.byteLength
  }
  return new Blob([wav], { type: 'audio/wav' })
}

async function startStreamAudio() {
  const content = text.value.trim()
  if (!content) {
    setStatus('请输入要合成的文本。', true)
    text.focus()
    return
  }
  if (!apiKey) {
    showSettings()
    return
  }
  if (model === DESIGN_MODEL && !description) {
    showStyle(voiceDescription)
    return
  }
  if (model === CLONE_MODEL && !sampleFile) {
    showSettings(referenceAudio)
    return
  }

  const request = new AbortController()
  const session = {
    controller: request,
    context: new AudioContext(),
    nextTime: 0,
    sources: [],
    pcmChunks: [],
    activeSources: 0,
    started: false,
    finished: false,
  }
  streamSession = session
  pending = request
  play.disabled = false
  download.disabled = true
  play.querySelector('span').textContent = '停止'
  setStatus('正在连接 MiMo…')

  try {
    await session.context.resume()
    const payload = { text: content, style, voice, model, description }
    if (model === CLONE_MODEL) payload.reference = await readReferenceAudio(sampleFile)
    const response = await fetch('/api/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
      signal: request.signal,
    })
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}))
      throw new Error(error || '请求失败（HTTP ' + response.status + '）。')
    }
    if (!response.body) throw new Error('浏览器不支持流式响应。')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pendingText = ''
    let done = false
    while (!done) {
      const result = await reader.read()
      if (result.done) break
      pendingText += decoder.decode(result.value, { stream: true })
      const lines = pendingText.split('\n')
      pendingText = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const chunk = JSON.parse(line)
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.data) schedulePcmChunk(session, chunk.data)
        if (chunk.done) done = true
      }
    }
    if (pendingText.trim()) {
      const chunk = JSON.parse(pendingText)
      if (chunk.data) schedulePcmChunk(session, chunk.data)
    }
    if (request.signal.aborted) return
    if (!session.pcmChunks.length) throw new Error('小米 MiMo 没有返回音频数据。')
    session.finished = true
    const wav = pcmToWav(session.pcmChunks)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    audioUrl = URL.createObjectURL(wav)
    player.src = audioUrl
    download.disabled = false
    setStatus('音频已生成，可下载或再次播放。')
    if (session.activeSources === 0) session.context.close()
  } catch (error) {
    if (!request.signal.aborted) setStatus('生成失败：' + error.message, true)
    if (!request.signal.aborted) stopStreamPlayback()
  } finally {
    if (pending === request) pending = null
    if (streamSession === session) streamSession = null
    play.querySelector('span').textContent = '播放'
    play.disabled = false
    download.disabled = !audioUrl
  }
}

function selectVoice(next) {
  if (voice === next) return
  voice = next
  clearAudio()
}

function syncPlayer() {
  const playing = !player.paused && !player.ended
  play.querySelector('span').textContent = playing ? '暂停' : '播放'
  $('play-shape').setAttribute('d', playing ? 'M26 22v20m12-20v20' : 'm26 22 18 10-18 10z')
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice]')
  if (!button) return
  selectVoice(button.dataset.voice)
  drawVoices()
  list.querySelector('[aria-pressed="true"]')?.focus()
})
search.addEventListener('input', drawVoices)
voiceButton.addEventListener('click', () => {
  if (model === DESIGN_MODEL) showStyle(voiceDescription)
  else if (model === CLONE_MODEL) showSettings(referenceAudio)
  else if (panel.hidden) setPanel(true)
  else search.focus()
})
$('close-voices').addEventListener('click', () => setPanel(false))
$('cancel-voices').addEventListener('click', () => setPanel(false))
$('confirm-voices').addEventListener('click', () => {
  localStorage.setItem(VOICE_KEY, voice)
  setPanel(false)
})
panel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setPanel(false)
})
mobile.addEventListener('change', () => setPanel(!mobile.matches, false))

text.addEventListener('input', () => {
  updateCount()
  clearAudio()
})
$('open-settings').addEventListener('click', () => showSettings())
keyInput.addEventListener('input', resetConnectionTest)
modelSelect.addEventListener('change', () => {
  resetConnectionTest()
  updateModelFields()
})
referenceAudio.addEventListener('change', () => {
  resetConnectionTest()
  updateModelFields()
})
testButton.addEventListener('click', testConnection)

$('key-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const nextKey = keyInput.value.trim()
  const nextModel = modelSelect.value
  const nextSample = nextModel === CLONE_MODEL ? referenceAudio.files[0] || sampleFile : sampleFile
  if (nextModel === CLONE_MODEL && nextSample) {
    try {
      referenceMime(nextSample)
    } catch (error) {
      showConnectionStatus(error.message, true)
      return
    }
  }

  const modelChanged = nextModel !== model
  if (nextKey !== apiKey || modelChanged || nextSample !== sampleFile) clearAudio()
  apiKey = nextKey
  model = nextModel
  sampleFile = nextSample
  if (apiKey) localStorage.setItem(KEY, apiKey)
  else localStorage.removeItem(KEY)
  localStorage.setItem(MODEL_KEY, model)

  settings.close()
  if (modelChanged) updateModelUi()
  setStatus('模型配置已保存。')
})
$('clear-key').addEventListener('click', () => {
  localStorage.removeItem(KEY)
  localStorage.removeItem(MODEL_KEY)
  const modelChanged = model !== DEFAULT_MODEL
  apiKey = ''
  model = DEFAULT_MODEL
  sampleFile = null
  clearAudio()
  settings.close()
  if (modelChanged) updateModelUi()
  setStatus('模型配置已清除。')
})
settings.addEventListener('close', () => {
  keyInput.value = ''
  referenceAudio.value = ''
  resetConnectionTest()
})

$('open-style').addEventListener('click', () => showStyle())
$('style-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const nextStyle = styleInput.value.trim()
  const nextDescription = model === DESIGN_MODEL ? voiceDescription.value.trim() : description
  if (nextStyle !== style || nextDescription !== description) clearAudio()
  style = nextStyle
  description = nextDescription
  localStorage.setItem(STYLE_KEY, style)
  localStorage.setItem(DESCRIPTION_KEY, description)
  styleDialog.close()
})
styleInput.addEventListener('input', updateStylePresets)
for (const button of presetButtons) {
  button.addEventListener('click', () => {
    styleInput.value = button.dataset.style
    updateStylePresets()
  })
}
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close())
})

for (const event of ['play', 'pause', 'ended', 'emptied']) player.addEventListener(event, syncPlayer)
play.addEventListener('click', async () => {
  if (streamSession) {
    stopStreamPlayback()
    return
  }
  if (!player.paused) {
    player.pause()
    return
  }
  if (audioUrl) {
    try {
      await player.play()
      setStatus('')
    } catch {
      setStatus('音频已生成，请再点一次播放，或下载 WAV。', true)
    }
    return
  }
  startStreamAudio()
})
download.addEventListener('click', async () => {
  if (streamSession) {
    setStatus('音频生成完成后即可下载。')
    return
  }
  if (!audioUrl) {
    startStreamAudio()
    setStatus('音频生成完成后再次点击下载。')
    return
  }
  const link = document.createElement('a')
  link.href = audioUrl
  const name = model === DEFAULT_MODEL ? 'mimo-tts-' + voice : model
  link.download = name + '.wav'
  document.body.append(link)
  link.click()
  link.remove()
})

updateCount()
updateModelUi()
