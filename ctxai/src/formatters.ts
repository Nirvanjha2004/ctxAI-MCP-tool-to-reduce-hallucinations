/**
 * formatters.ts
 *
 * Converts structured tool results into clean, readable strings for MCP responses.
 *
 * Each tool returns a typed object internally. The MCP protocol requires a plain
 * text string back to the LLM. These formatters are the bridge — they keep the
 * tool files clean and make the output easy for the LLM to parse and act on.
 */

import type { ProjectContextResult } from "./tools/getProjectContext.js"
import type { ValidationWarning } from "./tools/validateSuggestion.js"
import type { SafetyCheckResult, SafetyIssue } from "./utils/checkPackageSafety.js"

// ---------------------------------------------------------------------------
// Tool 1 — get_project_context
// ---------------------------------------------------------------------------

/**
 * Formats a ProjectContextResult into a string the LLM can read and use
 * as its version-awareness context for the rest of the conversation.
 */
export function formatProjectContext(result: ProjectContextResult): string {
  if (!result.success) {
    return [
      "⚠️  Project context could not be fully loaded.",
      result.error ? `Reason: ${result.error}` : "",
      "",
      result.fingerprint,
    ].filter(Boolean).join("\n")
  }

  const cacheNote = result.fromCache ? " (cached)" : ""
  return [
    `✅ Project context loaded — ${result.packageCount} package${result.packageCount === 1 ? "" : "s"} detected${cacheNote}.`,
    "",
    result.fingerprint,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Tool 2 — validate_suggestion
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<string, string> = {
  error:   "🔴",
  warning: "🟡",
  info:    "🔵",
}

const TYPE_LABEL: Record<string, string> = {
  MISSING_PACKAGE:    "Missing package",
  HALLUCINATED_METHOD: "Hallucinated method",
  UNKNOWN_PACKAGE:    "Unresolved package",
}

/**
 * Formats a ValidationWarning[] into a readable string.
 *
 * Clean code → short confirmation.
 * Issues found → grouped by severity with clear fix instructions.
 */
export function formatValidationWarnings(warnings: ValidationWarning[]): string {
  if (warnings.length === 0) {
    return "✅ No hallucinations detected. All imports and method calls match your installed environment."
  }

  const errors   = warnings.filter(w => w.severity === "error")
  const warns    = warnings.filter(w => w.severity === "warning")
  const infos    = warnings.filter(w => w.severity === "info")

  const lines: string[] = [
    `⚠️  Found ${warnings.length} issue${warnings.length === 1 ? "" : "s"} in the suggested code:`,
    "",
  ]

  for (const w of [...errors, ...warns, ...infos]) {
    const icon  = SEVERITY_ICON[w.severity] ?? "⚪"
    const label = TYPE_LABEL[w.type] ?? w.type
    lines.push(`${icon} [${label}] ${w.message}`)
    lines.push(`   → ${w.suggestion}`)
    lines.push("")
  }

  // Append a summary action line so the LLM knows what to do next
  if (errors.length > 0) {
    lines.push("The code above cannot run as-is. Fix the missing packages before using it.")
  } else if (warns.length > 0) {
    lines.push("The code may run but uses APIs that don't exist in your installed versions.")
  }

  return lines.join("\n").trimEnd()
}

// ---------------------------------------------------------------------------
// Tool 3 — check_package_safety
// ---------------------------------------------------------------------------

const SAFETY_ICON: Record<string, string> = {
  critical: "🚨",
  warning:  "⚠️ ",
  info:     "ℹ️ ",
}

const SAFETY_TYPE_LABEL: Record<string, string> = {
  PHANTOM_PACKAGE:   "Phantom package",
  LIKELY_TYPOSQUAT:  "Likely typosquat",
  LIKELY_CONFLATION: "Likely conflation",
  LOW_TRUST_PACKAGE: "Low trust",
  SECURITY_HOLD:     "Security hold",
}

/**
 * Formats a SafetyCheckResult into a readable string.
 *
 * No issues → short confirmation.
 * Issues found → each package listed with severity, type, and action.
 */
export function formatSafetyResult(result: SafetyCheckResult): string {
  if (result.checked.length === 0) {
    return "✅ No new packages to check — all imports are already in your dependencies."
  }

  if (result.issues.length === 0) {
    return `✅ ${result.summary}`
  }

  const lines: string[] = [
    `${result.hasCritical ? "🚨" : "⚠️ "} ${result.summary}`,
    "",
  ]

  // Group issues by package for readability
  const byPackage = new Map<string, SafetyIssue[]>()
  for (const issue of result.issues) {
    const list = byPackage.get(issue.packageName) ?? []
    list.push(issue)
    byPackage.set(issue.packageName, list)
  }

  for (const [pkgName, issues] of byPackage) {
    lines.push(`📦 ${pkgName}`)
    for (const issue of issues) {
      const icon  = SAFETY_ICON[issue.severity] ?? "⚪"
      const label = SAFETY_TYPE_LABEL[issue.type] ?? issue.type
      lines.push(`   ${icon} [${label}] ${issue.message}`)
      lines.push(`      → ${issue.suggestion}`)
    }
    lines.push("")
  }

  if (result.hasCritical) {
    lines.push("🛑 Do NOT install the flagged packages without manual verification.")
  }

  return lines.join("\n").trimEnd()
}
