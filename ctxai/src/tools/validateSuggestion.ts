import { parseResponse } from "../parser/responseParser.js";
import { getModuleApiSurface } from "../detectors/node.js";
import { getPythonApiSurface } from "../detectors/python.js";
import { getClosestMatch } from "../utils/fuzzy.js";
import { sessionCache } from "../cache/sessionCache.js";
import path from "path";

export async function validateSuggestion(
  code: string,
  projectPath: string,
  contextFingerprint: string,
) {
  const warnings: any[] = [];
  const suggestions = parseResponse(code);

  // 1. Map installed packages (Store names as lowercase for normalization)
  const installed = new Map<string, string>();
  contextFingerprint.split("\n").forEach((l) => {
    if (l.includes("@") && l.includes(":")) {
      const parts = l.split(":");
      const [name, ver] = parts[1].split("@");
      installed.set(name.trim().toLowerCase(), ver.trim());
    }
  });

  function getBasePackage(importPath: string): string {
    const parts = importPath.split("/");
    if (importPath.startsWith("@")) {
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    }
    return parts[0];
  }

  for (const item of suggestions) {
    
    // Layer 1: Check Package Existence
    if (item.type === "import") {
      const baseName = getBasePackage(item.name).toLowerCase();
      const isInstalled = installed.has(baseName);

      if (!isInstalled) {
        // Skip common Node.js and Next.js built-ins
        const builtins = ["fs", "path", "os", "crypto", "http", "https", "next", "react"]; 
        if (builtins.includes(baseName)) continue;

        warnings.push({
          type: "MISSING_PACKAGE",
          message: `Package '${item.name}' is not in your project dependencies.`,
          suggestion: `Install it via npm/pip first.`,
        });
        continue;
      }
    }

    // Layer 2: Deep Method Validation
    if (item.type === "method_call" && item.context) {
      const pkgName = item.context.toLowerCase();
      const version = installed.get(pkgName);

      if (version) {
        const cacheKey = `api:${pkgName}:${version}`;
        let methods = sessionCache.get(cacheKey) as unknown as string[];

        if (!methods) {
          try {
            // Attempt Node check first, then Python
            methods = await getModuleApiSurface(
              path.join(projectPath, "node_modules", pkgName)
            );
            
            if (methods.length === 0) {
              methods = await getPythonApiSurface(pkgName);
            }

            if (methods && methods.length > 0) {
              sessionCache.set(cacheKey, JSON.stringify(methods));
            }
          } catch (e) {
            methods = [];
          }
        }

        if (methods && methods.length > 0 && !methods.includes(item.name)) {
          const closest = getClosestMatch(item.name, methods);
          warnings.push({
            type: "POTENTIAL_HALLUCINATION",
            message: `'${item.name}' is not available in ${pkgName}@${version}.`,
            suggestion: closest
              ? `Did you mean '${closest}'?`
              : `Check the package documentation.`,
          });
        }
      }
    }
  }

  return warnings;
}