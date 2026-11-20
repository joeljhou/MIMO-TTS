import { handleTts } from '../../lib/mimo.js'

export default function handler(req, res) {
  return handleTts(req, res, { stream: true })
}
