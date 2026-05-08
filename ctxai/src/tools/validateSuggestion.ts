import { parseResponse } from "../parser/responseParser.js";
import { getModuleApiSurface } from "../detectors/node.js";
import { getPythonApiSurface } from "../detectors/python.js";
import { getClosestMatch } from "../utils/fuzzy.js";
import { sessionCache } from "../cache/sessionCache.js";
import path from "path";

export async function validateSuggestion(
  code: string,
  projectPath: string, // Changed from fingerprint to projectPath for deep access
  contextFingerprint: string
) {
  const warnings: any[] = [];
  const suggestions = parseResponse(code);
  
  // 1. Map installed packages from fingerprint
  const installed = new Map<string, string>();
  contextFingerprint.split("\n").forEach(l => {
    if (l.includes("@")) {
      const [name, ver] = l.split(":")[1].split("@");
      installed.set(name, ver);
    }
  });

  for (const item of suggestions) {
    // Layer 1: Check Package Existence
    if (!installed.has(item.name) && item.type === "import") {
      warnings.push({
        type: "MISSING_PACKAGE",
        message: `Package '${item.name}' is not in your project dependencies.`,
        suggestion: `Install it via npm/pip first.`
      });
      continue;
    }

    // Layer 2: Deep Method Validation
    if (item.type === "method_call" && item.context) {
      const pkgName = item.context;
      const version = installed.get(pkgName);
      
      if (version) {
        // Use Cache to avoid re-parsing .d.ts files every prompt
        const cacheKey = `api:${pkgName}:${version}`;
        let methods = sessionCache.get(cacheKey) as unknown as string[];

        if (!methods) {
          // Fetch API surface (Node or Python)
          const isNode = item.context === pkgName; // Simplified logic
          methods = isNode 
            ? await getModuleApiSurface(path.join(projectPath, "node_modules", pkgName))
            : await getPythonApiSurface(pkgName);
          
          sessionCache.set(cacheKey, JSON.stringify(methods));
        }

        if (methods.length > 0 && !methods.includes(item.name)) {
          const closest = getClosestMatch(item.name, methods);
          warnings.push({
            type: "POTENTIAL_HALLUCINATION",
            message: `'${item.name}' is not available in ${pkgName}@${version}.`,
            suggestion: closest ? `Did you mean '${closest}'?` : `Check the package documentation.`
          });
        }
      }
    }
  }

  return warnings;
}