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
   */
  apiSurfaceOverrides?: Record<string, string[]>;
  /** Internal notes — ignored by the runner */
  _note?: string;
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

/**
 * Classifies a test case by what it's primarily testing.
 * Used to break down metrics by category in the report.
 */
function classifyTest(tc: PromptTest): string {
  const name = tc.name.toLowerCase();
  if (tc.expectedViolations === 0)                    return "happy-path";
  if (name.includes("method") || tc.apiSurfaceOverrides) return "method-hallucination";
  if (name.includes("python") || name.includes("django") ||
      name.includes("fastapi") || name.includes("sqlalchemy")) return "python-package";
  if (name.includes("stress") || name.includes("multiple")) return "multi-package";
  if (name.includes("edge") || name.includes("prose") ||
      name.includes("duplicate") || name.includes("empty")) return "edge-case";
  return "node-package";
}

/**
 * Formats a percentage with one decimal place, or "N/A" if denominator is 0.
 */
function pct(num: number, den: number): string {
  if (den === 0) return "N/A";
  return `${((num / den) * 100).toFixed(1)}%`;
}

/**
 * Renders a simple ASCII bar (max 20 chars wide).
 */
function bar(value: number, max: number, width = 20): string {
  const filled = max === 0 ? 0 : Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function runBenchmarks() {
  const promptsDir = path.join(__dirname, "prompts");
  const resultsDir = path.join(__dirname, "results");

  await fs.mkdir(resultsDir, { recursive: true });

  const files = await fs.readdir(promptsDir);
  const jsonFiles = files.filter(f => f.endsWith(".json")).sort();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ctxai Hallucination Reduction Benchmark`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Prompts: ${jsonFiles.length}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Accumulators ──────────────────────────────────────────────────────────

  let validatorPassed = 0;

  // Hallucination tracking
  // "baseline" = what an LLM without ctxai would produce (no warnings caught)
  // "ctxai"    = what ctxai catches
  let totalHallucinations   = 0; // ground truth: sum of expectedViolations > 0
  let totalCaught           = 0; // hallucinations ctxai correctly flagged
  let totalFalsePositives   = 0; // warnings fired on expectedViolations=0 cases
  let totalMissed           = 0; // expected > 0 but ctxai caught 0

  // Per-category breakdown
  const categories: Record<string, {
    total: number; caught: number; missed: number; fp: number; tests: number; passed: number;
  }> = {};

  const report: any[] = [];

  // ── Per-test loop ─────────────────────────────────────────────────────────

  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(promptsDir, file), "utf-8");
    const tc: PromptTest = JSON.parse(content);

    const overridesMap = tc.apiSurfaceOverrides
      ? new Map(Object.entries(tc.apiSurfaceOverrides).map(([k, v]) => [k.toLowerCase(), v]))
      : undefined;

    // Run WITH ctxai context (normal mode)
    const warnings = await validateSuggestion(
      tc.aiGeneratedCode,
      process.cwd(),
      tc.projectFingerprint,
      overridesMap,
    );

    // Run WITHOUT ctxai context (baseline: empty fingerprint → validator returns [])
    // This simulates a plain LLM with no project awareness.
    const baselineWarnings = await validateSuggestion(
      tc.aiGeneratedCode,
      process.cwd(),
      "", // empty fingerprint = no context = no warnings
      overridesMap,
    );

    const actual   = warnings.length;
    const baseline = baselineWarnings.length; // always 0 by design
    const expected = tc.expectedViolations;
    const isPassing = actual === expected;
    const category = classifyTest(tc);

    if (isPassing) validatorPassed++;

    // Hallucination metrics
    if (expected > 0) {
      // This code contains real hallucinations
      totalHallucinations += expected;
      totalCaught         += Math.min(actual, expected); // cap at expected
      totalMissed         += expected > actual ? expected - actual : 0;
    } else {
      // This code is clean — any warning is a false positive
      totalFalsePositives += actual;
    }

    // Category rollup
    if (!categories[category]) {
      categories[category] = { total: 0, caught: 0, missed: 0, fp: 0, tests: 0, passed: 0 };
    }
    const cat = categories[category];
    cat.tests++;
    if (isPassing) cat.passed++;
    if (expected > 0) {
      cat.total  += expected;
      cat.caught += Math.min(actual, expected);
      cat.missed += expected > actual ? expected - actual : 0;
    } else {
      cat.fp += actual;
    }

    // Console output
    const icon = isPassing ? "✅" : "❌";
    const delta = actual - baseline;
    const deltaStr = expected > 0
      ? `  caught ${actual}/${expected} hallucinations`
      : `  ${actual === 0 ? "no false positives" : `⚠ ${actual} false positive(s)`}`;
    console.log(`${icon} ${tc.name}`);
    console.log(`   ${deltaStr}`);

    report.push({
      testName:          tc.name,
      category,
      status:            isPassing ? "PASS" : "FAIL",
      expected,
      actual,
      baselineWarnings:  baseline,
      hallucinationsCaught: expected > 0 ? Math.min(actual, expected) : 0,
      falsePositives:    expected === 0 ? actual : 0,
      warningsFound:     warnings.map(w => ({ type: w.type, message: w.message, offender: w.offender })),
    });
  }

  // ── Metrics summary ───────────────────────────────────────────────────────

  const detectionRate   = totalHallucinations > 0
    ? (totalCaught / totalHallucinations) * 100 : 100;
  const missRate        = totalHallucinations > 0
    ? (totalMissed / totalHallucinations) * 100 : 0;
  const precision       = (totalCaught + totalFalsePositives) > 0
    ? (totalCaught / (totalCaught + totalFalsePositives)) * 100 : 100;

  // F1 score: harmonic mean of precision and recall (detection rate)
  const recall = detectionRate / 100;
  const prec   = precision / 100;
  const f1     = (prec + recall) > 0
    ? (2 * prec * recall) / (prec + recall) : 0;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  HALLUCINATION REDUCTION METRICS`);
  console.log(`${"═".repeat(60)}`);
  console.log();
  console.log(`  Benchmark accuracy    ${pct(validatorPassed, jsonFiles.length).padStart(7)}  (${validatorPassed}/${jsonFiles.length} tests match expected)`);
  console.log();
  console.log(`  ── Detection (Recall) ──────────────────────────────────`);
  console.log(`  Hallucinations in corpus   ${String(totalHallucinations).padStart(4)}`);
  console.log(`  Caught by ctxai            ${String(totalCaught).padStart(4)}  ${bar(totalCaught, totalHallucinations)}`);
  console.log(`  Missed                     ${String(totalMissed).padStart(4)}  ${bar(totalMissed, totalHallucinations)}`);
  console.log(`  Detection rate             ${pct(totalCaught, totalHallucinations).padStart(7)}`);
  console.log();
  console.log(`  ── Precision ───────────────────────────────────────────`);
  console.log(`  False positives            ${String(totalFalsePositives).padStart(4)}  (warnings on clean code)`);
  console.log(`  Precision                  ${pct(totalCaught, totalCaught + totalFalsePositives).padStart(7)}`);
  console.log();
  console.log(`  ── Overall ─────────────────────────────────────────────`);
  console.log(`  F1 Score                   ${(f1 * 100).toFixed(1).padStart(6)}%  (harmonic mean of precision + recall)`);
  console.log();

  // Per-category breakdown
  console.log(`  ── By Category ─────────────────────────────────────────`);
  const catNames = Object.keys(categories).sort();
  for (const name of catNames) {
    const c = categories[name];
    const catDetection = c.total > 0 ? pct(c.caught, c.total) : "—";
    const catFP        = c.fp > 0 ? ` ⚠ ${c.fp} FP` : "";
    console.log(`  ${name.padEnd(22)} tests: ${String(c.tests).padStart(2)}  detection: ${catDetection.padStart(6)}${catFP}`);
  }

  console.log(`\n${"═".repeat(60)}\n`);

  // ── Save full report ──────────────────────────────────────────────────────

  const summary = {
    runAt:              new Date().toISOString(),
    totalPrompts:       jsonFiles.length,
    validatorAccuracy:  `${pct(validatorPassed, jsonFiles.length)} (${validatorPassed}/${jsonFiles.length})`,
    hallucinationMetrics: {
      totalInCorpus:    totalHallucinations,
      caught:           totalCaught,
      missed:           totalMissed,
      detectionRate:    `${detectionRate.toFixed(1)}%`,
      falsePositives:   totalFalsePositives,
      precision:        `${precision.toFixed(1)}%`,
      f1Score:          `${(f1 * 100).toFixed(1)}%`,
    },
    byCategory: Object.fromEntries(
      catNames.map(n => [n, {
        tests:         categories[n].tests,
        passed:        categories[n].passed,
        hallucinations: categories[n].total,
        caught:        categories[n].caught,
        missed:        categories[n].missed,
        falsePositives: categories[n].fp,
        detectionRate: categories[n].total > 0
          ? `${pct(categories[n].caught, categories[n].total)}`
          : "N/A (no hallucinations expected)",
      }])
    ),
    results: report,
  };

  const reportPath = path.join(resultsDir, `run_${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2));
  console.log(`  📁 Full report → ${reportPath}\n`);
}

runBenchmarks().catch(console.error);
