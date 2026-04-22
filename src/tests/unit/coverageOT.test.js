// G.05 — Coverage volunteer OT warning
// Seeds 38h for a volunteer this week, calls handleCoverageConfirmation,
// asserts manager receives an OT warning DM.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('handleCoverageConfirmation OT warning (G.05)', () => {
  test('sends OT warning DM to manager when volunteer would exceed 40h', async () => {
    const { handleCoverageConfirmation } = await import('../../coverage/confirmationHandler.js')

    const GROUP_ID = 'group99'
    const MANAGER_DM = 9900
    const VOLUNTEER_NAME = 'Jordan'
    const VOLUNTEER_STAFF_ID = 55
    const WEEK_START = '2026-04-20'

    const sentMessages = []
    const mockBot = {
      sendMessage: (chatId, text, opts) => {
        sentMessages.push({ chatId: String(chatId), text })
        return Promise.resolve({ message_id: sentMessages.length })
      },
    }

    // Open coverage request with week_start so OT check runs
    const openRequest = {
      id: 'req1',
      status: 'open',
      group_id: GROUP_ID,
      shift_description: 'Sunday Brunch',
      requested_by: 'Taylor',
      requester_telegram_id: 7777,
      matched_shift_id: null,
      week_start: WEEK_START,
      created_at: new Date().toISOString(),
    }

    // Payroll row: Jordan already has 38h this week
    const payrollRows = [
      { staff_id: VOLUNTEER_STAFF_ID, group_id: GROUP_ID, week_start: WEEK_START, total_hours: 38 },
    ]

    const staff = [
      { id: VOLUNTEER_STAFF_ID, name: VOLUNTEER_NAME, group_id: GROUP_ID, role: 'server' },
      { id: 56, name: 'Taylor', group_id: GROUP_ID, role: 'server' },
    ]

    let markedCoveredCalled = false
    const mockDb = {
      getOpenRequest: () => Promise.resolve(openRequest),
      markCovered: (id, name) => {
        markedCoveredCalled = true
        return Promise.resolve({ ...openRequest, status: 'covered', covered_by: name })
      },
      getManagerDmChatId: () => Promise.resolve(MANAGER_DM),
      getPayrollForWeek: (groupId, weekStart) => Promise.resolve(payrollRows),
      getStaffForGroup: () => Promise.resolve(staff),
      getShiftRequirements: () => Promise.resolve([]),
      recordEvent: () => Promise.resolve(),
    }

    const msg = {
      chat: { id: GROUP_ID },
      from: { id: 8888, first_name: VOLUNTEER_NAME },
      text: 'I can cover',
    }

    const intent = { person: VOLUNTEER_NAME }

    await handleCoverageConfirmation(mockBot, msg, intent, mockDb)

    // Coverage must still be marked (OT warning is advisory only)
    assert.ok(markedCoveredCalled, 'markCovered must be called — OT warning does not block coverage')

    // Manager must receive OT warning
    const managerMsgs = sentMessages.filter(m => m.chatId === String(MANAGER_DM))
    const otWarning = managerMsgs.find(m => m.text.includes('40h') || m.text.includes('OT'))
    assert.ok(
      otWarning,
      `Expected OT warning DM to manager (chatId ${MANAGER_DM}). Got:\n` +
      managerMsgs.map(m => m.text).join('\n') || '(no messages to manager)'
    )
    assert.ok(
      otWarning.text.includes(VOLUNTEER_NAME),
      `OT warning must name the volunteer. Got: ${otWarning.text}`
    )
  })

  test('does NOT send OT warning when volunteer is well under 40h', async () => {
    const { handleCoverageConfirmation } = await import('../../coverage/confirmationHandler.js')

    const GROUP_ID = 'group100'
    const MANAGER_DM = 9901
    const VOLUNTEER_NAME = 'Casey'
    const VOLUNTEER_STAFF_ID = 60
    const WEEK_START = '2026-04-20'

    const sentMessages = []
    const mockBot = {
      sendMessage: (chatId, text, opts) => {
        sentMessages.push({ chatId: String(chatId), text })
        return Promise.resolve({ message_id: sentMessages.length })
      },
    }

    const openRequest = {
      id: 'req2',
      status: 'open',
      group_id: GROUP_ID,
      shift_description: 'Monday Lunch',
      requested_by: 'Morgan',
      requester_telegram_id: 7778,
      matched_shift_id: null,
      week_start: WEEK_START,
      created_at: new Date().toISOString(),
    }

    // Casey only has 20h — well under 40h even with 6h estimate
    const payrollRows = [
      { staff_id: VOLUNTEER_STAFF_ID, group_id: GROUP_ID, week_start: WEEK_START, total_hours: 20 },
    ]

    const staff = [
      { id: VOLUNTEER_STAFF_ID, name: VOLUNTEER_NAME, group_id: GROUP_ID, role: 'server' },
      { id: 61, name: 'Morgan', group_id: GROUP_ID, role: 'server' },
    ]

    const mockDb = {
      getOpenRequest: () => Promise.resolve(openRequest),
      markCovered: (id, name) => Promise.resolve({ ...openRequest, status: 'covered', covered_by: name }),
      getManagerDmChatId: () => Promise.resolve(MANAGER_DM),
      getPayrollForWeek: () => Promise.resolve(payrollRows),
      getStaffForGroup: () => Promise.resolve(staff),
      getShiftRequirements: () => Promise.resolve([]),
      recordEvent: () => Promise.resolve(),
    }

    const msg = {
      chat: { id: GROUP_ID },
      from: { id: 8889, first_name: VOLUNTEER_NAME },
      text: 'I can cover',
    }

    await handleCoverageConfirmation(mockBot, msg, { person: VOLUNTEER_NAME }, mockDb)

    const managerMsgs = sentMessages.filter(m => m.chatId === String(MANAGER_DM))
    const otWarning = managerMsgs.find(m => m.text.includes('40h') || m.text.includes('OT'))
    assert.equal(
      otWarning,
      undefined,
      `OT warning must NOT be sent when hours are fine. Got: ${otWarning?.text}`
    )
  })
})
