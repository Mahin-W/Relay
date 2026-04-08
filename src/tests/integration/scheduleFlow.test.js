import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateWeeklySchedule, formatScheduleMessage } from '../../schedule/generateSchedule.js'

// Integration tests for schedule generation + formatting.
// All scenarios run in parallel within each test.
// No DB or LLM calls — uses mockData path.

const WEEK = '2025-06-09'

function shift(id, name, day, start = '9:00 AM', end = '5:00 PM') {
  return { id, name, day_of_week: day, start_time: start, end_time: end }
}

function staff(id, name, role, userId) {
  return { id, name, role, userId }
}

function avail(userId, shiftIds, all = false, off = false) {
  return { user_id: userId, available_shift_ids: shiftIds, available_all: all, unavailable: off }
}

function req(shiftId, role, count) {
  return { shift_id: shiftId, role, count }
}

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(name, mockData, assertFn) {
  try {
    const result = await generateWeeklySchedule('test_group', WEEK, mockData)
    assertFn(result)
    return { name, passed: true }
  } catch (err) {
    return { name, passed: false, error: err.message }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Schedule Generation — parallel scenarios', () => {

  test('all five scheduling scenarios pass simultaneously', async () => {
    const scenarios = [

      // ── 1. Happy path ─────────────────────────────────────────────────────
      {
        name: 'Happy path — fully staffed multi-role',
        data: {
          shifts: [
            shift(1, 'Monday Lunch', 'Monday', '11:00 AM', '4:00 PM'),
            shift(2, 'Friday Dinner', 'Friday', '5:00 PM', '11:00 PM'),
          ],
          staff: [
            staff(1, 'Marcus', 'Chef', 'u1'),
            staff(2, 'Sarah', 'Server', 'u2'),
            staff(3, 'Tom', 'Server', 'u3'),
          ],
          availability: [
            avail('u1', [], true),  // available all week
            avail('u2', [], true),
            avail('u3', [], true),
          ],
          requirements: [
            req(1, 'Chef', 1), req(1, 'Server', 1),
            req(2, 'Chef', 1), req(2, 'Server', 1),
          ],
        },
        assert: (r) => {
          assert.equal(r.gaps.length, 0, `Expected no gaps. Got:\n${JSON.stringify(r.gaps)}`)
          assert.ok(r.assignments.length >= 4, `Expected 4+ assignments, got ${r.assignments.length}`)
        },
      },

      // ── 2. No double booking ──────────────────────────────────────────────
      {
        name: 'No double booking — two shifts same day',
        data: {
          shifts: [
            shift(1, 'Monday Lunch', 'Monday', '11:00 AM', '3:00 PM'),
            shift(2, 'Monday Dinner', 'Monday', '5:00 PM', '11:00 PM'),
          ],
          staff: [
            staff(1, 'Alice', 'Server', 'u1'),
            staff(2, 'Bob', 'Server', 'u2'),
          ],
          availability: [
            avail('u1', [], true),
            avail('u2', [], true),
          ],
          requirements: [
            req(1, 'Server', 1),
            req(2, 'Server', 1),
          ],
        },
        assert: (r) => {
          assert.equal(r.gaps.length, 0, 'Both Monday shifts should be filled')
          // Each person should be on at most one Monday shift
          const mondayAssignments = r.assignments.filter(a => a.dayOfWeek === 'Monday')
          const staffIds = mondayAssignments.map(a => a.staffId)
          assert.equal(
            new Set(staffIds).size, staffIds.length,
            `Double booking detected! Assignments: ${JSON.stringify(mondayAssignments)}`
          )
        },
      },

      // ── 3. Availability respected ─────────────────────────────────────────
      {
        name: 'Unavailable staff not assigned',
        data: {
          shifts: [
            shift(1, 'Friday Dinner', 'Friday'),
          ],
          staff: [
            staff(1, 'Emma', 'Server', 'u1'),  // unavailable
            staff(2, 'Tom', 'Server', 'u2'),   // available
          ],
          availability: [
            avail('u1', [], false, true),  // unavailable
            avail('u2', [1]),
          ],
          requirements: [req(1, 'Server', 1)],
        },
        assert: (r) => {
          assert.equal(r.assignments.length, 1, 'Should assign exactly 1 person')
          assert.equal(r.assignments[0].staffName, 'Tom', 'Tom should be assigned, not Emma')
          assert.equal(r.gaps.length, 0, 'No gap — Tom fills it')
        },
      },

      // ── 4. Role mismatch creates gap ──────────────────────────────────────
      {
        name: 'Role mismatch — chef needed, only servers available',
        data: {
          shifts: [shift(1, 'Saturday Lunch', 'Saturday')],
          staff: [
            staff(1, 'Alice', 'Server', 'u1'),
            staff(2, 'Bob', 'Server', 'u2'),
          ],
          availability: [
            avail('u1', [], true),
            avail('u2', [], true),
          ],
          requirements: [req(1, 'Chef', 1)],
        },
        assert: (r) => {
          assert.equal(r.assignments.length, 0, 'No Chefs available — 0 assignments')
          assert.equal(r.gaps.length, 1, 'Should report 1 gap')
          assert.equal(r.gaps[0].shortfall, 1, 'Shortfall should be 1')
        },
      },

      // ── 5. Fairness distribution ──────────────────────────────────────────
      {
        name: 'Fairness — shifts spread evenly across staff',
        data: {
          shifts: [
            shift(1, 'Monday', 'Monday'),
            shift(2, 'Tuesday', 'Tuesday'),
            shift(3, 'Wednesday', 'Wednesday'),
          ],
          staff: [
            staff(1, 'Alpha', 'Server', 'u1'),
            staff(2, 'Beta', 'Server', 'u2'),
            staff(3, 'Gamma', 'Server', 'u3'),
          ],
          availability: [
            avail('u1', [], true),
            avail('u2', [], true),
            avail('u3', [], true),
          ],
          requirements: [
            req(1, 'Server', 1),
            req(2, 'Server', 1),
            req(3, 'Server', 1),
          ],
        },
        assert: (r) => {
          assert.equal(r.assignments.length, 3, 'All 3 shifts should be filled')
          assert.equal(r.gaps.length, 0, 'No gaps')
          // Each of the 3 people gets exactly 1 shift
          const counts = {}
          for (const a of r.assignments) {
            counts[a.staffId] = (counts[a.staffId] ?? 0) + 1
          }
          const values = Object.values(counts)
          assert.equal(values.length, 3, 'All 3 staff should be assigned')
          assert.ok(values.every(v => v === 1), `Fairness violated: ${JSON.stringify(counts)}`)
        },
      },
    ]

    // Run ALL scenarios in parallel
    const results = await Promise.all(
      scenarios.map(s => runScenario(s.name, s.data, s.assert))
    )

    const failures = results.filter(r => !r.passed)
    if (failures.length > 0) {
      assert.fail(
        `${failures.length} scenario(s) failed:\n\n` +
        failures.map(f => `❌ ${f.name}:\n   ${f.error}`).join('\n\n')
      )
    }
  })

})

// ── formatScheduleMessage tests ───────────────────────────────────────────────

describe('Schedule Formatting', () => {

  test('formatScheduleMessage produces valid telegram markdown', async () => {
    const mockData = {
      shifts: [
        shift(1, 'Monday Morning', 'Monday', '9:00 AM', '1:00 PM'),
        shift(2, 'Wednesday Evening', 'Wednesday', '5:00 PM', '9:00 PM'),
      ],
      staff: [
        staff(1, 'Alice', 'Server', 'u1'),
        staff(2, 'Carlos', 'Cook', 'u2'),
      ],
      availability: [
        avail('u1', [], true),
        avail('u2', [], true),
      ],
      requirements: [
        req(1, 'Server', 1),
        req(2, 'Cook', 1),
      ],
    }

    const result = await generateWeeklySchedule('test_group', WEEK, mockData)
    const formatted = formatScheduleMessage(result.assignments, result.gaps, WEEK)

    assert.ok(typeof formatted === 'string', 'Should return a string')
    assert.ok(formatted.includes('Schedule'), 'Should include "Schedule" header')
    assert.ok(formatted.includes('Monday') || formatted.includes('Wednesday'), 'Should include day names')
    assert.ok(formatted.length > 50, 'Should have substantial content')

    // Should not have unclosed markdown bold markers
    const boldCount = (formatted.match(/\*/g) ?? []).length
    assert.equal(boldCount % 2, 0, 'All *bold* markers should be paired')
  })

  test('formatScheduleMessage shows gaps section when understaffed', async () => {
    const mockData = {
      shifts: [shift(1, 'Saturday Lunch', 'Saturday')],
      staff: [],
      availability: [],
      requirements: [req(1, 'Chef', 2)],
    }

    const result = await generateWeeklySchedule('test_group', WEEK, mockData)
    const formatted = formatScheduleMessage(result.assignments, result.gaps, WEEK)

    assert.ok(formatted.includes('⚠️'), 'Should show warning for unfilled positions')
    assert.ok(formatted.toLowerCase().includes('unfilled') || formatted.toLowerCase().includes('gap') || formatted.toLowerCase().includes('need'),
      'Should describe what is unfilled')
  })

  test('empty schedule has helpful message, not just blank output', async () => {
    const mockData = {
      shifts: [shift(1, 'Monday', 'Monday')],
      staff: [staff(1, 'Alice', 'Server', 'u1')],
      availability: [avail('u1', [], false, true)], // Alice is unavailable
      requirements: [req(1, 'Server', 1)],
    }

    const result = await generateWeeklySchedule('test_group', WEEK, mockData)
    const formatted = formatScheduleMessage([], result.gaps, WEEK)

    assert.ok(formatted.length > 30, 'Should have content even with 0 assignments')
    assert.ok(
      formatted.toLowerCase().includes('no shift') ||
      formatted.toLowerCase().includes('check') ||
      formatted.includes('⚠️'),
      `Empty schedule should give guidance. Got:\n${formatted}`
    )
  })
})
