import { cancelRequest } from '../db.js'
import { getManagerGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'

export async function handleCoverageCancel(bot, msg) {
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const senderName = msg.from?.first_name || 'Someone'

  const managerGroup = await getManagerGroup(userId)
  const isManager = managerGroup?.group_id === groupId

  const cancelled = isManager
    ? await cancelRequest(groupId)
    : await cancelRequest(groupId, senderName)

  if (!cancelled) {
    await bot.sendMessage(msg.chat.id, isManager
      ? `No open coverage request to cancel 👍`
      : `No open coverage request from you to cancel 👍`
    )
    return
  }

  await bot.sendMessage(msg.chat.id, `✅ Coverage request cancelled.`)
  logger.bot(`Coverage request cancelled by ${isManager ? 'manager' : senderName} in ${msg.chat.title || groupId}`)
}
