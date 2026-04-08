import { getSetupSession, updateSetupSession } from './sessions.js'

// Pure helpers — operate on raw setupData objects so they can be tested without DB.

export function parseBotAdmins(setupData) {
  return (setupData?.bot_admins ?? []).map(a => ({ userId: String(a.userId), firstName: a.firstName }))
}

export function isBotAdminInData(setupData, userId) {
  return parseBotAdmins(setupData).some(a => a.userId === String(userId))
}

export function addBotAdminToData(setupData, userId, firstName) {
  const admins = parseBotAdmins(setupData)
  if (admins.some(a => a.userId === String(userId))) return { status: 'already', setupData }
  return { status: 'added', setupData: { ...setupData, bot_admins: [...admins, { userId: String(userId), firstName }] } }
}

export function removeBotAdminFromData(setupData, userId) {
  const admins = parseBotAdmins(setupData)
  const filtered = admins.filter(a => a.userId !== String(userId))
  if (filtered.length === admins.length) return { status: 'not_found', setupData }
  return { status: 'removed', setupData: { ...setupData, bot_admins: filtered } }
}

export async function isBotAdmin(groupId, userId) {
  const session = await getSetupSession(groupId)
  return isBotAdminInData(session?.setup_data, userId)
}

export async function getBotAdmins(groupId) {
  const session = await getSetupSession(groupId)
  return parseBotAdmins(session?.setup_data)
}

export async function addBotAdmin(groupId, userId, firstName) {
  const session = await getSetupSession(groupId)
  if (!session) return 'no_session'
  const { status, setupData } = addBotAdminToData(session.setup_data, userId, firstName)
  if (status === 'already') return 'already'
  await updateSetupSession(groupId, { setup_data: setupData })
  return 'added'
}

export async function removeBotAdmin(groupId, userId) {
  const session = await getSetupSession(groupId)
  if (!session) return 'no_session'
  const { status, setupData } = removeBotAdminFromData(session.setup_data, userId)
  if (status === 'not_found') return 'not_found'
  await updateSetupSession(groupId, { setup_data: setupData })
  return 'removed'
}
