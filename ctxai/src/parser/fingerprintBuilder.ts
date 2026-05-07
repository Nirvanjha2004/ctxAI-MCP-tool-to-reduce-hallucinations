import { PackageInfo } from "../detectors/node.js";

/**
 * Transforms a list of detected packages into a compressed 
 * string representation (the "Fingerprint").
 * 
 * Target size: ~200 tokens.
 */
export function buildFingerprint(packages: PackageInfo[]): string {
  if (packages.length === 0) {
    return "No project dependencies detected. Proceed with standard library assumptions.";
  }

  // We format each entry as "source:name@version" to be ultra-concise.
  // Example: "node:express@4.18.2"
  const fingerprintLines = packages.map(
    (pkg) => `${pkg.source}:${pkg.name}@${pkg.version}`
  );

  // Join lines with a simple newline. 
  // LLMs handle this format efficiently without wasting tokens on JSON syntax.
  const body = fingerprintLines.join("\n");

  return `
--- PROJECT CONTEXT FINGERPRINT ---
The following packages are installed in the user's local environment. 
You MUST use these specific versions. Do not suggest APIs from newer or older versions.

${body}
--- END FINGERPRINT ---
`.trim();
}