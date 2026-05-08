import type { DetectedPackages } from "../detectors/index.js";

/** Minimal package shape needed to build a fingerprint line. */
interface FingerprintablePackage {
  name: string;
  version: string;
  source: "node" | "python";
}

/**
 * Transforms detected packages into a compressed fingerprint string.
 *
 * Accepts either a flat PackageInfo[] (legacy) or the DetectedPackages
 * object { node: PackageInfo[], python: PackageInfo[] } from getDetectedPackages.
 *
 * Target size: ~200 tokens.
 */
export function buildFingerprint(input: FingerprintablePackage[] | DetectedPackages): string {
  // Normalise to a flat array regardless of input shape
  let packages: FingerprintablePackage[]
  if (Array.isArray(input)) {
    packages = input
  } else {
    packages = [...(input.node ?? []), ...(input.python ?? [])]
  }

  if (packages.length === 0) {
    return "No project dependencies detected. Proceed with standard library assumptions.";
  }

  // Format: "source: name@version"  — matches the fingerprint format the
  // validator and benchmark expect (e.g. "node: express@4.18.2")
  const fingerprintLines = packages.map(
    (pkg) => `${pkg.source}: ${pkg.name}@${pkg.version}`
  );

  const body = fingerprintLines.join("\n");

  return `--- PROJECT CONTEXT FINGERPRINT ---
The following packages are installed in the user's local environment.
You MUST use these specific versions. Do not suggest APIs from newer or older versions.

${body}
--- END FINGERPRINT ---`;
}