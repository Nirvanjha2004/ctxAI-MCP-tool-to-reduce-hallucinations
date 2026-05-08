import { fetchNpmMetadata } from "../utils/npmRegistry.js";
import { fetchPypiMetadata } from "../utils/pypiRegistry.js";

/**
 * Tool 3: get_package_docs
 * Fetches version-specific information to help the LLM correct hallucinations.
 */
export async function getPackageDocs(
  packageName: string,
  version: string,
  registry: "npm" | "pypi",
): Promise<string> {
  try {
    if (registry === "npm") {
      const metadata = await fetchNpmMetadata(packageName);
      if (!metadata) return `Package '${packageName}' not found on npm.`;

      const versionInfo = metadata.versions[version];
      if (!versionInfo) {
        const latest = metadata["dist-tags"].latest;
        return `Version ${version} not found. Latest version is ${latest}.`;
      }

      // We return the description and common entry points.
      // In a full implementation, you'd include the README snippet here.
      return `
Docs for ${packageName}@${version} (npm):
Description: ${versionInfo.description || "No description available."}
Main Entry: ${versionInfo.main || "index.js"}
Keywords: ${(versionInfo.keywords || []).join(", ")}
      `.trim();
    } else {
      const metadata = await fetchPypiMetadata(packageName);
      if (!metadata) return `Package '${packageName}' not found on PyPI.`;

      const info = metadata.info;
      // PyPI metadata is often top-level rather than per-version in the JSON API
      return `
Docs for ${packageName} (PyPI):
Current Version: ${info.version}
Summary: ${info.summary}
      `.trim();
    }
  } catch (error: any) {
    return `Failed to fetch docs: ${error.message}`;
  }
}
