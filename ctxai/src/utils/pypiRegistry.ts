/**
 * Utility to fetch package metadata from the Python Package Index (PyPI).
 */
export interface PypiMetadata {
  info: {
    name: string;
    version: string;
    summary: string;
  };
  releases: Record<string, any>;
}

const PYPI_URL = "https://pypi.org/pypi";

export async function fetchPypiMetadata(packageName: string): Promise<PypiMetadata | null> {
  try {
    const response = await fetch(`${PYPI_URL}/${packageName}/json`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`PyPI responded with ${response.status}`);
    }

    return await response.json() as PypiMetadata;
  } catch (error) {
    console.error(`Failed to fetch PyPI metadata for ${packageName}:`, error);
    return null;
  }
}

/**
 * Checks if a specific version exists on PyPI.
 */
export async function isValidPypiVersion(packageName: string, version: string): Promise<boolean> {
  const metadata = await fetchPypiMetadata(packageName);
  if (!metadata) return false;

  // PyPI returns a 'releases' object where keys are version strings.
  return !!metadata.releases[version];
}