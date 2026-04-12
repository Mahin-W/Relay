import { logger } from '../logger.js'

/**
 * Get shift outcome history for a group, scoring each shift instance 0-100.
 * @param {string} groupId
 * @param {number} weeksBack - how many weeks of history to look at
 * @param {object|null} db - injected DB adapter
 * @returns {Array<{shiftId, shiftName, dayOfWeek, weekStart, staffIds, shiftScore, issues, positives}>}
 */
export async function getShiftOutcomeHistory(groupId, weeksBack = 8, db = null) {
  const _getPublishedAssignments = db?.getPublishedAssignments
  const _getShiftsForGroup = db?.getShiftsForGroup
  const _getCoverageRequestsForGroup = db?.getCoverageRequestsForGroup
  const _getReliabilityEventsForGroup = db?.getReliabilityEventsForGroup
  const _getRecognitionEventsForGroup = db?.getRecognitionEventsForGroup

  if (!_getPublishedAssignments || !_getShiftsForGroup) {
    logger.warn('pairingOptimizer: missing db functions')
    return []
  }

  const [assignments, shifts, coverageReqs, reliabilityEvents, recognitionEvents] = await Promise.all([
    _getPublishedAssignments(groupId, weeksBack),
    _getShiftsForGroup(groupId),
    _getCoverageRequestsForGroup ? _getCoverageRequestsForGroup(groupId, weeksBack) : [],
    _getReliabilityEventsForGroup ? _getReliabilityEventsForGroup(groupId, weeksBack) : [],
    _getRecognitionEventsForGroup ? _getRecognitionEventsForGroup(groupId, weeksBack) : [],
  ])

  if (!assignments.length || !shifts.length) return []

  // Build shift lookup
  const shiftMap = {}
  for (const s of shifts) {
    shiftMap[s.id] = s
  }

  // Group assignments by shift_id + week_start
  const grouped = {}
  for (const a of assignments) {
    const key = `${a.shift_id}::${a.week_start}`
    if (!grouped[key]) {
      const shift = shiftMap[a.shift_id]
      if (!shift) continue
      grouped[key] = {
        shiftId: a.shift_id,
        shiftName: shift.name,
        dayOfWeek: shift.day_of_week,
        weekStart: a.week_start,
        staffIds: [],
      }
    }
    grouped[key].staffIds.push(a.staff_id)
  }

  // Score each shift instance
  const results = []
  for (const entry of Object.values(grouped)) {
    let score = 80
    const issues = []
    const positives = []

    // Coverage requests on this shift in this week
    const weekDate = new Date(entry.weekStart)
    const weekEnd = new Date(weekDate)
    weekEnd.setDate(weekEnd.getDate() + 7)

    for (const cr of coverageReqs) {
      if (cr.matched_shift_id !== entry.shiftId) continue
      const crDate = new Date(cr.created_at)
      if (crDate >= weekDate && crDate < weekEnd) {
        score -= 20
        issues.push('coverage_request')
      }
    }

    // Reliability events for staff on this shift in this week
    for (const re of reliabilityEvents) {
      if (!entry.staffIds.includes(re.staff_id)) continue
      const reDate = new Date(re.recorded_at)
      if (reDate >= weekDate && reDate < weekEnd) {
        if (re.event_type === 'late_arrival') {
          score -= 10
          issues.push('late_arrival')
        } else if (re.event_type === 'no_call_no_show') {
          score -= 30
          issues.push('no_call_no_show')
        }
      }
    }

    // Recognition events for staff on this shift in this week
    let recognitionBonus = 0
    for (const re of recognitionEvents) {
      if (!entry.staffIds.includes(re.recipient_staff_id)) continue
      const reDate = new Date(re.created_at)
      if (reDate >= weekDate && reDate < weekEnd) {
        recognitionBonus += 10
        positives.push('recognition')
      }
    }
    score += Math.min(recognitionBonus, 20) // cap at +20

    // Clamp 0-100
    score = Math.max(0, Math.min(100, score))

    results.push({
      shiftId: entry.shiftId,
      shiftName: entry.shiftName,
      dayOfWeek: entry.dayOfWeek,
      weekStart: entry.weekStart,
      staffIds: entry.staffIds,
      shiftScore: score,
      issues,
      positives,
    })
  }

  return results
}

/**
 * Analyze pair outcomes from shift history. Pure function.
 * @param {Array} shiftHistory - output of getShiftOutcomeHistory
 * @param {Object} staffNames - { staffId: name }
 * @returns {Array<{staffIdA, staffIdB, nameA, nameB, shiftsTogether, avgScoreTogether, avgScoreApart, pairingBenefit, pairingValue}>}
 */
export function analyzePairOutcomes(shiftHistory, staffNames) {
  if (!shiftHistory || !shiftHistory.length) return []

  // Collect all unique staff IDs
  const allStaff = new Set()
  for (const entry of shiftHistory) {
    for (const sid of entry.staffIds) {
      allStaff.add(sid)
    }
  }
  const staffList = [...allStaff]
  if (staffList.length < 2) return []

  // For each pair, track scores together and apart
  const pairData = {}

  for (let i = 0; i < staffList.length; i++) {
    for (let j = i + 1; j < staffList.length; j++) {
      const a = staffList[i]
      const b = staffList[j]
      const key = `${a}::${b}`
      pairData[key] = { staffIdA: a, staffIdB: b, together: [], apartA: [], apartB: [] }
    }
  }

  for (const entry of shiftHistory) {
    const ids = entry.staffIds

    for (let i = 0; i < staffList.length; i++) {
      for (let j = i + 1; j < staffList.length; j++) {
        const a = staffList[i]
        const b = staffList[j]
        const key = `${a}::${b}`
        const hasA = ids.includes(a)
        const hasB = ids.includes(b)

        if (hasA && hasB) {
          pairData[key].together.push(entry.shiftScore)
        } else if (hasA && !hasB) {
          pairData[key].apartA.push(entry.shiftScore)
        } else if (!hasA && hasB) {
          pairData[key].apartB.push(entry.shiftScore)
        }
      }
    }
  }

  const results = []
  for (const pd of Object.values(pairData)) {
    if (pd.together.length < 3) continue

    const avgScoreTogether = pd.together.reduce((a, b) => a + b, 0) / pd.together.length
    const apartScores = [...pd.apartA, ...pd.apartB]
    const avgScoreApart = apartScores.length > 0
      ? apartScores.reduce((a, b) => a + b, 0) / apartScores.length
      : avgScoreTogether // if no apart data, neutral

    const pairingBenefit = avgScoreTogether - avgScoreApart
    let pairingValue = 'neutral'
    if (pairingBenefit >= 10) pairingValue = 'positive'
    else if (pairingBenefit <= -10) pairingValue = 'negative'

    results.push({
      staffIdA: pd.staffIdA,
      staffIdB: pd.staffIdB,
      nameA: staffNames[pd.staffIdA] || `Staff ${pd.staffIdA}`,
      nameB: staffNames[pd.staffIdB] || `Staff ${pd.staffIdB}`,
      shiftsTogether: pd.together.length,
      avgScoreTogether: Math.round(avgScoreTogether * 100) / 100,
      avgScoreApart: Math.round(avgScoreApart * 100) / 100,
      pairingBenefit: Math.round(pairingBenefit * 100) / 100,
      pairingValue,
    })
  }

  return results
}

/**
 * Get pairing recommendations for a group.
 * @param {string} groupId
 * @param {number} weeksBack
 * @param {object|null} db
 * @returns {{positivePairs: Array, negativePairs: Array}}
 */
export async function getPairingRecommendations(groupId, weeksBack = 8, db = null) {
  const history = await getShiftOutcomeHistory(groupId, weeksBack, db)
  if (!history.length) return { positivePairs: [], negativePairs: [] }

  // Build staff names map from db
  const staffList = db?.getStaffForGroup ? await db.getStaffForGroup(groupId) : []
  const staffNames = {}
  for (const s of staffList) {
    staffNames[s.id] = s.name
  }

  const pairs = analyzePairOutcomes(history, staffNames)

  const positivePairs = pairs.filter(p => p.pairingValue === 'positive' && p.shiftsTogether >= 3)
  const negativePairs = pairs.filter(p => p.pairingValue === 'negative' && p.shiftsTogether >= 3)

  return { positivePairs, negativePairs }
}

/**
 * Apply pairing optimization to assignments. Pure function, NO DB.
 * @param {Array} assignments - assignment objects
 * @param {{positivePairs: Array, negativePairs: Array}} pairingData
 * @returns {{newAssignments: Array, applied: Array}}
 */
export function applyPairingOptimization(assignments, pairingData) {
  if (!assignments || !assignments.length) {
    return { newAssignments: [], applied: [] }
  }

  const newAssignments = assignments.map(a => ({ ...a }))
  const applied = []

  if (!pairingData?.negativePairs?.length) {
    return { newAssignments, applied }
  }

  // Group assignments by dayOfWeek + shiftId
  const shiftGroups = {}
  for (let i = 0; i < newAssignments.length; i++) {
    const a = newAssignments[i]
    const key = `${a.dayOfWeek}::${a.shiftId}`
    if (!shiftGroups[key]) shiftGroups[key] = []
    shiftGroups[key].push(i) // store indices
  }

  // For each negative pair, check if they're on the same shift+day
  for (const neg of pairingData.negativePairs) {
    // Find shifts where both are assigned
    for (const [key, indices] of Object.entries(shiftGroups)) {
      const staffOnShift = indices.map(i => newAssignments[i].staffId)
      if (!staffOnShift.includes(neg.staffIdA) || !staffOnShift.includes(neg.staffIdB)) continue

      // Both are on this shift — need > 2 staff for a meaningful swap
      if (indices.length <= 1) continue

      const dayOfWeek = newAssignments[indices[0]].dayOfWeek
      const shiftName = newAssignments[indices[0]].shiftName

      // Find the index of one member of the negative pair to swap out
      const swapOutIdx = indices.find(i => newAssignments[i].staffId === neg.staffIdA)
      if (swapOutIdx === undefined) continue
      const swapOutAssignment = newAssignments[swapOutIdx]

      // Find candidate shifts on the same day (different shift)
      let swapped = false
      for (const [otherKey, otherIndices] of Object.entries(shiftGroups)) {
        if (otherKey === key) continue
        const otherDay = newAssignments[otherIndices[0]].dayOfWeek
        if (otherDay !== dayOfWeek) continue

        // Find a swap candidate with same role
        for (const otherIdx of otherIndices) {
          const candidate = newAssignments[otherIdx]
          if (candidate.roleName !== swapOutAssignment.roleName) continue

          // Make sure swapping doesn't create a new negative pair
          const wouldCreateNegative = pairingData.negativePairs.some(np => {
            // Check if candidate would be negative-paired with anyone on source shift
            const remainingOnSource = indices
              .filter(i => i !== swapOutIdx)
              .map(i => newAssignments[i].staffId)
            return remainingOnSource.some(
              sid => (np.staffIdA === candidate.staffId && np.staffIdB === sid) ||
                     (np.staffIdB === candidate.staffId && np.staffIdA === sid)
            )
          })
          if (wouldCreateNegative) continue

          // Also check swapOut wouldn't be negative-paired on destination
          const destStaff = otherIndices
            .filter(i => i !== otherIdx)
            .map(i => newAssignments[i].staffId)
          const wouldCreateNegOnDest = pairingData.negativePairs.some(np => {
            return destStaff.some(
              sid => (np.staffIdA === swapOutAssignment.staffId && np.staffIdB === sid) ||
                     (np.staffIdB === swapOutAssignment.staffId && np.staffIdA === sid)
            )
          })
          if (wouldCreateNegOnDest) continue

          // Perform swap
          const tempShiftId = swapOutAssignment.shiftId
          const tempShiftName = swapOutAssignment.shiftName
          const tempStartTime = swapOutAssignment.startTime
          const tempEndTime = swapOutAssignment.endTime

          newAssignments[swapOutIdx].shiftId = candidate.shiftId
          newAssignments[swapOutIdx].shiftName = candidate.shiftName
          newAssignments[swapOutIdx].startTime = candidate.startTime
          newAssignments[swapOutIdx].endTime = candidate.endTime

          newAssignments[otherIdx].shiftId = tempShiftId
          newAssignments[otherIdx].shiftName = tempShiftName
          newAssignments[otherIdx].startTime = tempStartTime
          newAssignments[otherIdx].endTime = tempEndTime

          applied.push({
            type: 'separated_pair',
            nameA: neg.nameA,
            nameB: neg.nameB,
            shiftName,
            reason: 'better outcomes when apart',
          })

          // Update shiftGroups after swap
          shiftGroups[key] = indices.filter(i => i !== swapOutIdx)
          shiftGroups[key].push(otherIdx)
          shiftGroups[otherKey] = otherIndices.filter(i => i !== otherIdx)
          shiftGroups[otherKey].push(swapOutIdx)

          swapped = true
          break
        }
        if (swapped) break
      }
    }
  }

  return { newAssignments, applied }
}

/**
 * Format pairing insight for manager message. Pure function.
 * @param {Array|null} applied - array of applied optimizations
 * @returns {string|null}
 */
export function formatPairingInsight(applied) {
  if (!applied || !applied.length) return null

  const lines = ['\u{1F91D} *Pairing optimization applied:*']

  for (const a of applied) {
    if (a.type === 'kept_positive') {
      lines.push(`${a.nameA} + ${a.nameB} kept together on ${a.shiftName}`)
      lines.push(`(${a.reason})`)
    } else if (a.type === 'separated_pair') {
      lines.push(`${a.nameA} + ${a.nameB} separated on ${a.shiftName}`)
      lines.push(`(${a.reason})`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
