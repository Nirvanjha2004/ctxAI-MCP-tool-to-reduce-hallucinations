/**
 * registryClient.ts
 *
 * Thin, typed clients for the npm and PyPI registries.
 * Used exclusively by checkPackageSafety to fetch package metadata.
 *
 * Both clients:
 *   - Return undefined instead of throwing on 404 (package doesn't exist)
 *   - Return undefined on network errors (graceful degradation)
 *   - Have a hard timeout so a slow registry never blocks the tool
 */

const REGISTRY_TIMEOUT_MS = 6_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NpmPackageInfo {
  name: string
  /** ISO string of first publish date */
  created: string
  /** ISO string of last update */
  modified: string
  /** Latest published version */
  latestVersion: string
  /** Number of published versions (proxy for maturity) */
  versionCount: number
  /** Number of maintainers */
  maintainerCount: number
  /** Whether the package has a repository link */
  hasRepository: boolean
  /** Description if present */
  description: string | null
}

export interface PypiPackageInfo {
  name: string
  latestVersion: string
  /** Number of releases (proxy for maturity) */
  releaseCount: number
  /** Author name if present */
  author: string | null
  /** Whether the package has a home page or project URL */
  hasHomePage: boolean
  /** Summary/description */
  summary: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * fetch() with a hard timeout. Returns undefined if the request
 * takes longer than ms milliseconds.
 */
async function fetchWithTimeout(
  url: string,
  ms: number,
): Promise<Response | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch {
    clearTimeout(timer)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// npm registry client
// ---------------------------------------------------------------------------

/**
 * Fetches package metadata from the npm registry.
 *
 * Returns undefined if:
 *   - Package does not exist (404)
 *   - Network error or timeout
 *   - Response is malformed
 *
 * Does NOT use the downloads API (api.npmjs.org) because that endpoint
 * is rate-limited and requires a separate request. Version count and
 * maintainer count are sufficient trust proxies from the main registry.
 */
export async function fetchNpmPackage(
  packageName: string,
): Promise<NpmPackageInfo | undefined> {
  const encoded = encodeURIComponent(packageName).replace("%40", "@")
  const url = `https://registry.npmjs.org/${encoded}`

  const res = await fetchWithTimeout(url, REGISTRY_TIMEOUT_MS)
  if (!res || res.status === 404) return undefined
  if (!res.ok) return undefined

  try {
    const data = await res.json() as Record<string, unknown>

    const distTags = data["dist-tags"] as Record<string, string> | undefined
    const latestVersion = distTags?.latest ?? "unknown"

    const time = data.time as Record<string, string> | undefined
    const created = time?.created ?? new Date(0).toISOString()
    const modified = time?.modified ?? created

    const versions = data.versions as Record<string, unknown> | undefined
    const versionCount = versions ? Object.keys(versions).length : 0

    const maintainers = data.maintainers as unknown[] | undefined
    const maintainerCount = maintainers?.length ?? 0

    const latestVersionData = versions?.[latestVersion] as
      | Record<string, unknown>
      | undefined

    const repository = latestVersionData?.repository ?? data.repository
    const hasRepository = !!(
      repository &&
      typeof repository === "object" &&
      (repository as Record<string, unknown>).url
    )

    const description =
      typeof data.description === "string" ? data.description : null

    return {
      name: packageName,
      created,
      modified,
      latestVersion,
      versionCount,
      maintainerCount,
      hasRepository,
      description,
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// PyPI registry client
// ---------------------------------------------------------------------------

/**
 * Fetches package metadata from the PyPI JSON API.
 *
 * Returns undefined if:
 *   - Package does not exist (404)
 *   - Network error or timeout
 *   - Response is malformed
 */
export async function fetchPypiPackage(
  packageName: string,
): Promise<PypiPackageInfo | undefined> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`

  const res = await fetchWithTimeout(url, REGISTRY_TIMEOUT_MS)
  if (!res || res.status === 404) return undefined
  if (!res.ok) return undefined

  try {
    const data = await res.json() as Record<string, unknown>
    const info = data.info as Record<string, unknown> | undefined
    if (!info) return undefined

    const releases = data.releases as Record<string, unknown> | undefined
    const releaseCount = releases ? Object.keys(releases).length : 0

    const projectUrls = info.project_urls as Record<string, string> | undefined
    const homePage = info.home_page
    const hasHomePage = !!(
      (typeof homePage === "string" && homePage.trim()) ||
      projectUrls?.Homepage ||
      projectUrls?.Source
    )

    return {
      name: packageName,
      latestVersion: typeof info.version === "string" ? info.version : "unknown",
      releaseCount,
      author: typeof info.author === "string" ? info.author : null,
      hasHomePage,
      summary: typeof info.summary === "string" ? info.summary : null,
    }
  } catch {
    return undefined
  }
}