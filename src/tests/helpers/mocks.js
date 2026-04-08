// Shared test helpers — backward compatible with all existing tests.
// New exports: MockDB (stateful class), makeGroupMsg, makeDMMsg, OutputVerifier.
// Existing exports kept: MockBot (enhanced), makeMockDb, makeMsg.

// ── MockBot ───────────────────────────────────────────────────────────────────

export class MockBot {
  constructor() {
    this.sentMessages = []
    this.editedMessages = []
    this.members = {}
  }

  // Backward-compat aliases
  get sent() { return this.sentMessages }
  get last() { return this.sentMessages.at(-1) ?? null }

  sendMessage(chatId, text, options = {}) {
    const msg = { chatId: String(chatId), text, options, timestamp: Date.now() }
    this.sentMessages.push(msg)
    return Promise.resolve({ message_id: this.sentMessages.length })
  }

  editMessageText(text, options = {}) {
    this.editedMessages.push({ text, options })
    return Promise.resolve({})
  }

  messagesTo(chatId) {
    return this.sentMessages.filter(m => m.chatId === String(chatId))
  }

  // Returns last message sent to a specific chat (or any chat)
  lastMessage(chatId = null) {
    const msgs = chatId
      ? this.sentMessages.filter(m => m.chatId === String(chatId))
      : this.sentMessages
    return msgs.at(-1) ?? null
  }

  // Assert a message was sent to chatId containing text
  assertSent(chatId, containsText) {
    const msgs = this.messagesTo(chatId)
    const found = msgs.some(m => m.text.includes(containsText))
    if (!found) {
      const texts = msgs.map(m => m.text).join('\n---\n')
      throw new Error(
        `Expected message to ${chatId} containing "${containsText}"\n` +
        `Actually sent:\n${texts || '(nothing)'}`
      )
    }
  }

  // Assert bot was silent to a chat (or completely silent)
  assertSilent(chatId = null) {
    const msgs = chatId ? this.messagesTo(chatId) : this.sentMessages
    if (msgs.length > 0) {
      throw new Error(
        `Expected bot to stay silent but sent ${msgs.length} message(s):\n` +
        msgs.map(m => `  [${m.chatId}] ${m.text.slice(0, 100)}`).join('\n')
      )
    }
  }

  getChatMember(chatId, userId) {
    const key = `${chatId}:${userId}`
    return Promise.resolve(this.members[key] ?? { status: 'member' })
  }

  setAdmin(chatId, userId) {
    this.members[`${chatId}:${userId}`] = { status: 'administrator' }
  }

  clear() {
    this.sentMessages = []
    this.editedMessages = []
  }
}

// ── MockDB (stateful, for multi-step integration tests) ───────────────────────

export class MockDB {
  constructor() {
    this.coverageRequests = []
    this.tradeRequests = []
    this.staff = []
    this.shifts = []
    this.scheduleAssignments = []
    this.outreach = []
    this._id = 1

    // Bind all async methods so they work when destructured by handlers
    // e.g. const _saveRequest = db?.saveRequest ?? saveRequest
    this.saveRequest = this.saveRequest.bind(this)
    this.getOpenRequest = this.getOpenRequest.bind(this)
    this.markCovered = this.markCovered.bind(this)
    this.updateCoverageRequestShift = this.updateCoverageRequestShift.bind(this)
    this.getGroupMembersWithDm = this.getGroupMembersWithDm.bind(this)
    this.saveOutreach = this.saveOutreach.bind(this)
    this.getShiftRoster = this.getShiftRoster.bind(this)
    this.saveTradeRequest = this.saveTradeRequest.bind(this)
    this.getOpenTradeRequest = this.getOpenTradeRequest.bind(this)
  }

  _nextId() { return this._id++ }

  // Coverage requests
  async saveRequest(groupId, groupName, shiftDesc, requestedBy) {
    const row = {
      id: this._nextId(),
      group_id: String(groupId),
      group_name: groupName,
      shift_description: shiftDesc,
      requested_by: requestedBy,
      matched_shift_id: null,
      week_start: null,
      status: 'open',
      covered_by: null,
      created_at: new Date().toISOString(),
    }
    this.coverageRequests.push(row)
    return row
  }

  async getOpenRequest(groupId) {
    return this.coverageRequests
      .filter(r => r.group_id === String(groupId) && r.status === 'open')
      .at(-1) ?? null
  }

  async markCovered(id, coveredBy) {
    const r = this.coverageRequests.find(r => r.id === id)
    if (r) { r.status = 'covered'; r.covered_by = coveredBy }
    return r ?? null
  }

  async updateCoverageRequestShift(requestId, shiftId, weekStart) {
    const r = this.coverageRequests.find(r => r.id === requestId)
    if (r) { r.matched_shift_id = shiftId; r.week_start = weekStart }
    return r ?? null
  }

  // Staff DMs — returns [{ userId, firstName, dmChatId }]
  async getGroupMembersWithDm(groupId) {
    return this.staff
      .filter(s => s.group_id === String(groupId) && s.dm_chat_id)
      .map(s => ({ userId: s.id, firstName: s.name, dmChatId: String(s.dm_chat_id) }))
  }

  async saveOutreach(requestId, userId) {
    this.outreach.push({ requestId, userId })
  }

  async getShiftRoster(shiftId, weekStart) {
    return this.scheduleAssignments
      .filter(a => a.shift_id === shiftId && a.week_start === weekStart)
      .map(a => {
        const st = this.staff.find(s => s.id === a.staff_id)
        return { staffName: st?.name ?? 'Unknown', roleName: st?.role ?? 'Staff' }
      })
  }

  // Trade requests
  async saveTradeRequest(groupId, groupName, requesterId, requesterName, shiftId, shiftDescription, weekStart) {
    const row = {
      id: this._nextId(),
      group_id: String(groupId),
      group_name: groupName,
      requester_id: requesterId,
      requester_name: requesterName,
      shift_id: shiftId,
      shift_description: shiftDescription,
      week_start: weekStart,
      status: 'open',
      created_at: new Date().toISOString(),
    }
    this.tradeRequests.push(row)
    return row
  }

  async getOpenTradeRequest(groupId) {
    return this.tradeRequests
      .filter(t => t.group_id === String(groupId) && t.status === 'open')
      .at(-1) ?? null
  }

  // Seed helpers
  seedStaff(data) {
    const s = { id: this._nextId(), group_id: null, role: 'Staff', active: true, dm_chat_id: null, ...data }
    this.staff.push(s)
    return s
  }

  seedShift(data) {
    const s = { id: this._nextId(), start_time: '9:00 AM', end_time: '5:00 PM', ...data }
    this.shifts.push(s)
    return s
  }

  seedAssignment(data) {
    const a = { id: this._nextId(), status: 'scheduled', ...data }
    this.scheduleAssignments.push(a)
    return a
  }
}

// ── Message factories ─────────────────────────────────────────────────────────

// Backward compat — used by existing tests
export function makeMsg({
  text = '',
  firstName = 'Alice',
  userId = 1001,
  chatId = '-100',
  chatTitle = 'Test Group',
} = {}) {
  return {
    text,
    from: { id: userId, first_name: firstName },
    chat: { id: chatId, type: 'supergroup', title: chatTitle },
  }
}

export function makeGroupMsg(overrides = {}) {
  return {
    chat: {
      id: '-100999888',
      type: 'group',
      title: 'Test Kitchen Staff',
      ...overrides.chat,
    },
    from: {
      id: 12345,
      first_name: 'Mike',
      username: 'mike_chef',
      ...overrides.from,
    },
    text: overrides.text ?? 'test message',
    message_id: Math.floor(Math.random() * 10000),
    date: Math.floor(Date.now() / 1000),
  }
}

export function makeDMMsg(overrides = {}) {
  return {
    chat: {
      id: '12345',
      type: 'private',
      ...overrides.chat,
    },
    from: {
      id: 12345,
      first_name: 'Mike',
      username: 'mike_chef',
      ...overrides.from,
    },
    text: overrides.text ?? 'test message',
    message_id: Math.floor(Math.random() * 10000),
    date: Math.floor(Date.now() / 1000),
  }
}

// Backward compat factory (stateless)
export function makeMockDb(overrides = {}) {
  return {
    saveRequest: async () => ({
      id: 'req-1',
      shift_description: 'test shift',
      requested_by: 'Alice',
      group_id: '-100',
    }),
    getOpenRequest: async () => null,
    markCovered: async () => true,
    getGroupMembersWithDm: async () => [],
    saveOutreach: async () => {},
    updateCoverageRequestShift: async () => {},
    getShiftRoster: async () => [],
    ...overrides,
  }
}

// ── OutputVerifier ────────────────────────────────────────────────────────────
// Checks that bot messages are LOGICALLY correct, not just that they were sent.

export class OutputVerifier {
  constructor(mockBot, mockDb) {
    this.bot = mockBot
    this.db = mockDb
  }

  verifyCoverageRequest(groupId, expectedShift, expectedRequester) {
    const msg = this.bot.lastMessage(groupId)
    if (!msg) throw new Error(`Bot sent no message to group ${groupId}`)
    const text = msg.text

    if (!text.includes('📋') && !text.toLowerCase().includes('coverage')) {
      throw new Error(`Coverage message missing 📋 or "coverage":\n${text}`)
    }
    if (expectedShift && !text.toLowerCase().includes(expectedShift.toLowerCase())) {
      throw new Error(`Coverage message doesn't mention shift "${expectedShift}":\n${text}`)
    }
    if (expectedRequester && !text.includes(expectedRequester)) {
      throw new Error(`Coverage message doesn't mention requester "${expectedRequester}":\n${text}`)
    }
    if (!text.toLowerCase().includes('cover') && !text.toLowerCase().includes('volunteer')) {
      throw new Error(`Coverage message has no call to action:\n${text}`)
    }

    const openReqs = this.db.coverageRequests.filter(
      r => r.group_id === String(groupId) && r.status === 'open'
    )
    if (openReqs.length === 0) throw new Error('Coverage request not saved to DB')
    return true
  }

  verifyCoverageConfirmed(groupId, expectedVolunteer, expectedShift) {
    const msg = this.bot.lastMessage(groupId)
    if (!msg) throw new Error('Bot sent no message after confirmation')
    const text = msg.text

    if (!text.includes('✅') && !text.toLowerCase().includes('covered')) {
      throw new Error(`Confirmation missing ✅ or "covered":\n${text}`)
    }
    if (expectedVolunteer && !text.includes(expectedVolunteer)) {
      throw new Error(`Confirmation doesn't mention volunteer "${expectedVolunteer}":\n${text}`)
    }
    if (expectedShift && !text.toLowerCase().includes(expectedShift.toLowerCase())) {
      throw new Error(`Confirmation doesn't mention shift "${expectedShift}":\n${text}`)
    }

    const covered = this.db.coverageRequests.filter(
      r => r.group_id === String(groupId) && r.status === 'covered'
    )
    if (covered.length === 0) throw new Error('Request not marked as covered in DB')
    return true
  }

  verifyTradeOffer(groupId, requesterName, shiftName) {
    const msg = this.bot.lastMessage(groupId)
    if (!msg) throw new Error('Bot sent no message for trade offer')
    const text = msg.text

    if (!text.toLowerCase().includes('trade')) {
      throw new Error(`Trade message doesn't mention "trade":\n${text}`)
    }
    if (requesterName && !text.includes(requesterName)) {
      throw new Error(`Trade message doesn't mention requester "${requesterName}":\n${text}`)
    }
    if (shiftName && !text.toLowerCase().includes(shiftName.toLowerCase())) {
      throw new Error(`Trade message doesn't mention shift "${shiftName}":\n${text}`)
    }

    const openTrade = this.db.tradeRequests.filter(
      t => t.group_id === String(groupId) && t.status === 'open'
    )
    if (openTrade.length === 0) throw new Error('Trade not saved to DB')
    return true
  }

  verifyScheduleLogic(assignments, shifts, staff, requirements) {
    const errors = []

    // No double booking on the same day
    const seen = {}
    for (const a of assignments) {
      const shift = shifts.find(s => s.id === a.shiftId || s.id === a.shift_id)
      if (!shift) continue
      const key = `${a.staffId ?? a.staff_id}:${shift.day_of_week}`
      if (seen[key]) {
        errors.push(`Double booking: staff ${a.staffId ?? a.staff_id} on ${shift.day_of_week}`)
      }
      seen[key] = true
    }

    if (errors.length > 0) {
      throw new Error('Schedule logic errors:\n' + errors.join('\n'))
    }
    return true
  }
}
