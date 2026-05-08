import { promises as fs } from "fs";
import path from "path";
import { PackageInfo } from "./node.js";
import { execSync } from "child_process";

export async function detectPython(projectPath: string): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  // Check requirements.txt
  try {
    const reqPath = path.join(projectPath, "requirements.txt");
    const content = await fs.readFile(reqPath, "utf-8");
    
    content.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        // Basic parsing for 'package==version' or 'package>=version'
        const [name, version] = trimmed.split(/[=>]=/);
        packages.push({
          name: name.trim(),
          version: version ? version.trim() : "unknown",
          source: "python",
          path: "" // Python packages don't have a local path like node_modules
        });
      }
    });
  } catch (e) { /* ignore if file missing */ }

  // Check pyproject.toml (simplified parsing)
  try {
    const tomlPath = path.join(projectPath, "pyproject.toml");
    const content = await fs.readFile(tomlPath, "utf-8");
    // In a real prod app, use a TOML parser here
    // For now, we'll look for simple dependency lines
    if (content.includes("[tool.poetry.dependencies]") || content.includes("dependencies = [")) {
        // Logic for extraction would go here
    }
  } catch (e) { /* ignore if file missing */ }

  return packages;
}

export async function getPythonApiSurface(packageName: string): Promise<string[]> {
  try {
    // Run a tiny python script to list all members of the module
    const cmd = `python -c "import ${packageName}; print(list(dir(${packageName})))"`;
    const output = execSync(cmd, { encoding: "utf-8" });
    
    // Parse the string representation of the list: ["method1", "method2"]
    return JSON.parse(output.replace(/'/g, '"'));
  } catch (e) {
    return [];
  }
}