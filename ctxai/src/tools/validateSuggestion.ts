import { parseResponse, ExtractedIdentifer } from "../parser/responseParser.js";

interface ValidationWarning {
  type: "MISSING_PACKAGE" | "VERSION_MISMATCH" | "POTENTIAL_HALLUCINATION";
  message: string;
  suggestion?: string;
}

/**
 * Tool 2: validate_suggestion
 * Compares AI code against the project fingerprint to catch errors.
 */
export async function validateSuggestion(
  code: string,
  contextFingerprint: string
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = [];
  
  // 1. Parse the fingerprint into a lookup map
  // Expected format: "source:name@version"
  const installedPackages = new Map<string, string>();
  const lines = contextFingerprint.split("\n");
  
  lines.forEach(line => {
    if (line.includes(":") && line.includes("@")) {
      const [sourceAndName, version] = line.split("@");
      const [_, name] = sourceAndName.split(":");
      installedPackages.set(name.trim(), version.trim());
    }
  });

  // 2. Extract identifiers from the AI's suggested code
  const suggestions = parseResponse(code);

  // 3. Compare suggestions against installed packages
  for (const item of suggestions) {
    if (item.type === "import" || item.type === "package_mention") {
      const isInstalled = installedPackages.has(item.name);
      
      if (!isInstalled) {
        // If it's a common built-in (like 'fs' or 'path'), skip
        const nodeBuiltins = ["fs", "path", "os", "crypto", "http", "https"];
        if (nodeBuiltins.includes(item.name)) continue;

        warnings.push({
          type: "MISSING_PACKAGE",
          message: `The AI suggested using '${item.name}', but it is not installed in your project.`,
          suggestion: `Run 'npm install ${item.name}' or 'pip install ${item.name}' if you wish to use it.`
        });
      }
    }

    // 4. Check for potential method hallucinations
    // If the package is installed, we check if the call looks suspicious
    // (Note: Deep method validation happens in Tool 3: get_package_docs)
    if (item.type === "method_call" && item.context) {
      const pkgVersion = installedPackages.get(item.context);
      if (pkgVersion) {
        // Here we could flag notoriously changed methods 
        // e.g., 'app.listen' in very old vs new versions
      }
    }
  }

  return warnings;
}