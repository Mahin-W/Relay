import OpenAI from 'openai'

let _client = null
const _getClient = () => {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: 'https://api.cerebras.ai/v1',
    })
  }
  return _client
}

// Lazy proxy — client is created on first use, not at module load.
// Prevents crash on startup when CEREBRAS_API_KEY is missing.
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
