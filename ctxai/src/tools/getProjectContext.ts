/**
 * getProjectContext.ts
 *
 * Tool 1: get_project_context
 *
 * Reads the developer's project, detects all installed packages with their
 * exact versions, and returns a structured fingerprint string that gets
 * injected into the LLM context before every response.
 *
 * The fingerprint looks like:
 *
 *   === Project Context ===
 *   Project: my-app
 *   Path: /home/user/my-app
 *   Detected: 2026-05-08T10:30:00.000Z
 *
 *   [Node.js packages]
 *   node: express@4.18.2
 *   node: @prisma/client@3.15.2
 *
 *   [Python packages]
 *   python: fastapi@0.100.0
 *   python: requests@2.31.0
 *
 *   [Constraints]
 *   - Only suggest packages listed above. Do not suggest packages not in this list.
 *   - Answer for the exact versions listed. Do not assume the latest version.
 *   - If a method doesn't exist in the listed version, say so explicitly.
 *   ======================
 *
 * The constraints block is what actually forces the LLM to stay version-accurate.
 */

import path from "path"
import fs from "fs"
import { getDetectedPackages, type DetectedPackages } from "../detectors/index.js"
import { buildFingerprint } from "../parser/fingerprintBuilder.js"
import { sessionCache } from "../cache/sessionCache.js"
import { PackageInfo } from "../detectors/node.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a cached fingerprint is considered fresh (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * How long we wait for package detection before giving up.
 * node_modules on a large project can be slow to scan.
 */
const DETECTION_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectContextResult {
  /** Whether context was successfully read */
  success: boolean
  /** The fingerprint string to inject into LLM context */
  fingerprint: string
  /** Whether this result came from cache */
  fromCache: boolean
  /** How many packages were detected */
  packageCount: number
  /** Error description if success=false — safe to show to LLM */
  error?: string
}

interface CacheEntry {
  fingerprint: string
  packageCount: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a project path so that:
 *   /home/user/project  and
 *   /home/user/project/
 * produce the same cache key.
 */
function normalisePath(projectPath: string): string {
  return path.resolve(projectPath.trim()).replace(/[/\\]+$/, "")
}

/**
 * Validates that projectPath is:
 *   - a non-empty string
 *   - an absolute path
 *   - a directory that actually exists on disk
 *
 * Returns an error string if invalid, null if valid.
 */
function validateProjectPath(projectPath: string): string | null {
  if (!projectPath || typeof projectPath !== "string" || !projectPath.trim()) {
    return "projectPath is required and must be a non-empty string."
  }

  const resolved = path.resolve(projectPath.trim())

  if (!path.isAbsolute(resolved)) {
    return "projectPath must be an absolute path."
  }

  try {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      return "projectPath must point to a directory, not a file."
    }
  } catch {
    return "projectPath does not exist or cannot be accessed."
  }

  return null
}

/**
 * Wraps a promise with a hard timeout.
 * Resolves with undefined if the operation exceeds ms milliseconds.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    const result = await Promise.race([promise, timeout])
    clearTimeout(timer!)
    return result
  } catch (err) {
    clearTimeout(timer!)
    throw err
  }
}

/**
 * Builds a minimal fallback fingerprint when detection fails.
 * Still provides the constraint instructions to the LLM so it
 * at least knows to be cautious about versions.
 */
function buildFallbackFingerprint(reason: string): string {
  return [
    "=== Project Context ===",
    `Note: ${reason}`,
    "",
    "[Constraints]",
    "- Package versions could not be detected for this project.",
    "- Be explicit about which version your suggestions apply to.",
    "- Flag any APIs that changed significantly between major versions.",
    "======================",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Reads the developer's project and returns a structured context fingerprint.
 *
 * Caches results for CACHE_TTL_MS (5 minutes) to keep latency low on
 * repeated calls within the same session. Cache is keyed by normalised
 * absolute project path so trailing-slash variants hit the same entry.
 *
 * Never throws — always returns a ProjectContextResult. On failure,
 * success=false and fingerprint contains a safe fallback message.
 *
 * @param projectPath  Absolute path to the project root directory
 */
export async function getProjectContext(
  projectPath: string,
): Promise<ProjectContextResult> {

  // ── Step 1: Validate input ──────────────────────────────────────────────
  const validationError = validateProjectPath(projectPath)
  if (validationError) {
    return {
      success: false,
      fingerprint: buildFallbackFingerprint(
        "Project path could not be read. Proceeding without local context.",
      ),
      fromCache: false,
      packageCount: 0,
      // Safe error — no internal path info
      error: validationError,
    }
  }

  const normPath = normalisePath(projectPath)

  // ── Step 2: Check cache ─────────────────────────────────────────────────
  const cached = sessionCache.get(`ctx:${normPath}`) as CacheEntry | undefined
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return {
      success: true,
      fingerprint: cached.fingerprint,
      fromCache: true,
      packageCount: cached.packageCount,
    }
  }

  // ── Step 3: Detect packages with timeout ────────────────────────────────
  let detected: DetectedPackages | undefined

  try {
    detected = await withTimeout(
      getDetectedPackages(normPath),
      DETECTION_TIMEOUT_MS,
    )
  } catch (err: unknown) {
    // Detection threw — distinguish permission errors from parse errors
    const message = err instanceof Error ? err.message : String(err)

    const isPermission =
      message.includes("EACCES") || message.includes("EPERM")

    const safeReason = isPermission
      ? "Insufficient permissions to read project dependencies."
      : "Could not parse project dependency files."

    return {
      success: false,
      fingerprint: buildFallbackFingerprint(safeReason),
      fromCache: false,
      packageCount: 0,
      error: safeReason,
    }
  }

  // Detection timed out
  if (!detected) {
    return {
      success: false,
      fingerprint: buildFallbackFingerprint(
        "Dependency scanning timed out. Proceeding without local context.",
      ),
      fromCache: false,
      packageCount: 0,
      error: "Detection timed out after 10 seconds.",
    }
  }

  // ── Step 4: Build fingerprint ───────────────────────────────────────────
  let fingerprint: string

  try {
    fingerprint = buildFingerprint(detected);
  } catch (err: unknown) {
    const safeReason = "Could not build context fingerprint from detected packages."
    return {
      success: false,
      fingerprint: buildFallbackFingerprint(safeReason),
      fromCache: false,
      packageCount: 0,
      error: safeReason,
    }
  }

  const packageCount =
    (detected.node?.length ?? 0) + (detected.python?.length ?? 0)

  // ── Step 5: Cache and return ────────────────────────────────────────────
  const entry: CacheEntry = {
    fingerprint,
    packageCount,
    timestamp: Date.now(),
  }

  sessionCache.set(`ctx:${normPath}`, entry)

  return {
    success: true,
    fingerprint,
    fromCache: false,
    packageCount,
  }
}