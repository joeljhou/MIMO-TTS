import { handleTts } from './_mimo.js'

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只支持 POST。' })
  return handleTts(req, res, true)
}
