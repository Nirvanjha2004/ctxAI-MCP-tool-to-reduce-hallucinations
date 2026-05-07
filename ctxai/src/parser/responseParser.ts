export interface ExtractedIdentifer {
  type: "import" | "method_call" | "package_mention";
  name: string;
  context?: string;
}

export function parseResponse(text: string): ExtractedIdentifer[] {
  const identifiers: ExtractedIdentifer[] = [];

  // 1. Extract Imports (ESM and CommonJS)
  // Matches: import { x } from 'pkg', import x from "pkg", require('pkg')
  const importRegex = /(?:import\s+.*\s+from\s+['"]|require\(['"])([@\w\-/]+)['"]\)?/g;
  let match;
  while ((match = importRegex.exec(text)) !== null) {
    identifiers.push({
      type: "import",
      name: match[1],
    });
  }

  // 2. Extract Method Calls
  // Matches: identifier.methodName(
  // This is a bit "noisy" so we only look for calls on common patterns
  const methodRegex = /([\w$]+)\.([\w$]+)\(/g;
  while ((match = methodRegex.exec(text)) !== null) {
    identifiers.push({
      type: "method_call",
      name: match[2],
      context: match[1], // The variable/package being called
    });
  }

  // 3. Look for Package Mentions in Prose
  // Matches things like "you should use the express package"
  const packageKeywords = ["package", "library", "module", "dependency"];
  packageKeywords.forEach(keyword => {
    const proseRegex = new RegExp(`${keyword}\\s+['"\`]?([@\\w\\-/]+)['"\`]?`, "gi");
    while ((match = proseRegex.exec(text)) !== null) {
      identifiers.push({
        type: "package_mention",
        name: match[1],
      });
    }
  });

  // De-duplicate results
  return Array.from(new Map(identifiers.map(id => [`${id.type}:${id.name}`, id])).values());
}