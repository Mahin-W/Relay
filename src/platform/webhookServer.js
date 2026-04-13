// Phase 2/3: Express webhook server for SMS and WhatsApp.
// Runs alongside Telegram polling in index.js.
// POST /webhook/sms → TwilioSmsAdapter.normalize → handleDmMessage
// POST /webhook/whatsapp → WhatsAppAdapter.normalize → route to handler

export function createWebhookServer(unifiedBot, handlers = {}) {
  // Phase 2: implement with express
  // const app = express()
  // app.use(express.json())
  // app.use(express.urlencoded({ extended: false }))
  //
  // app.post('/webhook/sms', async (req, res) => {
  //   const msg = smsAdapter.normalizeMessage(req.body)
  //   await handlers.handleDm(unifiedBot, msg)
  //   res.status(200).send('<Response></Response>')
  // })
  //
  // app.post('/webhook/whatsapp', async (req, res) => {
  //   const msg = whatsappAdapter.normalizeMessage(req.body)
  //   if (msg.chat.type === 'private') {
  //     await handlers.handleDm(unifiedBot, msg)
  //   } else {
  //     await handlers.handleGroup(unifiedBot, msg)
  //   }
  //   res.status(200).send('OK')
  // })
  //
  // return app
  return null
}
