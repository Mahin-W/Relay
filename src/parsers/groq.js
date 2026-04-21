import OpenAI from 'openai'

let _client = null
const _getClient = () => {
  if (!_client) {
    if (process.env.CEREBRAS_API_KEY) {
      _client = new OpenAI({
        apiKey: process.env.CEREBRAS_API_KEY,
        baseURL: 'https://api.cerebras.ai/v1',
      })
    } else {
      _client = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      })
    }
  }
  return _client
}

// Lazy proxy — client is created on first use, not at module load.
// Prefers CEREBRAS_API_KEY; falls back to GROQ_API_KEY with Groq endpoint.
export const GROQ_MODEL = process.env.CEREBRAS_API_KEY
  ? 'llama-3.3-70b'
  : 'llama-3.3-70b-versatile'
export const groq = new Proxy({}, {
  get(_, prop) { return _getClient()[prop] },
})

export function extractJSON(raw) {
  if (!raw) return '{}'
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braceMatch = raw.match(/\{[\s\S]*\}/)
  if (braceMatch) return braceMatch[0]
  return raw
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
