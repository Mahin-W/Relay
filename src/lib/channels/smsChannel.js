// SMS channel shell (Epic 7 / WP-7.1).
//
// Registers an 'sms' sender with notify's channel registry so notify()/notifyGroup()
// can reach staff by SMS once a provider (Twilio) is wired. The actual send is
// blocked-on-human (Twilio creds); until deps.send is supplied, the sender
// throws 'sms not configured' (notify() catches it and reports not-delivered).

import { registerChannel } from '../notify.js'

export function registerSmsChannel(deps = {}) {
  const send = deps.send ?? (async () => { throw new Error('sms not configured') })
  registerChannel('sms', send)
}
