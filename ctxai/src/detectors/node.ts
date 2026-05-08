import { promises as fs } from "fs";
import path from "path";
import ts from "typescript";

export interface PackageInfo {
  name: string;
  version: string;
  source: "node" | "python";
  path: string; // Added to locate node_modules
}

export async function getModuleApiSurface(pkgPath: string): Promise<string[]> {
  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(pkgPath, "package.json"), "utf-8"));
    const typesPath = pkgJson.types || pkgJson.typings || "index.d.ts";
    const fullTypesPath = path.join(pkgPath, typesPath);

    const program = ts.createProgram([fullTypesPath], { allowJs: true });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(fullTypesPath);

    if (!sourceFile) return [];

    const methods: string[] = [];
    
    function visit(node: ts.Node) {
      // Extract method names from interfaces, classes, and types
      if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node)) {
        const name = node.name.getText();
        methods.push(name);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return [...new Set(methods)];
  } catch (e) {
    return [];
  }
}

// ... keep existing detectNode logic but add the 'path' property to results

export async function detectNode(projectPath: string): Promise<PackageInfo[]> {
  const packageJsonPath = path.join(projectPath, "package.json");
  
  try {
    const content = await fs.readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    
    // Combine dependencies and devDependencies
    const dependencies = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    return Object.entries(dependencies).map(([name, version]) => ({
      name,
      version: (version as string).replace(/[\^~]/, ""), // Clean version string
      source: "node",
      path: path.join(projectPath, "node_modules", name),
    }));
  } catch (error) {
    // If package.json doesn't exist, this isn't a Node project
    return [];
  }
}