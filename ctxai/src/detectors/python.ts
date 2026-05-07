import { promises as fs } from "fs";
import path from "path";
import { PackageInfo } from "./node.js";

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
          source: "python"
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