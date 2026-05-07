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

    // Run the AI code through our validator
    const warnings = await validateSuggestion(
      testCase.aiGeneratedCode, 
      testCase.projectFingerprint
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