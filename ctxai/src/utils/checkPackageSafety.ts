/**
 * checkPackageSafety.ts
 *
 * Tool 3: check_package_safety
 *
 * Checks every package the AI suggests against three layers of safety:
 *
 *   Layer 1 — Existence check
 *     Does this package actually exist on npm / PyPI?
 *     If not → PHANTOM_PACKAGE (slopsquatting attack vector)
 *
 *   Layer 2 — Typosquat / conflation check
 *     Is this package suspiciously similar to a popular one?
 *     Was it possibly a hallucination that a threat actor registered?
 *     → LIKELY_TYPOSQUAT or LIKELY_CONFLATION
 *
 *   Layer 3 — Trust signal check
 *     Even if the package exists and isn't a typosquat:
 *     Is it brand new? Does it have almost no downloads?
 *     No repository link? Suspicious description?
 *     → LOW_TRUST_PACKAGE
 *
 * All three layers run in parallel per package.
 * Multiple packages checked in parallel with each other.
 *
 * This tool is designed to be called AFTER validateSuggestion —
 * validateSuggestion checks your installed packages,
 * checkPackageSafety checks NEW packages the AI wants you to install.
 */

import { parseResponse } from "../parser/responseParser.js"
import { fetchNpmPackage, fetchPypiPackage } from "./registryClient.js"
import {
  detectTyposquat,
  detectConflation,
} from "./typosquatDetector.js"
import { sessionCache } from "../cache/sessionCache.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SafetyIssueType =
  | "PHANTOM_PACKAGE"     // does not exist on registry
  | "LIKELY_TYPOSQUAT"    // edit distance 1-2 from popular package
  | "LIKELY_CONFLATION"   // name combines two popular package names
  | "LOW_TRUST_PACKAGE"   // exists but has suspicious trust signals
  | "SECURITY_HOLD"       // package is under a security hold on npm

export type IssueSeverity = "critical" | "warning" | "info"

export interface SafetyIssue {
  type: SafetyIssueType
  severity: IssueSeverity
  packageName: string
  ecosystem: "node" | "python"
  message: string
  suggestion: string
  /** Extra data for the UI — only present on relevant issue types */
  meta?: {
    similarTo?: string
    editDistance?: number
    ageInDays?: number
    versionCount?: number
    hasRepository?: boolean
  }
}

export interface SafetyCheckResult {
  /** Packages that were checked */
  checked: string[]
  /** All issues found across all packages */
  issues: SafetyIssue[]
  /** Whether any critical issues were found */
  hasCritical: boolean
  /** Whether any warnings were found */
  hasWarnings: boolean
  /** Summary for display */
  summary: string
}

// ---------------------------------------------------------------------------
// Trust signal thresholds
// ---------------------------------------------------------------------------

/**
 * A package published less than this many days ago is suspicious.
 * Legitimate utility packages take time to accumulate history.
 */
const SUSPICIOUS_AGE_DAYS = 30

/**
 * A package with fewer versions than this is suspicious for a
 * widely-used-looking package name.
 */
const SUSPICIOUS_VERSION_COUNT = 2

/**
 * npm description that signals a security hold.
 * npm puts problem packages under a security hold with this description.
 */
const NPM_SECURITY_HOLD_DESCRIPTION = "security holding package"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysSince(isoDate: string): number {
  return Math.floor(
    (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24),
  )
}

/**
 * Parses the fingerprint to extract a Set of known package names.
 * Used to skip packages the developer already has installed.
 */
function parseInstalledNames(fingerprint: string): {
  names: Set<string>
  hasNodePackages: boolean
  hasPythonPackages: boolean
} {
  const names = new Set<string>()
  let hasNodePackages = false
  let hasPythonPackages = false

  for (const line of fingerprint.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const colonIdx = trimmed.indexOf(": ")
    if (colonIdx === -1) continue

    const source = trimmed.slice(0, colonIdx).toLowerCase()
    const packageToken = trimmed.slice(colonIdx + 2).trim()
    const lastAt = packageToken.lastIndexOf("@")
    if (lastAt <= 0) continue

    const pkgName = packageToken.slice(0, lastAt).toLowerCase()
    names.add(pkgName)

    // Also add scope alias: @prisma/client → prisma
    if (pkgName.startsWith("@")) {
      const scopeName = pkgName.split("/")[0].replace("@", "")
      names.add(scopeName)
    }

    if (source === "node") hasNodePackages = true
    if (source === "python") hasPythonPackages = true
  }

  return { names, hasNodePackages, hasPythonPackages }
}

// ---------------------------------------------------------------------------
// Per-package safety check
// ---------------------------------------------------------------------------

async function checkOnPackage(
  packageName: string,
  ecosystem: "node" | "python",
): Promise<SafetyIssue[]> {
  const issues: SafetyIssue[] = []

  // ── Cache check ──────────────────────────────────────────────────────────
  const cacheKey = `safety:${ecosystem}:${packageName}`
  const cached = sessionCache.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached.fingerprint) as SafetyIssue[]
    } catch {
      // corrupted — fall through
    }
  }

  // ── Fetch registry data ──────────────────────────────────────────────────
  const registryData =
    ecosystem === "node"
      ? await fetchNpmPackage(packageName)
      : await fetchPypiPackage(packageName)

  // ── Layer 1: Existence check ─────────────────────────────────────────────
  if (!registryData) {
    // Package does not exist on the registry.
    // Check if it looks like a typosquat of something that DOES exist.
    const typosquat = detectTyposquat(packageName, ecosystem)
    const conflation = detectConflation(packageName, ecosystem)

    if (typosquat) {
      issues.push({
        type: "PHANTOM_PACKAGE",
        severity: "critical",
        packageName,
        ecosystem,
        message: `'${packageName}' does not exist on ${ecosystem === "node" ? "npm" : "PyPI"} and looks like a hallucination of '${typosquat.target}' (edit distance: ${typosquat.distance}).`,
        suggestion: `Do NOT run install. The AI likely hallucinated this package name. Use '${typosquat.target}' instead, or verify the correct package name in the official docs.`,
        meta: {
          similarTo: typosquat.target,
          editDistance: typosquat.distance,
        },
      })
    } else if (conflation.isConflation) {
      issues.push({
        type: "PHANTOM_PACKAGE",
        severity: "critical",
        packageName,
        ecosystem,
        message: `'${packageName}' does not exist and appears to be a hallucinated conflation of '${conflation.components.join("' and '")}'.`,
        suggestion: `Do NOT run install. The AI invented this package name by combining real package names. Install '${conflation.components.join("' and '")}' separately.`,
      })
    } else {
      issues.push({
        type: "PHANTOM_PACKAGE",
        severity: "critical",
        packageName,
        ecosystem,
        message: `'${packageName}' does not exist on ${ecosystem === "node" ? "npm" : "PyPI"}.`,
        suggestion: `Do NOT run install. Verify the correct package name in the official documentation before installing.`,
      })
    }

    sessionCache.set(cacheKey, { fingerprint: JSON.stringify(issues), packageCount: issues.length, timestamp: Date.now() })
    return issues
  }

  // ── Layer 2: Typosquat / conflation check ────────────────────────────────
  // Package exists — but might be a registered typosquat
  const typosquat = detectTyposquat(packageName, ecosystem)
  if (typosquat) {
    issues.push({
      type: "LIKELY_TYPOSQUAT",
      severity: "critical",
      packageName,
      ecosystem,
      message: `'${packageName}' exists on the registry but is suspiciously similar to '${typosquat.target}' (edit distance: ${typosquat.distance}). This is a known typosquatting pattern.`,
      suggestion: `Verify you meant '${typosquat.target}'. If you intentionally want '${packageName}', inspect its source code and maintainers before installing.`,
      meta: {
        similarTo: typosquat.target,
        editDistance: typosquat.distance,
      },
    })
  }

  const conflation = detectConflation(packageName, ecosystem)
  if (conflation.isConflation && !typosquat) {
    issues.push({
      type: "LIKELY_CONFLATION",
      severity: "warning",
      packageName,
      ecosystem,
      message: `'${packageName}' exists but its name combines '${conflation.components.join("' and '")}', which is a common AI hallucination pattern.`,
      suggestion: `Verify this is the package you intended. It may be a registered slopsquat of a hallucinated name.`,
    })
  }

  // ── Layer 3: Trust signal check ──────────────────────────────────────────

  // Check npm security hold
  if (
    ecosystem === "node" &&
    "description" in registryData &&
    typeof registryData.description === "string" &&
    registryData.description
      .toLowerCase()
      .includes(NPM_SECURITY_HOLD_DESCRIPTION)
  ) {
    issues.push({
      type: "SECURITY_HOLD",
      severity: "critical",
      packageName,
      ecosystem,
      message: `'${packageName}' is under an npm security hold.`,
      suggestion: `Do NOT install this package. npm has flagged it as a security risk.`,
    })
    sessionCache.set(cacheKey, { fingerprint: JSON.stringify(issues), packageCount: issues.length, timestamp: Date.now() })
    return issues
  }

  // Age check — how old is the package?
  const createdAt =
    ecosystem === "node"
      ? (registryData as { created: string }).created
      : undefined

  const ageInDays = createdAt ? daysSince(createdAt) : undefined

  // Version count — how many versions has it had?
  const versionCount =
    ecosystem === "node"
      ? (registryData as { versionCount: number }).versionCount
      : (registryData as { releaseCount: number }).releaseCount

  // Repository link
  const hasRepository =
    ecosystem === "node"
      ? (registryData as { hasRepository: boolean }).hasRepository
      : (registryData as { hasHomePage: boolean }).hasHomePage

  // Combine trust signals into a single low-trust warning
  const trustIssues: string[] = []
  const trustMeta: SafetyIssue["meta"] = {}

  if (ageInDays !== undefined && ageInDays < SUSPICIOUS_AGE_DAYS) {
    trustIssues.push(`published ${ageInDays} days ago`)
    trustMeta.ageInDays = ageInDays
  }

  if (versionCount < SUSPICIOUS_VERSION_COUNT) {
    trustIssues.push(`only ${versionCount} version${versionCount === 1 ? "" : "s"}`)
    trustMeta.versionCount = versionCount
  }

  if (!hasRepository) {
    trustIssues.push("no repository or homepage link")
    trustMeta.hasRepository = false
  }

  // Only fire LOW_TRUST if we have 2+ signals — single signals are too noisy
  if (trustIssues.length >= 2) {
    issues.push({
      type: "LOW_TRUST_PACKAGE",
      severity: "warning",
      packageName,
      ecosystem,
      message: `'${packageName}' has low trust signals: ${trustIssues.join(", ")}.`,
      suggestion: `Inspect this package carefully before installing — review its source code, maintainer history, and download counts on ${ecosystem === "node" ? "npmjs.com" : "pypi.org"}.`,
      meta: trustMeta,
    })
  }

  sessionCache.set(cacheKey, { fingerprint: JSON.stringify(issues), packageCount: issues.length, timestamp: Date.now() })
  return issues
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Checks all NEW packages suggested by the AI for safety issues.
 *
 * "New" means not already present in the project fingerprint.
 * Packages the developer already has installed are skipped —
 * they've already made that trust decision.
 *
 * All packages are checked in parallel for minimum latency.
 *
 * @param code               Raw AI response text
 * @param contextFingerprint Project fingerprint from getProjectContext
 * @returns                  SafetyCheckResult with all issues found
 */
export async function checkPackageSafety(
  code: string,
  contextFingerprint: string,
): Promise<SafetyCheckResult> {

  // Parse what's already installed
  const { names: installedNames, hasNodePackages, hasPythonPackages } =
    parseInstalledNames(contextFingerprint)

  // Extract imports that aren't already installed
  const identifiers = parseResponse(code)
  const newPackages: Array<{ name: string; ecosystem: "node" | "python" }> = []
  const seen = new Set<string>()

  for (const id of identifiers) {
    if (id.type !== "import") continue
    const nameLower = id.name.toLowerCase()
    if (seen.has(nameLower)) continue
    if (installedNames.has(nameLower)) continue
    seen.add(nameLower)

    // Determine ecosystem from fingerprint context
    // If fingerprint has python packages and no node packages → python
    // If fingerprint has node packages → node
    // Mixed fingerprint → use heuristics (scoped = node, underscore = python)
    let ecosystem: "node" | "python"
    if (hasPythonPackages && !hasNodePackages) {
      ecosystem = "python"
    } else if (hasNodePackages && !hasPythonPackages) {
      ecosystem = "node"
    } else {
      // Mixed project — use naming heuristics
      ecosystem = id.name.startsWith("@") || id.name.includes("-")
        ? "node"
        : "python"
    }

    newPackages.push({ name: id.name, ecosystem })
  }

  if (newPackages.length === 0) {
    return {
      checked: [],
      issues: [],
      hasCritical: false,
      hasWarnings: false,
      summary: "All packages in the suggestion are already in your dependencies.",
    }
  }

  // Check all new packages in parallel
  const results = await Promise.all(
    newPackages.map((pkg) => checkOnPackage(pkg.name, pkg.ecosystem)),
  )

  const allIssues = results.flat()
  const hasCritical = allIssues.some((i) => i.severity === "critical")
  const hasWarnings = allIssues.some((i) => i.severity === "warning")

  // Build human-readable summary
  let summary: string
  if (allIssues.length === 0) {
    summary = `Checked ${newPackages.length} new package${newPackages.length === 1 ? "" : "s"} — no safety issues found.`
  } else {
    const critCount = allIssues.filter((i) => i.severity === "critical").length
    const warnCount = allIssues.filter((i) => i.severity === "warning").length
    const parts: string[] = []
    if (critCount > 0) parts.push(`${critCount} critical issue${critCount === 1 ? "" : "s"}`)
    if (warnCount > 0) parts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`)
    summary = `Found ${parts.join(" and ")} across ${newPackages.length} new package${newPackages.length === 1 ? "" : "s"}.`
  }

  return {
    checked: newPackages.map((p) => p.name),
    issues: allIssues,
    hasCritical,
    hasWarnings,
    summary,
  }
}