function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

export const logger = {
  info:    (msg) => console.log(`[${timestamp()}] ℹ️  ${msg}`),
  bot:     (msg) => console.log(`[${timestamp()}] 🤖 ${msg}`),
  db:      (msg) => console.log(`[${timestamp()}] 🗄️  ${msg}`),
  error:   (msg) => console.error(`[${timestamp()}] ❌ ${msg}`),
  parse:   (msg) => console.log(`[${timestamp()}] 🔍 ${msg}`),
  success: (msg) => console.log(`[${timestamp()}] ✅ ${msg}`),
}
