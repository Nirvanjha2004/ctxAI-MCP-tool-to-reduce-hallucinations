import { promises as fs } from "fs";
import path from "path";

export interface PackageInfo {
  name: string;
  version: string;
  source: "node" | "python";
}

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
    }));
  } catch (error) {
    // If package.json doesn't exist, this isn't a Node project
    return [];
  }
}