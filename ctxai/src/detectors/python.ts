import { execSync } from "child_process";

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