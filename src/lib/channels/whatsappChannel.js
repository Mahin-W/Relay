// WhatsApp channel shell (Epic 7 / WP-7.2).
//
// Registers a 'whatsapp' sender with notify's channel registry. Real send is
// blocked-on-human (WhatsApp Business API creds); without deps.send the sender
// throws 'whatsapp not configured'.

import { registerChannel } from '../notify.js'

export function registerWhatsAppChannel(deps = {}) {
  const send = deps.send ?? (async () => { throw new Error('whatsapp not configured') })
  registerChannel('whatsapp', send)
}
