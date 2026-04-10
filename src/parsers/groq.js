import OpenAI from 'openai'

export const groq = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: 'https://api.cerebras.ai/v1',
})

// Extract JSON from LLM output that may contain markdown fences or preamble text.
export function extractJSON(raw) {
  if (!raw) return '{}'
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  // Find first { ... } block
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
