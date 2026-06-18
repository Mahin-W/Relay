import { getSetupSession, createSetupSession, updateSetupSession } from './setupDb.js'
import { getAccountByTelegramUser } from '../server/db/accounts.js'
import { rekeyGroup } from './db/rekey.js'
import { getStaffForGroup } from './db/staff.js'
import { getShiftsForGroup } from './db/shifts.js'
import { getRatesForGroup } from './db/roles.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

async function lookupDmChat(userId) {
  try {
    const { data } = await getDb().from('staff_dms').select('dm_chat_id').eq('user_id', userId).maybeSingle()
    return data?.dm_chat_id ?? null
  } catch { return null }
}

// Best-effort: a shareable join link for the group, used to invite employees.
// Requires the bot to be an admin with invite permission; returns null if not.
export async function ensureGroupInviteLink(bot, groupId) {
  try {
    const res = await bot.createChatInviteLink(groupId, { name: 'Relay team invite' })
    if (res?.invite_link) return res.invite_link
  } catch { /* bot not admin yet / no permission */ }
  try {
    const link = await bot.exportChatInviteLink(groupId)
    if (link) return link
  } catch { /* ignore */ }
  return null
}

// Links a Telegram group to the web account owned by `managerUserId`, pulling the
// account's staged setup into the group's tables. Idempotent: re-running on an
// already-connected group just refreshes the invite link.
//
// Returns one of:
//   { ok:false, reason:'no_account' }                     — adder has no linked account
//   { ok:true, already:true, status:'complete', ... }     — already connected
//   { ok:true, status:'complete', ... }                   — connected + setup done
//   { ok:true, status:'needs_more', nextStep, dmChatId }  — connected, missing essentials
export async function connectGroupToAccount(bot, { groupId, groupName, managerUserId }) {
  groupId = String(groupId)
  groupName = groupName || `Group ${groupId}`

  const account = await getAccountByTelegramUser(managerUserId)
  if (!account) return { ok: false, reason: 'no_account' }

  const existing = await getSetupSession(groupId)
  if (existing?.setup_complete) {
    let inviteLink = existing.setup_data?.invite_link || null
    if (!inviteLink) {
      inviteLink = await ensureGroupInviteLink(bot, groupId)
      if (inviteLink) {
        await updateSetupSession(groupId, { setup_data: { ...(existing.setup_data || {}), invite_link: inviteLink } })
      }
    }
    return { ok: true, already: true, status: 'complete', account, inviteLink }
  }

  const dmChatId = await lookupDmChat(managerUserId)
  const provisionalId = 'web:' + account.id

  // Move everything the owner set up on the web (under the provisional group)
  // onto the real Telegram group id. Idempotent + covers every group_id table.
  await rekeyGroup(provisionalId, groupId)

  // The rekey moved the provisional session's PK to groupId (if it existed).
  // Ensure a session row exists for this Telegram group, then fill its fields.
  let sess = await getSetupSession(groupId)
  if (!sess) {
    await createSetupSession(groupId, groupName, managerUserId, dmChatId)
  }
  await updateSetupSession(groupId, {
    account_id: account.id,
    manager_id: managerUserId,
    dm_chat_id: dmChatId,
    group_name: groupName,
  })

  // Completion is derived from the live tables, not a merge summary.
  const [staff, shifts, rates] = await Promise.all([
    getStaffForGroup(groupId),
    getShiftsForGroup(groupId),
    getRatesForGroup(groupId),
  ])
  const summary = {
    hasStaff: staff.length > 0,
    hasShifts: shifts.length > 0,
    hasRates: rates.length > 0,
    restaurantName: account.business_name || groupName,
  }
  const bizName = summary.restaurantName
  const inviteLink = await ensureGroupInviteLink(bot, groupId)

  const sess2 = await getSetupSession(groupId)
  await updateSetupSession(groupId, {
    setup_data: { ...(sess2?.setup_data || {}), invite_link: inviteLink || null },
  })

  if (summary.hasShifts && summary.hasStaff) {
    await updateSetupSession(groupId, { step: 'complete', setup_complete: true })
    logger.bot(`Group ${groupId} connected to account ${account.id} (complete)`)
    return { ok: true, status: 'complete', account, summary, bizName, inviteLink }
  }

  const nextStep = !summary.hasShifts ? 'add_shifts' : 'add_staff'
  await updateSetupSession(groupId, { step: nextStep })
  logger.bot(`Group ${groupId} connected to account ${account.id} (continuing at ${nextStep})`)
  return { ok: true, status: 'needs_more', nextStep, account, summary, bizName, dmChatId, inviteLink }
}

// Posts the appropriate group + DM messages after a connect attempt. No-ops for
// already-connected groups so a re-add doesn't spam the chat.
export async function announceConnection(bot, { groupId, result }) {
  if (!result?.ok || result.already) return
  const { bizName, summary, inviteLink, dmChatId, nextStep } = result

  const inviteBlock = inviteLink
    ? `\n\n📲 *Invite your team* — share this link so they join and get set up automatically:\n${inviteLink}`
    : `\n\n📲 Make me a group admin and I'll create a one-tap join link you can share with your team.`

  try {
    if (result.status === 'complete') {
      await bot.sendMessage(groupId,
        `🎉 *${bizName}* is connected to Relay — I pulled in your shifts, staff${summary?.hasRates ? ', and pay rates' : ''}. You're all set!${inviteBlock}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true })
    } else {
      await bot.sendMessage(groupId,
        `🎉 *${bizName}* is connected to Relay — I pulled in what you set up. I'll DM you to finish the rest.${inviteBlock}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true })
      if (dmChatId) {
        const prompt = nextStep === 'add_shifts'
          ? `Let's finish setting up *${bizName}*.\n\nDescribe each shift like: _Saturday Lunch, 11am–3pm_.\nSend *done* when you've added them all.`
          : `Let's finish setting up *${bizName}*.\n\nWho works there and what are their roles? e.g. _John and Sarah are servers, Mike is a cook_.\nSend *done* when you've added everyone.`
        try { await bot.sendMessage(dmChatId, prompt, { parse_mode: 'Markdown' }) }
        catch (err) { logger.error(`Could not DM manager to continue setup: ${err.message}`) }
      }
    }
  } catch (err) {
    logger.error(`announceConnection failed for group ${groupId}: ${err.message}`)
  }
}
