import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateSuggestion } from "../src/tools/validateSuggestion.js";

// Setup pathing for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PromptTest {
  name: string;
  projectFingerprint: string;
  aiGeneratedCode: string;
  expectedViolations: number;
  /**
   * Optional mock API surface for Layer 2 (method hallucination) tests.
   * Keyed by lowercase package name → array of exported method names.
   *
   * Use this when you want to test method-existence checks without requiring
   * real node_modules to be installed. The benchmark runner passes this map
   * directly to validateSuggestion as apiSurfaceOverrides.
   *
   * Example:
   *   "apiSurfaceOverrides": {
   *     "@prisma/client": ["findFirst", "findMany", "create", "update", "delete"]
   *   }
   */
  apiSurfaceOverrides?: Record<string, string[]>;
  /** Internal notes — ignored by the runner */
  _note?: string;
}

async function runBenchmarks() {
  const promptsDir = path.join(__dirname, "prompts");
  const resultsDir = path.join(__dirname, "results");
  
  // Ensure results dir exists
  await fs.mkdir(resultsDir, { recursive: true });

  const files = await fs.readdir(promptsDir);
  const jsonFiles = files.filter(f => f.endsWith(".json"));

  console.log(`🚀 Running ctxai Benchmarks on ${jsonFiles.length} prompts...\n`);

  let passed = 0;
  const report: any[] = [];

  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(promptsDir, file), "utf-8");
    const testCase: PromptTest = JSON.parse(content);

    // Convert the plain object overrides (if any) into a Map for the validator.
    // Keys are lowercased so they match the canonical package name resolution.
    const overridesMap = testCase.apiSurfaceOverrides
      ? new Map(
          Object.entries(testCase.apiSurfaceOverrides).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ])
        )
      : undefined;

    // Run the AI code through our validator
    const warnings = await validateSuggestion(
      testCase.aiGeneratedCode, 
      process.cwd(),
      testCase.projectFingerprint,
      overridesMap,
    );

    const actualViolations = warnings.length;
    const isSuccess = actualViolations === testCase.expectedViolations;

    if (isSuccess) passed++;

    report.push({
      testName: testCase.name,
      status: isSuccess ? "PASS" : "FAIL",
      expected: testCase.expectedViolations,
      actual: actualViolations,
      warningsFound: warnings.map(w => w.message)
    });

    console.log(`${isSuccess ? "✅" : "❌"} ${testCase.name}`);
  }

  // Write the results to disk
  const reportPath = path.join(resultsDir, `run_${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Results: ${passed} / ${jsonFiles.length} passed.`);
  console.log(`📁 Detailed report saved to: ${reportPath}`);
}

// Execute the benchmark
runBenchmarks().catch(console.error);