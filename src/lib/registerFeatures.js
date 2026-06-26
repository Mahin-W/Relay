// Feature-registration bootstrap (Epic 0+).
//
// Single place that activates registry-based features (commandRegistry +
// intentRegistry). Called once at startup from index.js. The router consults
// the registries as an additive fallback, so nothing here changes behavior
// until a feature is registered.
//
// Only the Epic 4 compliance features are wired live today. Money-movement
// features (pay runs, bank onboarding, pay stubs) stay UNregistered until their
// payment providers are configured — exposing /paypeople etc. before then would
// mislead users (and live money movement is blocked-on-human).

import { logger } from '../logger.js'
import { registerComplianceFeature } from '../compliance/complianceFeature.js'
import { registerComplianceReportFeature } from '../compliance/complianceReportFeature.js'

let _registered = false

/** Register the live feature set. Idempotent. */
export function registerAllFeatures() {
  if (_registered) return
  _registered = true
  try {
    registerComplianceFeature()        // /setlocation + set_location intent
    registerComplianceReportFeature()  // /compliance, /complianceaudit + compliance_check intent
    logger.bot('Features registered: compliance (Epic 4)')
  } catch (err) {
    logger.error(`registerAllFeatures failed: ${err.message}`)
  }
}

/** Test helper — allow re-registration in unit tests. */
export function _resetFeatureBootstrapForTesting() { _registered = false }
