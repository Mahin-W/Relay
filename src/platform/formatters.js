// Text formatting utilities for multi-platform messaging.
// Phase 1: only stripMarkdown is needed.
// Phase 2+: formatForPlatform routes to the right formatter.

export function stripMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')       // *bold* or **bold**
    .replace(/_(.*?)_/g, '$1')                // _italic_
    .replace(/`(.*?)`/g, '$1')                // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/^#{1,6}\s+/gm, '')              // # headers
    .trim()
}

export function formatForPlatform(text, platform) {
  switch (platform) {
    case 'telegram':
      return text
    case 'sms':
      return stripMarkdown(text)
    case 'whatsapp':
      // WhatsApp supports *bold* natively, most Telegram markdown works
      return text
    default:
      return stripMarkdown(text)
  }
}

export function truncateForSms(text, maxLength = 1600) {
  if (!text || text.length <= maxLength) return text || ''
  return text.substring(0, maxLength - 20) + '\n[Message truncated]'
}
