import { detectNode } from "./node.js";
import { detectPython } from "./python.js";

/**
 * Individual package metadata
 */
export interface PackageInfo {
  name: string;
  version: string;
  source: "node" | "python";
}

/**
 * Updated: DetectedPackages is now an object with language-specific keys
 */
export interface DetectedPackages {
  node: PackageInfo[];
  python: PackageInfo[];
}

/**
 * Orchestrator: Returns a structured object containing all detected dependencies
 */
export async function getDetectedPackages(projectPath: string): Promise<DetectedPackages> {
  // We initialize as an object with empty arrays
  const results: DetectedPackages = {
    node: [],
    python: []
  };

  try {
    // 1. Fetch Node packages
    results.node = await detectNode(projectPath);

    // 2. Fetch Python packages
    results.python = await detectPython(projectPath);

  } catch (error) {
    console.error("Error during package detection:", error);
  }

  return results;
}