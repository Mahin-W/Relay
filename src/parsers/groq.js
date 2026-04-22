import OpenAI from 'openai'
import { logger } from '../logger.js'

const _cerebrasClient = () => process.env.CEREBRAS_API_KEY
  ? new OpenAI({ apiKey: process.env.CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1' })
  : null

const _groqClient = () => process.env.GROQ_API_KEY
  ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
  : null

const CEREBRAS_MODEL = 'llama-3.3-70b'
const GROQ_MODEL_NAME = 'llama-3.3-70b-versatile'

// Always export the Cerebras model name — callers pass it through but
// the actual provider is selected at call time inside groqCreate.
export const GROQ_MODEL = CEREBRAS_MODEL

export function extractJSON(raw) {
  if (!raw) return '{}'
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braceMatch = raw.match(/\{[\s\S]*\}/)
  if (braceMatch) return braceMatch[0]
  return raw
}

// Cerebras-first, Groq fallback. Passes the right model name for each provider.
export async function groqCreate(params) {
  const cerebras = _cerebrasClient()
  if (cerebras) {
    try {
      return await cerebras.chat.completions.create({ ...params, model: CEREBRAS_MODEL })
    } catch (err) {
      logger.warn(`Cerebras failed (${err.status ?? err.message}), falling back to Groq`)
    }
  }

  const groqClient = _groqClient()
  if (!groqClient) throw new Error('No AI provider configured (set CEREBRAS_API_KEY or GROQ_API_KEY)')
  return groqClient.chat.completions.create({ ...params, model: GROQ_MODEL_NAME })
}

// Legacy proxy kept for any direct groq.chat.completions.create() calls elsewhere.
// New code should use groqCreate() directly.
export const groq = {
  chat: {
    completions: {
      create: (params) => groqCreate(params),
    },
  },
}

export async function groqWithRetry(createFn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await createFn()
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'))
      if (is429 && attempt < maxRetries - 1) {
        const waitMs = (attempt + 1) * 6000
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
}
