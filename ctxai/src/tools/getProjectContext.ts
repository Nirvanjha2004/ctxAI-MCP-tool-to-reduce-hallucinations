import { getDetectedPackages } from "../detectors/index.js";
import { buildFingerprint } from "../parser/fingerprintBuilder.js";
import { sessionCache } from "../cache/sessionCache.js";

/**
 * Tool 1: get_project_context
 * Reads the project disk (or cache), detects packages, builds the fingerprint,
 * and returns it to the LLM.
 * 
 * @param projectPath Absolute path to the user's project root
 * @returns The structured fingerprint string
 */
export async function getProjectContext(projectPath: string): Promise<string> {
  // 1. Check Cache First (Latency check)
  const cachedFingerprint = sessionCache.get(projectPath);
  if (cachedFingerprint) {
    return cachedFingerprint;
  }

  try {
    // 2. Scan Disk (Read dependencies)
    const packages = await getDetectedPackages(projectPath);

    // 3. Compress Data (Build context block)
    const fingerprint = buildFingerprint(packages);

    // 4. Save to Cache (Fast subsequent reads)
    sessionCache.set(projectPath, fingerprint);

    return fingerprint;
  } catch (error: any) {
    // Fallback behavior: Return a graceful message rather than crashing the tool
    return `Error reading project context at ${projectPath}. Error: ${error.message}. Proceeding without local context.`;
  }
}