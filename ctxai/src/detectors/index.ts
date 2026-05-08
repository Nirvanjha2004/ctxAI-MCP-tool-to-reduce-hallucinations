import { detectNode, PackageInfo } from "./node.js";
import { detectPython } from "./python.js";

export async function getDetectedPackages(projectPath: string): Promise<PackageInfo[]> {
  // Run both detectors in parallel
  const [nodePkgs, pythonPkgs] = await Promise.all([
    detectNode(projectPath),
    detectPython(projectPath)
  ]);

  const allPackages = [...nodePkgs, ...pythonPkgs];
  
  if (allPackages.length === 0) {
    console.error(`No packages detected in ${projectPath}`);
  }

  return allPackages;
}