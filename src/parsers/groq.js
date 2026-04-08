import Groq from 'groq-sdk'

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

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
