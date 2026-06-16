import {
  saveShift,
  saveShiftRequirement,
  saveStaff,
  updateRoleRate,
  saveOvertimeSettings,
  saveTipSettings,
  updateSetupSession,
} from './setupDb.js'
import { logger } from '../logger.js'

// Populate a group's setup tables from the staging data collected on the web
// (accounts.setup_data) during account signup. Reuses the existing group-keyed
// writers so the bot's operational code stays untouched.
//
// Expected staging shape (all keys optional):
//   {
//     restaurant_name, phone,
//     shifts:     [{ name, day_of_week, start_time, end_time, requirements:[{role,count}] }],
//     staff:      [{ name, role }],
//     role_rates: [{ role_name, hourly_rate }],
//     overtime:   { overtime_enabled, weekly_threshold, weekly_multiplier,
//                   daily_overtime_enabled, daily_threshold, daily_multiplier },
//     tips:       { mode, split_method, boh_included }
//   }
//
// Returns a summary the caller uses to decide which steps (if any) still need to
// be asked in Telegram.
export async function mergeFromAccount(groupId, account) {
  const data = account?.setup_data || {}
  const summary = { hasShifts: false, hasStaff: false, hasRates: false, restaurantName: data.restaurant_name || null }

  try {
    // Restaurant name + phone onto the session's setup_data.
    const sessionPatch = {}
    if (data.restaurant_name) sessionPatch.setup_data = { restaurant_name: data.restaurant_name }
    if (data.phone) sessionPatch.phone = data.phone
    if (Object.keys(sessionPatch).length) {
      await updateSetupSession(groupId, sessionPatch)
    }

    // Shifts (+ per-shift role requirements).
    if (Array.isArray(data.shifts) && data.shifts.length) {
      for (const s of data.shifts) {
        const shift = await saveShift(groupId, s.name, s.day_of_week, s.start_time ?? null, s.end_time ?? null)
        if (shift?.id && Array.isArray(s.requirements)) {
          for (const r of s.requirements) {
            if (r?.role) await saveShiftRequirement(shift.id, r.role, r.count ?? 1)
          }
        }
      }
      summary.hasShifts = true
    }

    // Staff roster.
    if (Array.isArray(data.staff) && data.staff.length) {
      for (const m of data.staff) {
        if (m?.name) await saveStaff(groupId, m.name, m.role ?? 'Staff')
      }
      summary.hasStaff = true
    }

    // Role pay rates.
    if (Array.isArray(data.role_rates) && data.role_rates.length) {
      for (const r of data.role_rates) {
        if (r?.role_name != null) await updateRoleRate(groupId, r.role_name, Number(r.hourly_rate) || 0)
      }
      summary.hasRates = true
    }

    // Overtime settings.
    if (data.overtime && typeof data.overtime === 'object') {
      await saveOvertimeSettings(groupId, data.overtime)
    }

    // Tip settings (staging uses snake_case; writer expects camelCase).
    if (data.tips && typeof data.tips === 'object') {
      await saveTipSettings(groupId, {
        mode: data.tips.mode ?? 'pool',
        splitMethod: data.tips.split_method ?? 'hours',
        bohIncluded: data.tips.boh_included ?? false,
      })
    }

    logger.bot(`Merged account ${account.id} setup data into group ${groupId} (shifts=${summary.hasShifts}, staff=${summary.hasStaff})`)
    return summary
  } catch (err) {
    logger.error(`mergeFromAccount failed for group ${groupId}: ${err.message}`)
    return summary
  }
}
