// Unified LLM client. Cerebras and Groq are KEPT INDEPENDENT here:
// - Each has its own client, model, direct call function, and retry helper.
// - Each call site picks one explicitly:
//     • cerebrasCreate / cerebrasWithRetry → only Cerebras
//     • groqCreate     / groqWithRetry     → only Groq
//     • llmCreate      / llmWithRetry      → Cerebras-first, Groq-fallback
//
// Logs always tag the actual provider that was called: [cerebras] or [groq].
// Models are NOT shared: CEREBRAS_MODEL ≠ GROQ_MODEL.

import OpenAI from 'openai'
import { logger } from '../logger.js'

// ── Models (per provider — distinct values) ─────────────────────────────────
export const CEREBRAS_MODEL = 'llama-3.3-70b'
export const GROQ_MODEL     = 'llama-3.3-70b-versatile'

// ── Lazy clients (returns null if no key) ───────────────────────────────────
let _cerebrasInit = false
let _cerebras = null
let _groqInit = false
let _groq = null

export function cerebrasClient() {
  if (!_cerebrasInit) {
    _cerebrasInit = true
    _cerebras = process.env.CEREBRAS_API_KEY
      ? new OpenAI({ apiKey: process.env.CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1' })
      : null
  }
  return _cerebras
}

export function groqClient() {
  if (!_groqInit) {
    _groqInit = true
    _groq = process.env.GROQ_API_KEY
      ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
      : null
  }
  return _groq
}

export function hasCerebras() { return !!cerebrasClient() }
export function hasGroq()     { return !!groqClient() }
export function hasAnyLLM()   { return hasCerebras() || hasGroq() }

// ── Cerebras-only call (fails if Cerebras not configured) ───────────────────
// Cerebras doesn't support response_format — strip it before sending.
export async function cerebrasCreate(params) {
  const c = cerebrasClient()
  if (!c) throw new Error('CEREBRAS_API_KEY not set — cannot call Cerebras')
  const { response_format, model, ...rest } = params
  const finalParams = { ...rest, model: model || CEREBRAS_MODEL }
  logger.bot(`[cerebras] chat.completions.create model=${finalParams.model}`)
  return c.chat.completions.create(finalParams)
}

// ── Groq-only call (fails if Groq not configured) ───────────────────────────
export async function groqCreate(params) {
  const g = groqClient()
  if (!g) throw new Error('GROQ_API_KEY not set — cannot call Groq')
  const { model, ...rest } = params
  const finalParams = { ...rest, model: model || GROQ_MODEL }
  logger.bot(`[groq] chat.completions.create model=${finalParams.model}`)
  return g.chat.completions.create(finalParams)
}

// ── Smart wrapper: Cerebras first, Groq fallback ────────────────────────────
// This is the default for production callers that don't care about the
// provider, only that they get an LLM response.
export async function llmCreate(params) {
  if (hasCerebras()) {
    try {
      return await cerebrasCreate(params)
    } catch (err) {
      logger.warn(`[llm] cerebras failed (status=${err.status} msg=${err.message}); falling back to groq`)
    }
  }
  if (hasGroq()) return groqCreate(params)
  throw new Error('No LLM provider configured — set CEREBRAS_API_KEY or GROQ_API_KEY')
}

// ── 429-aware retry with backoff ────────────────────────────────────────────
async function _withRetry(label, createFn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await createFn()
    } catch (err) {
      const is429 = err.status === 429 || /429|rate[\s_]?limit/i.test(err.message ?? '')
      if (is429 && attempt < maxRetries - 1) {
        const waitMs = (attempt + 1) * 6000
        logger.warn(`[${label}] rate-limited (attempt ${attempt + 1}/${maxRetries}), waiting ${waitMs}ms`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
}

export const cerebrasWithRetry = (fn, n) => _withRetry('cerebras', fn, n)
export const groqWithRetry     = (fn, n) => _withRetry('groq',     fn, n)
export const llmWithRetry      = (fn, n) => _withRetry('llm',      fn, n)

// ── Helpers ─────────────────────────────────────────────────────────────────
export function extractJSON(raw) {
  if (!raw) return '{}'
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braceMatch = raw.match(/\{[\s\S]*\}/)
  if (braceMatch) return braceMatch[0]
  return raw
}

// ── For unit tests that need to reset cached clients ────────────────────────
export function _resetClientsForTesting() {
  _cerebrasInit = false; _cerebras = null
  _groqInit = false; _groq = null
}
