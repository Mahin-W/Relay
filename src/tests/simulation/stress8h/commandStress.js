// Command stress — drives every slash command handler with mock bot/db.
// Surfaces wiring bugs (handler not exported, throws, wrong signature).

import { MockBot } from '../../helpers/mocks.js'

export async function runCommandStress() {
  const findings = []
  const stats = { commandsTested: 0, commandsThrew: 0 }

  const bot = new MockBot()
  const groupId = 'stress-grp-cmd'
  const userId = 9001
  bot.setAdmin(groupId, userId)

  function makeMsg(text, isDm = false) {
    return {
      chat: { id: isDm ? userId : groupId, type: isDm ? 'private' : 'supergroup', title: 'Test Bistro' },
      from: { id: userId, first_name: 'Tony', username: 'tony_owner' },
      text,
      message_id: Math.floor(Math.random() * 100000),
      date: Math.floor(Date.now() / 1000),
    }
  }

  const isAuthAdmin = async () => true
  const isGroupAdmin = async () => true

  // List of commands with their handler invocations
  const commands = [
    {
      name: '/help',
      run: async () => {
        const { handleGroupCommands } = await import('../../../routing/commandRouter.js')
        const cmd = (n) => new RegExp(`^\\/${n}(@\\w+)?(\\s|$)`, 'i').test('/help')
        await handleGroupCommands(bot, makeMsg('/help'), cmd, 'relay_bot', isAuthAdmin, isGroupAdmin)
      },
    },
    {
      name: '/register',
      run: async () => {
        const { handleGroupCommands } = await import('../../../routing/commandRouter.js')
        const cmd = (n) => n === 'register'
        await handleGroupCommands(bot, makeMsg('/register'), cmd, 'relay_bot', isAuthAdmin, isGroupAdmin)
      },
    },
    {
      name: '/availability',
      run: async () => {
        const { startAvailabilityCollection } = await import('../../../availability/collectAvailability.js')
        await startAvailabilityCollection(bot, makeMsg('/availability'), groupId, 'relay_bot')
      },
    },
    {
      name: '/makeschedule',
      run: async () => {
        const { generateWeeklySchedule, getNextWeekStart } = await import('../../../schedule/generateSchedule.js')
        const r = await generateWeeklySchedule(groupId, getNextWeekStart())
        if (!r || !Array.isArray(r.assignments)) {
          findings.push({
            severity: 'HIGH', area: 'command-stress',
            title: `/makeschedule produced invalid result shape`,
            evidence: JSON.stringify(r).slice(0, 200),
          })
        }
      },
    },
    {
      name: '/schedule',
      run: async () => {
        const { getPublishedSchedule } = await import('../../../availability/availabilityDb.js')
        const r = await getPublishedSchedule(groupId)
        // expected: array
      },
    },
    {
      name: '/hours',
      run: async () => {
        const { calculateWeeklyHours, formatHoursWarning } = await import('../../../schedule/hoursTracker.js')
        const r = calculateWeeklyHours([], [], [])
        formatHoursWarning(r)
      },
    },
    {
      name: '/receipts',
      run: async () => {
        const { getUnconfirmedStaff } = await import('../../../schedule/readReceipts.js')
        await getUnconfirmedStaff(groupId, '2025-04-28')
      },
    },
    {
      name: '/log "busy night"',
      run: async () => {
        const { handleLogCommand } = await import('../../../managerLog/shiftLog.js')
        await handleLogCommand(bot, makeMsg('/log busy night'), 'busy night')
      },
    },
    {
      name: '/log [empty]',
      run: async () => {
        const { handleLogCommand } = await import('../../../managerLog/shiftLog.js')
        await handleLogCommand(bot, makeMsg('/log'), '')
      },
    },
    {
      name: '/clockstatus',
      run: async () => {
        const { handleClockStatus } = await import('../../../timeclock/clockCommands.js')
        await handleClockStatus(bot, makeMsg('/clockstatus'))
      },
    },
    {
      name: '/timesheet',
      run: async () => {
        const { handleTimesheetCommand } = await import('../../../timeclock/clockCommands.js')
        await handleTimesheetCommand(bot, makeMsg('/timesheet'), null)
      },
    },
    {
      name: '/timesheet @marco',
      run: async () => {
        const { handleTimesheetCommand } = await import('../../../timeclock/clockCommands.js')
        await handleTimesheetCommand(bot, makeMsg('/timesheet marco'), 'marco')
      },
    },
    {
      name: '/rules',
      run: async () => {
        const { handleListRules } = await import('../../../rules/businessRules.js')
        await handleListRules(bot, makeMsg('/rules'), groupId)
      },
    },
    {
      name: '/delrule 1',
      run: async () => {
        const { handleDeleteRule } = await import('../../../rules/businessRules.js')
        await handleDeleteRule(bot, makeMsg('/delrule 1'), 1, groupId)
      },
    },
    {
      name: '/morale',
      run: async () => {
        const { generateMoraleReport, formatMoraleReport } = await import('../../../intelligence/moraleTracker.js')
        const r = await generateMoraleReport(groupId, [])
        formatMoraleReport(r)
      },
    },
    {
      name: '/tipmode',
      run: async () => {
        const { handleTipModeCommand } = await import('../../../operations/tipPool.js')
        await handleTipModeCommand(bot, makeMsg('/tipmode pool hours'), ['pool', 'hours'])
      },
    },
    {
      name: '/tips',
      run: async () => {
        const { handleTipHistory } = await import('../../../operations/tipPool.js')
        await handleTipHistory(bot, makeMsg('/tips'))
      },
    },
    {
      name: '/kudos',
      run: async () => {
        const { handleRecognitionHistory } = await import('../../../engagement/recognition.js')
        await handleRecognitionHistory(bot, makeMsg('/kudos'), '')
      },
    },
    {
      name: '/crosstraining',
      run: async () => {
        const { formatCrossTrainingRoster } = await import('../../../intelligence/crossTraining.js')
        await formatCrossTrainingRoster(groupId)
      },
    },
    {
      name: '/retention',
      run: async () => {
        const { generateTurnoverRiskReport, formatTurnoverRiskCommand } = await import('../../../intelligence/turnoverRisk.js')
        const r = await generateTurnoverRiskReport(groupId)
        formatTurnoverRiskCommand(r)
      },
    },
    {
      name: '/quality',
      run: async () => {
        const { handleQualityCommand } = await import('../../../intelligence/scheduleQuality.js')
        await handleQualityCommand(bot, makeMsg('/quality'))
      },
    },
    {
      name: '/patterns',
      run: async () => {
        const { analyzeAllShifts, generateStaffingRecommendations, formatStaffingPatternAlert } = await import('../../../intelligence/staffingPatterns.js')
        const p = await analyzeAllShifts(groupId, 8)
        const recs = generateStaffingRecommendations(p)
        formatStaffingPatternAlert(recs)
      },
    },
    {
      name: '/staffinsight Aaliyah',
      run: async () => {
        const { calculateReliableAvailability, formatAvailabilityInsight } = await import('../../../intelligence/availabilityLearning.js')
        const r = await calculateReliableAvailability(1003, groupId, 8)
        formatAvailabilityInsight('Aaliyah', r)
      },
    },
    {
      name: '/coverage',
      run: async () => {
        const { handleCoverageCommand } = await import('../../../coverage/managerCoverage.js')
        await handleCoverageCommand(bot, makeMsg('/coverage'), [' '])
      },
    },
    {
      name: '/shifts',
      run: async () => {
        const { handleShiftsCommand } = await import('../../../setup/shiftEditor.js')
        await handleShiftsCommand(bot, makeMsg('/shifts'))
      },
    },
    {
      name: '/editshift',
      run: async () => {
        const { handleEditShift } = await import('../../../setup/shiftEditor.js')
        await handleEditShift(bot, makeMsg('/editshift 1 Monday 11:00 16:00'), '1 Monday 11:00 16:00')
      },
    },
    {
      name: '/addshift',
      run: async () => {
        const { handleAddShift } = await import('../../../setup/shiftEditor.js')
        await handleAddShift(bot, makeMsg('/addshift'))
      },
    },
    {
      name: '/staff',
      run: async () => {
        const { handleViewStaff } = await import('../../../setup/staffManager.js')
        await handleViewStaff(bot, makeMsg('/staff'))
      },
    },
    {
      name: '/removestaff',
      run: async () => {
        const { handleRemoveStaff } = await import('../../../setup/staffManager.js')
        await handleRemoveStaff(bot, makeMsg('/removestaff'), '')
      },
    },
    {
      name: '/copyschedule',
      run: async () => {
        const { handleCopySchedule } = await import('../../../schedule/copySchedule.js')
        await handleCopySchedule(bot, makeMsg('/copyschedule'))
      },
    },
    {
      name: '/welcome Marco',
      run: async () => {
        const { handleWelcomeCommand } = await import('../../../onboarding/handleNewHire.js')
        await handleWelcomeCommand(bot, makeMsg('/welcome Marco'), 'Marco')
      },
    },
    {
      name: '/rotation',
      run: async () => {
        const { handleRotationCommand } = await import('../../../fairness/rotationTracker.js')
        await handleRotationCommand(bot, makeMsg('/rotation'))
      },
    },
    {
      name: 'parseRevenueInput',
      run: async () => {
        const { parseRevenueInput } = await import('../../../analytics/laborCost.js')
        parseRevenueInput('14500')
        parseRevenueInput('$14,500')
        parseRevenueInput('')
        parseRevenueInput(null)
      },
    },
    {
      name: 'sendDailyBriefing',
      run: async () => {
        const { sendDailyBriefing } = await import('../../../briefing/dailyBriefing.js')
        await sendDailyBriefing(bot, groupId)
      },
    },
  ]

  for (const c of commands) {
    stats.commandsTested++
    try {
      await c.run()
    } catch (err) {
      const m = err.message || String(err)
      const isProbablyDb = /supabase|fetch|getaddrinfo|ECONN|relation|JWT|setup_sessions|PGRST|Failed to fetch/i.test(m)
      if (!isProbablyDb) {
        stats.commandsThrew++
        findings.push({
          severity: 'HIGH',
          area: 'command-stress',
          title: `Command "${c.name}" threw non-DB error`,
          evidence: `${m}\n${err.stack?.split('\n').slice(0, 4).join('\n')}`,
          impact: 'Slash command crashes the handler; manager sees no response or generic "Something went wrong".',
        })
      } else {
        // DB-related — record as MEDIUM (real production may fail similarly)
        findings.push({
          severity: 'MEDIUM',
          area: 'command-stress',
          title: `Command "${c.name}" failed with DB-related error`,
          evidence: m.slice(0, 300),
          impact: 'May indicate fragile DB query or missing fallback for empty data.',
        })
      }
    }
  }

  return { findings, stats }
}
