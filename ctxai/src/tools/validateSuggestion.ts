/**
 * validateSuggestion.ts
 *
 * Tool 2: validate_suggestion
 *
 * Takes AI-generated code and a project fingerprint, then checks whether
 * every suggested package and method call actually exists in the developer's
 * installed environment. Returns structured warnings for anything hallucinated.
 *
 * Three checks in order:
 *   Layer 1 — Package existence    (is this package in their dependencies?)
 *   Layer 2 — Method existence     (does this method exist in their version?)
 *   Layer 3 — Closest alternative  (what did the AI probably mean?)
 */

import { parseResponse, type ExtractedIdentifier } from "../parser/responseParser.js"
import { getModuleApiSurface } from "../detectors/node.js"
import { getPythonApiSurface } from "../detectors/python.js"
import { getClosestMatch } from "../utils/fuzzy.js"
import { sessionCache } from "../cache/sessionCache.js"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WarningSeverity = "error" | "warning" | "info"

export interface ValidationWarning {
  /** MISSING_PACKAGE | HALLUCINATED_METHOD | UNKNOWN_PACKAGE */
  type: "MISSING_PACKAGE" | "HALLUCINATED_METHOD" | "UNKNOWN_PACKAGE"
  severity: WarningSeverity
  /** Human-readable description of the problem */
  message: string
  /** What the developer should do instead */
  suggestion: string
  /** The exact string from the AI response that triggered this warning */
  offender: string
  /** Package context if known */
  packageName?: string
  /** Installed version if known */
  installedVersion?: string
}

interface InstalledPackage {
  /** Exact version resolved from node_modules or pip, e.g. "3.15.2" */
  version: string
  /** "node" | "python" */
  source: "node" | "python"
  /**
   * Canonical package name as it appears in node_modules or site-packages.
   * May differ from the key used in package.json (e.g. "@prisma/client" vs "prisma").
   */
  canonical: string
}

// ---------------------------------------------------------------------------
// Fingerprint parsing
// ---------------------------------------------------------------------------

/**
 * Parses the project fingerprint string produced by getProjectContext.
 *
 * Expected format (one package per line):
 *   node: @prisma/client@3.15.2
 *   node: express@4.18.2
 *   python: fastapi@0.100.0
 *   python: requests@2.31.0
 *
 * Handles scoped packages correctly because we split on the LAST "@"
 * in the package+version token, not on ":" (which appears in scoped names).
 *
 * Returns a Map keyed by lowercase package name → InstalledPackage.
 * Also populates an alias map for common short-hand lookups
 * (e.g. "prisma" → "@prisma/client").
 */
function parseFingerprint(fingerprint: string): {
  installed: Map<string, InstalledPackage>
  aliases: Map<string, string>
} {
  const installed = new Map<string, InstalledPackage>()
  const aliases = new Map<string, string>()

  if (!fingerprint || !fingerprint.trim()) {
    return { installed, aliases }
  }

  for (const raw of fingerprint.split("\n")) {
    const line = raw.trim()
    if (!line) continue

    // Expected: "source: packageName@version"
    // source = "node" or "python"
    // We split on the first ": " only
    const colonIdx = line.indexOf(": ")
    if (colonIdx === -1) continue

    const source = line.slice(0, colonIdx).toLowerCase().trim()
    if (source !== "node" && source !== "python") continue

    const packageToken = line.slice(colonIdx + 2).trim()
    if (!packageToken) continue

    // Split on the LAST "@" to handle scoped packages like "@prisma/client@3.15.2"
    const lastAt = packageToken.lastIndexOf("@")
    if (lastAt <= 0) continue  // no version found or starts with "@" with no version

    const canonical = packageToken.slice(0, lastAt)
    const version = packageToken.slice(lastAt + 1)

    if (!canonical || !version) continue

    const key = canonical.toLowerCase()
    const pkg: InstalledPackage = {
      version,
      source: source as "node" | "python",
      canonical,
    }

    installed.set(key, pkg)

    // Build aliases for common short-hand names so method resolution works
    // when a variable named "prisma" actually maps to "@prisma/client"
    if (canonical.includes("/")) {
      // @scope/name → register "name" as alias too
      const shortName = canonical.split("/").pop()!.toLowerCase()
      if (!installed.has(shortName)) {
        aliases.set(shortName, key)
      }
    }

    // Python: register both underscore and hyphen versions
    if (source === "python") {
      const withHyphen = canonical.replace(/_/g, "-").toLowerCase()
      const withUnderscore = canonical.replace(/-/g, "_").toLowerCase()
      if (withHyphen !== key) aliases.set(withHyphen, key)
      if (withUnderscore !== key) aliases.set(withUnderscore, key)
    }
  }

  return { installed, aliases }
}

// ---------------------------------------------------------------------------
// Package resolution
// ---------------------------------------------------------------------------

/**
 * Given a raw name from an AI response (e.g. "prisma", "@prisma/client"),
 * find the matching InstalledPackage from the fingerprint map.
 *
 * Resolution order:
 *   1. Exact match (lowercase)
 *   2. Alias map (handles scoped package shorthands)
 *   3. No match → undefined
 *
 * We deliberately do NOT do substring matching (the old code did
 * `fullPkgName.includes(pkgName)` which was ambiguous and error-prone).
 */
function resolvePackage(
  name: string,
  installed: Map<string, InstalledPackage>,
  aliases: Map<string, string>,
): InstalledPackage | undefined {
  const key = name.toLowerCase().replace(/_/g, "-")

  // 1. Exact match
  if (installed.has(key)) return installed.get(key)!

  // 2. Alias lookup
  const aliasTarget = aliases.get(key)
  if (aliasTarget && installed.has(aliasTarget)) return installed.get(aliasTarget)!

  // 3. Python: try both _ and - variants
  const hyphenKey = key.replace(/_/g, "-")
  if (installed.has(hyphenKey)) return installed.get(hyphenKey)!
  const underscoreKey = key.replace(/-/g, "_")
  if (installed.has(underscoreKey)) return installed.get(underscoreKey)!

  return undefined
}

// ---------------------------------------------------------------------------
// API surface fetching with timeout
// ---------------------------------------------------------------------------

/**
 * Wraps a promise with a timeout. Returns undefined if the operation
 * takes longer than ms milliseconds, rather than hanging forever.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    const result = await Promise.race([promise, timeoutPromise])
    clearTimeout(timer!)
    return result
  } catch {
    clearTimeout(timer!)
    return undefined
  }
}

/**
 * Fetches the API surface (list of exported method names) for a package.
 * Results are cached in the session cache keyed by "api:{name}:{version}".
 *
 * Returns an empty array if:
 *   - The operation times out (5s limit)
 *   - The detector throws
 *   - No type definitions are found
 */
async function getApiSurface(
  pkg: InstalledPackage,
  projectPath: string,
): Promise<string[]> {
  const cacheKey = `api:${pkg.canonical}:${pkg.version}`

  // Check cache — stored as JSON string to support the generic cache interface
  const cached = sessionCache.get(cacheKey)
  if (cached) {
    try {
      const parsed = JSON.parse(cached.fingerprint)
      if (Array.isArray(parsed)) return parsed as string[]
    } catch {
      // corrupted cache entry — fall through to re-fetch
    }
  }

  let methods: string[] | undefined

  try {
    if (pkg.source === "node") {
      const modulePath = path.join(projectPath, "node_modules", pkg.canonical)
      methods = await withTimeout(getModuleApiSurface(modulePath), 5_000)
    } else if (pkg.source === "python") {
      methods = await withTimeout(getPythonApiSurface(pkg.canonical), 5_000)
    }
  } catch {
    // detector threw — treat as no data
  }

  const surface = methods && methods.length > 0 ? methods : []

  if (surface.length > 0) {
    sessionCache.set(cacheKey, {
      fingerprint: JSON.stringify(surface),
      packageCount: surface.length,
      timestamp: Date.now()
    })
  }

  return surface
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Validates AI-generated code against the developer's installed environment.
 *
 * @param code            Raw AI response text (may include prose + code blocks)
 * @param projectPath     Absolute path to the project root (where package.json lives)
 * @param contextFingerprint  The fingerprint string produced by getProjectContext
 * @returns               Array of ValidationWarnings, empty if everything looks correct
 */
export async function validateSuggestion(
  code: string,
  projectPath: string,
  contextFingerprint: string,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []

  // Parse fingerprint into a structured map
  const { installed, aliases } = parseFingerprint(contextFingerprint)
  // If we have no fingerprint data, we can't validate anything — return early
  // rather than emitting false positives
  if (installed.size === 0) return warnings

  // Extract all identifiers from the AI response
  const identifiers: ExtractedIdentifier[] = parseResponse(code)

  // Track which packages we've already warned about being missing
  // to avoid duplicate MISSING_PACKAGE warnings
  const warnedMissing = new Set<string>()

  // ── Layer 1: Package existence ──────────────────────────────────────────
  for (const id of identifiers) {
    if (id.type !== "import") continue

    const pkg = resolvePackage(id.name, installed, aliases)
    if (pkg) continue  // found — no warning needed

    if (warnedMissing.has(id.name)) continue
    warnedMissing.add(id.name)

    warnings.push({
      type: "MISSING_PACKAGE",
      severity: "error",
      message: `'${id.name}' is not listed in your project dependencies.`,
      suggestion: `Run 'npm install ${id.name}' or 'pip install ${id.name}' to add it, or check if the package name has changed.`,
      offender: id.name,
    })
  }

  // ── Layer 2: Method existence ────────────────────────────────────────────
  // Group method_call identifiers by their context (root variable name)
  // so we only fetch the API surface once per package per validation run
  const methodsByContext = new Map<string, ExtractedIdentifier[]>()
  for (const id of identifiers) {
    if (id.type !== "method_call" || !id.context) continue
    const list = methodsByContext.get(id.context) ?? []
    list.push(id)
    methodsByContext.set(id.context, list)
  }

  for (const [context, methods] of methodsByContext) {
    // Resolve the context variable name to an installed package
    const pkg = resolvePackage(context, installed, aliases)
    if (!pkg) {
      // We can't validate method calls when we don't know the package.
      // Emit a low-severity info warning rather than a false positive error.
      // Only warn once per context variable.
      warnings.push({
        type: "UNKNOWN_PACKAGE",
        severity: "info",
        message: `Could not resolve '${context}' to an installed package. Method calls on it cannot be validated.`,
        suggestion: `If '${context}' is from an installed package, make sure it appears in your dependencies.`,
        offender: context,
      })
      continue
    }

    // Fetch the API surface for this package (with caching + timeout)
    const surface = await getApiSurface(pkg, projectPath)

    // If we got no surface data (no .d.ts files, type stubs, etc.),
    // skip method validation — better to emit nothing than false positives
    if (surface.length === 0) continue

    for (const id of methods) {
      if (surface.includes(id.name)) continue  // method exists — all good

      // Method not found — find the closest real alternative
      const closest = getClosestMatch(id.name, surface)

      warnings.push({
        type: "HALLUCINATED_METHOD",
        severity: "warning",
        message: `'${id.name}' does not exist in ${pkg.canonical}@${pkg.version}.`,
        suggestion: closest
          ? `Did you mean '${closest}'? Check the ${pkg.canonical} docs for v${pkg.version}.`
          : `'${id.name}' was not found in the installed API surface of ${pkg.canonical}@${pkg.version}. Check the changelog for breaking changes.`,
        offender: `${context}.${id.name}`,
        packageName: pkg.canonical,
        installedVersion: pkg.version,
      })
    }
  }

  return warnings
}