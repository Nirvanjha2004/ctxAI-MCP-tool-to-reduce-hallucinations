export interface ExtractedIdentifer {
  type: "import" | "method_call" | "package_mention";
  name: string;
  context?: string;
}

export function parseResponse(text: string): ExtractedIdentifer[] {
  const identifiers: ExtractedIdentifer[] = [];

  // 1. ESM/CommonJS Imports (Node)
  const importRegex = /(?:import\s+.*\s+from\s+['"]|require\(['"])([@\w\-/]+)['"]\)?/g;
  let match;
  while ((match = importRegex.exec(text)) !== null) {
    identifiers.push({ type: "import", name: match[1] });
  }

  // 2. Python Imports (Fixed logic)
  // 'from x import y' -> only captures x
  const pyFromRegex = /^\s*from\s+([\w.-]+)/gm; 
  // 'import x' -> only captures x if it's the start of the line
  const pyImportRegex = /^\s*import\s+([\w.-]+)/gm;

  while ((match = pyFromRegex.exec(text)) !== null) {
    identifiers.push({ type: "import", name: match[1].replace(/_/g, "-") });
  }
  while ((match = pyImportRegex.exec(text)) !== null) {
    const pkgName = match[1].replace(/_/g, "-");
    // Avoid duplicates
    if (!identifiers.some(i => i.name === pkgName)) {
      identifiers.push({ type: "import", name: pkgName });
    }
  }

  // 3. Method Calls
  const methodRegex = /([\w$]+)\.([\w$]+)\(/g;
  while ((match = methodRegex.exec(text)) !== null) {
    identifiers.push({
      type: "method_call",
      name: match[2],
      context: match[1],
    });
  }

  return Array.from(new Map(identifiers.map(id => [`${id.type}:${id.name}`, id])).values());
}