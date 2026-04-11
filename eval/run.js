// eval/run.js — Orchestrator for the Lore eval benchmark harness.
// Build → generate corpus → generate questions → run test layers → aggregate → report → clean up.
// Testing strategy: verify-existing — no new test files; verified by running the script directly.

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { generateCorpus } from "./generate/corpus.js";
import { generateQuestions } from "./generate/questions.js";
import { runUnitLayer } from "./layers/unit.js";
import { runIntegrationLayer } from "./layers/integration.js";
import {
  recallAtK,
  ndcgAtK,
  abstentionAccuracy,
  latencyStats,
} from "./scoring/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    tier: "small",
    layer: "all",
    threshold: null,
    maxLatencyMs: 200,
    output: "eval/results/",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--tier") {
      if (!["small", "medium", "large"].includes(next)) {
        console.error(`Invalid --tier value: ${next}. Use small, medium, or large.`);
        process.exit(2);
      }
      args.tier = next;
      i++;
    } else if (arg === "--layer") {
      if (!["unit", "integration", "all"].includes(next)) {
        console.error(`Invalid --layer value: ${next}. Use unit, integration, or all.`);
        process.exit(2);
      }
      args.layer = next;
      i++;
    } else if (arg === "--threshold") {
      const val = parseFloat(next);
      if (isNaN(val)) {
        console.error(`Invalid --threshold value: ${next}. Must be a float.`);
        process.exit(2);
      }
      args.threshold = val;
      i++;
    } else if (arg === "--max-latency-ms") {
      const val = parseInt(next, 10);
      if (isNaN(val)) {
        console.error(`Invalid --max-latency-ms value: ${next}. Must be an integer.`);
        process.exit(2);
      }
      args.maxLatencyMs = val;
      i++;
    } else if (arg === "--output") {
      args.output = next;
      i++;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Build step
// ---------------------------------------------------------------------------
function runBuild() {
  try {
    execSync("npm run build", {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : String(err);
    process.stderr.write(`Build failed:\n${stderr}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate integration results into per-ability metrics.
 *
 * @param {Array} integrationResults
 * @returns {Object} Map of ability -> metrics
 */
function aggregateIntegration(integrationResults) {
  // Group by ability
  const byAbility = {};
  for (const r of integrationResults) {
    if (!byAbility[r.ability]) byAbility[r.ability] = [];
    byAbility[r.ability].push(r);
  }

  const abilityMetrics = {};

  for (const [ability, results] of Object.entries(byAbility)) {
    if (ability === "abstention") {
      // Mean abstentionAcc across all questions
      const mean =
        results.reduce((sum, r) => sum + r.abstentionAcc, 0) / results.length;
      const latencies = results.map((r) => r.latencyMs);
      const stats = latencyStats(latencies);
      abilityMetrics[ability] = {
        abstention_accuracy: mean,
        question_count: results.length,
        latency_p50_ms: Math.round(stats.p50),
        latency_p95_ms: Math.round(stats.p95),
        latency_max_ms: Math.round(stats.max),
      };
    } else {
      // Re-compute recall at 1, 5, 10 from raw retrieved/expected data
      let sumR1 = 0, sumR5 = 0, sumR10 = 0;
      let sumN5 = 0, sumN10 = 0;
      const latencies = [];

      for (const r of results) {
        sumR1  += recallAtK(r.retrieved_titles, r.expected_titles, 1);
        sumR5  += recallAtK(r.retrieved_titles, r.expected_titles, 5);
        sumR10 += recallAtK(r.retrieved_titles, r.expected_titles, 10);
        // Use grades if available (stored on the result via question)
        // NOTE: the integration layer stores the question's grades on the result
        // via ndcg at question.k; to compute ndcg@5 and @10 we need the grades
        // object.  However integration.js doesn't carry grades on the result object.
        // We recompute using binary relevance for aggregation (consistent with spec
        // which says "re-compute from raw retrieved/expected data").
        sumN5  += ndcgAtK(r.retrieved_titles, r.expected_titles, 5);
        sumN10 += ndcgAtK(r.retrieved_titles, r.expected_titles, 10);
        latencies.push(r.latencyMs);
      }

      const n = results.length;
      const stats = latencyStats(latencies);

      abilityMetrics[ability] = {
        recall_at_1:  sumR1  / n,
        recall_at_5:  sumR5  / n,
        recall_at_10: sumR10 / n,
        ndcg_at_5:    sumN5  / n,
        ndcg_at_10:   sumN10 / n,
        question_count: n,
        latency_p50_ms: Math.round(stats.p50),
        latency_p95_ms: Math.round(stats.p95),
        latency_max_ms: Math.round(stats.max),
      };
    }
  }

  return abilityMetrics;
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

const ABILITY_DISPLAY_NAMES = {
  information_extraction: "Information Extraction",
  multi_hop:              "Multi-hop Reasoning",
  knowledge_updates:      "Knowledge Updates",
  keyword_metadata:       "Keyword Metadata",
  filtered_search:        "Filtered Search",
  abstention:             "Abstention (accuracy)",
};

// Column widths — right-aligned data columns; wide enough to include leading
// whitespace gap so columns don't run together.
const COL_ABILITY = 26;
const COL_R1      = 10; // "  Recall@1" = 10
const COL_R5      = 10; // "  Recall@5" = 10
const COL_R10     = 11; // "  Recall@10" = 11
const COL_N5      =  8; // "  NDCG@5" = 8
const COL_N10     =  9; // "  NDCG@10" = 9
const COL_P50     =  7; // "  p50ms" = 7
const COL_P95     =  7; // "  p95ms" = 7

function fmt2(n) {
  return n.toFixed(2);
}

function fmtCell(val, width) {
  return String(val).padStart(width);
}

function printTable(abilityMetrics, includeLatency, integrationResults) {
  // Header
  let header = "Ability".padEnd(COL_ABILITY);
  header += fmtCell("Recall@1",  COL_R1);
  header += fmtCell("Recall@5",  COL_R5);
  header += fmtCell("Recall@10", COL_R10);
  header += fmtCell("NDCG@5",   COL_N5);
  header += fmtCell("NDCG@10",  COL_N10);
  if (includeLatency) {
    header += fmtCell("p50ms", COL_P50);
    header += fmtCell("p95ms", COL_P95);
  }
  console.log(header);

  const ABILITY_ORDER = [
    "information_extraction",
    "multi_hop",
    "knowledge_updates",
    "keyword_metadata",
    "filtered_search",
    "abstention",
  ];

  for (const ability of ABILITY_ORDER) {
    const m = abilityMetrics[ability];
    if (!m) continue;

    const displayName = (ABILITY_DISPLAY_NAMES[ability] || ability).padEnd(COL_ABILITY);

    if (ability === "abstention") {
      // Only show accuracy under Recall@5 column; dashes elsewhere
      const acc = fmt2(m.abstention_accuracy);
      let row = displayName;
      row += fmtCell("-",   COL_R1);
      row += fmtCell(acc,   COL_R5);
      row += fmtCell("-",   COL_R10);
      row += fmtCell("-",   COL_N5);
      row += fmtCell("-",   COL_N10);
      if (includeLatency) {
        row += fmtCell(m.latency_p50_ms, COL_P50);
        row += fmtCell(m.latency_p95_ms, COL_P95);
      }
      console.log(row);
    } else {
      let row = displayName;
      row += fmtCell(fmt2(m.recall_at_1),  COL_R1);
      row += fmtCell(fmt2(m.recall_at_5),  COL_R5);
      row += fmtCell(fmt2(m.recall_at_10), COL_R10);
      row += fmtCell(fmt2(m.ndcg_at_5),   COL_N5);
      row += fmtCell(fmt2(m.ndcg_at_10),  COL_N10);
      if (includeLatency) {
        row += fmtCell(m.latency_p50_ms, COL_P50);
        row += fmtCell(m.latency_p95_ms, COL_P95);
      }
      console.log(row);
    }
  }

  // Overall latency row (integration only)
  if (includeLatency && integrationResults && integrationResults.length > 0) {
    const allLatencies = integrationResults.map((r) => r.latencyMs);
    const overall = latencyStats(allLatencies);
    let row = "Overall".padEnd(COL_ABILITY);
    row += fmtCell("-", COL_R1);
    row += fmtCell("-", COL_R5);
    row += fmtCell("-", COL_R10);
    row += fmtCell("-", COL_N5);
    row += fmtCell("-", COL_N10);
    row += fmtCell(Math.round(overall.p50), COL_P50);
    row += fmtCell(Math.round(overall.p95), COL_P95);
    console.log(row);
  }
}

// ---------------------------------------------------------------------------
// Threshold checking
// ---------------------------------------------------------------------------

/**
 * Check if all abilities pass the threshold.
 * Returns { pass: boolean, failures: string[] }
 */
function checkThresholds(abilityMetrics, threshold, maxLatencyMs, layer, integrationResults) {
  const failures = [];

  for (const [ability, m] of Object.entries(abilityMetrics)) {
    if (ability === "abstention") {
      if (m.abstention_accuracy < threshold) {
        failures.push(
          `Abstention accuracy ${fmt2(m.abstention_accuracy)} < threshold ${fmt2(threshold)}`
        );
      }
    } else {
      if (m.recall_at_5 < threshold) {
        failures.push(
          `${ABILITY_DISPLAY_NAMES[ability] || ability} recall@5 ${fmt2(m.recall_at_5)} < threshold ${fmt2(threshold)}`
        );
      }
    }
  }

  // Latency check (integration layer only)
  if (layer !== "unit" && integrationResults && integrationResults.length > 0) {
    const allLatencies = integrationResults.map((r) => r.latencyMs);
    const overall = latencyStats(allLatencies);
    if (overall.p95 > maxLatencyMs) {
      failures.push(
        `Overall p95 latency ${Math.round(overall.p95)}ms > max ${maxLatencyMs}ms`
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

async function writeReport(
  outputDir,
  { tier, layer, corpusSize, abilityMetrics, integrationResults, unitResults, threshold, maxLatencyMs, pass, questions }
) {
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const ts = timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  // Build per-ability section
  const abilities = {};
  for (const [ability, m] of Object.entries(abilityMetrics)) {
    if (ability === "abstention") {
      abilities[ability] = {
        abstention_accuracy: m.abstention_accuracy,
        latency_p50_ms: m.latency_p50_ms ?? null,
        latency_p95_ms: m.latency_p95_ms ?? null,
        latency_max_ms: m.latency_max_ms ?? null,
        question_count: m.question_count,
      };
    } else {
      abilities[ability] = {
        recall_at_1:     m.recall_at_1,
        recall_at_5:     m.recall_at_5,
        recall_at_10:    m.recall_at_10,
        ndcg_at_5:       m.ndcg_at_5,
        ndcg_at_10:      m.ndcg_at_10,
        latency_p50_ms:  m.latency_p50_ms ?? null,
        latency_p95_ms:  m.latency_p95_ms ?? null,
        latency_max_ms:  m.latency_max_ms ?? null,
        question_count:  m.question_count,
      };
    }
  }

  // Overall latency
  let overallLatency = { p50_ms: null, p95_ms: null, max_ms: null };
  if (integrationResults && integrationResults.length > 0) {
    const allLatencies = integrationResults.map((r) => r.latencyMs);
    const stats = latencyStats(allLatencies);
    overallLatency = {
      p50_ms: Math.round(stats.p50),
      p95_ms: Math.round(stats.p95),
      max_ms: Math.round(stats.max),
    };
  }

  // per_question: integration results with latency_ms field name
  const perQuestion = integrationResults
    ? integrationResults.map((r) => ({
        id: r.id,
        ability: r.ability,
        query: r.query,
        expected_titles: r.expected_titles,
        retrieved_titles: r.retrieved_titles,
        recall: r.recall,
        ndcg: r.ndcg,
        abstention_acc: r.abstentionAcc,
        latency_ms: r.latencyMs,
        status: r.status,
      }))
    : [];

  const report = {
    timestamp,
    tier,
    layer,
    corpus_size: corpusSize,
    abilities,
    overall_latency: overallLatency,
    threshold,
    max_latency_ms: maxLatencyMs,
    pass,
    unit_results: unitResults || [],
    per_question: perQuestion,
  };

  const reportPath = path.join(outputDir, `report-${ts}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport written to: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  // Step 1: Build
  runBuild();

  let tempDir = null;
  let exitCode = 0;

  try {
    // Step 2: Generate corpus
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lore-eval-"));
    const manifest = await generateCorpus(args.tier, tempDir);
    const corpusSize = Object.keys(manifest).length;

    // Step 3: Generate questions
    const questions = generateQuestions(manifest, args.tier);

    // Step 4: Run selected layers
    let unitResults = null;
    let integrationResults = null;

    if (args.layer === "unit" || args.layer === "all") {
      process.stdout.write("Running unit layer...\n");
      unitResults = await runUnitLayer();
      const passed = unitResults.filter((r) => r.passed).length;
      process.stdout.write(
        `Unit layer: ${passed}/${unitResults.length} tests passed\n\n`
      );
    }

    if (args.layer === "integration" || args.layer === "all") {
      process.stdout.write("Running integration layer...\n");
      integrationResults = await runIntegrationLayer(questions, tempDir);
      const ok = integrationResults.filter((r) => r.status !== "server_error").length;
      process.stdout.write(
        `Integration layer: ${ok}/${integrationResults.length} questions completed\n\n`
      );

      // Check for server errors → exit code 2
      const hasServerError = integrationResults.some(
        (r) => r.status === "server_error"
      );
      if (hasServerError) {
        exitCode = 2;
      }
    }

    // Step 5: Aggregate
    const abilityMetrics = {};

    if (integrationResults && integrationResults.length > 0) {
      const agg = aggregateIntegration(integrationResults);
      Object.assign(abilityMetrics, agg);
    }

    // For unit-only runs: produce a summary from unit results
    if (args.layer === "unit" && unitResults) {
      // No integration metrics; produce empty structure for table/report
      // Unit tests are reported separately
    }

    // Step 6: Print table
    const includeLatency = args.layer !== "unit";
    if (Object.keys(abilityMetrics).length > 0) {
      printTable(abilityMetrics, includeLatency, integrationResults);
    } else if (args.layer === "unit" && unitResults) {
      // Print unit test summary
      console.log("\nUnit Test Results:");
      for (const r of unitResults) {
        const status = r.passed ? "PASS" : "FAIL";
        console.log(`  [${status}] ${r.id} (${r.ability}): ${r.details}`);
      }
    }

    // Step 7: Threshold check
    let pass = true;
    if (args.threshold !== null && exitCode === 0) {
      const { pass: thresholdPass, failures } = checkThresholds(
        abilityMetrics,
        args.threshold,
        args.maxLatencyMs,
        args.layer,
        integrationResults
      );
      pass = thresholdPass;
      if (!pass) {
        exitCode = 1;
        console.log("\nThreshold failures:");
        for (const f of failures) {
          console.log(`  - ${f}`);
        }
      }
    }

    // Step 8: Write JSON report
    const outputDir = path.isAbsolute(args.output)
      ? args.output
      : path.join(PROJECT_ROOT, args.output);

    await writeReport(outputDir, {
      tier: args.tier,
      layer: args.layer,
      corpusSize,
      abilityMetrics,
      integrationResults,
      unitResults,
      threshold: args.threshold,
      maxLatencyMs: args.maxLatencyMs,
      pass,
      questions,
    });
  } finally {
    // Step 9: Clean up temp dir
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
  }
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n${err.stack}\n`);
  process.exit(2);
});
