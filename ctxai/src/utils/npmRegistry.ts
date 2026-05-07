/**
 * Utility to fetch package metadata from the official npm registry.
 */
export interface NpmMetadata {
  name: string;
  versions: Record<string, any>;
  "dist-tags": Record<string, string>;
}

const REGISTRY_URL = "https://registry.npmjs.org";

export async function fetchNpmMetadata(packageName: string): Promise<NpmMetadata | null> {
  try {
    // We use the 'abbreviated' accept header to keep the payload small and fast.
    const response = await fetch(`${REGISTRY_URL}/${packageName}`, {
      headers: {
        "Accept": "application/vnd.npm.install-v1+json"
      }
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    return await response.json() as NpmMetadata;
  } catch (error) {
    console.error(`Failed to fetch npm metadata for ${packageName}:`, error);
    return null;
  }
}

/**
 * Checks if a specific version exists for a package.
 */
export async function isValidNpmVersion(packageName: string, version: string): Promise<boolean> {
  const metadata = await fetchNpmMetadata(packageName);
  if (!metadata) return false;

  return !!(metadata.versions[version] || metadata["dist-tags"][version]);
}