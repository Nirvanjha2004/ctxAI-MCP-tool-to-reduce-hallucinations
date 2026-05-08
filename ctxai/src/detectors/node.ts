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
    
    const methods: string[] = [];
    
    function visit(node: ts.Node) {
      if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node)) {
        const name = node.name.getText();
        methods.push(name);
      }
      ts.forEachChild(node, visit);
    }

    // Traverse all source files in the program that are part of the node_modules package
    // or just the ones that aren't the default libs to avoid huge stdlib surfaces.
    const sourceFiles = program.getSourceFiles();
    for (const sourceFile of sourceFiles) {
      // Only traverse files that physically reside within the package's directory.
      // This prevents traversing the massive Node.js and TypeScript standard libraries.
      // Prisma's types are in .prisma/client, which is OUTSIDE @prisma/client, 
      // but it's generated in node_modules, so we should allow it if it includes 'prisma'
      // Or better, just check if it's in node_modules/@prisma or node_modules/.prisma
      const isPkgFile = sourceFile.fileName.includes('/node_modules/@prisma/') || 
                        sourceFile.fileName.includes('/node_modules/.prisma/') ||
                        sourceFile.fileName.startsWith(pkgPath.replace(/\\/g, '/'));
      
      if (isPkgFile && !sourceFile.fileName.includes('/node_modules/typescript/')) {
        visit(sourceFile);
      }
    }

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