// eval/compare.js — Diffs two eval JSON reports and outputs a markdown delta
// table or JSON showing which retrieval abilities improved, regressed, or held steady.
//
// Usage:
//   node eval/compare.js --baseline <path> --current <path> [--tolerance 0.05] [--format markdown|json]
//
// Exit codes:
//   0 — no regressions (or missing baseline)
//   1 — at least one ability regressed beyond tolerance
//   2 — invalid arguments or missing current file
//
// Testing strategy: verify-existing — verified by running the script directly.

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABILITY_DISPLAY_NAMES = {
  information_extraction: "Information Extraction",
  multi_hop:              "Multi-hop Reasoning",
  knowledge_updates:      "Knowledge Updates",
  keyword_metadata:       "Keyword Metadata",
  filtered_search:        "Filtered Search",
  abstention:             "Abstention (accuracy)",
};

// The keep-list of metric fields to compare. All other fields are ignored.
const KEEP_METRICS = [
  "recall_at_1",
  "recall_at_5",
  "recall_at_10",
  "ndcg_at_5",
  "ndcg_at_10",
  "abstention_accuracy",
];

// Primary metric per ability: recall_at_5 for retrieval, abstention_accuracy for abstention.
function primaryMetric(ability) {
  return ability === "abstention" ? "abstention_accuracy" : "recall_at_5";
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    baseline: null,
    current: null,
    tolerance: 0.05,
    format: "markdown",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--baseline") {
      if (!next || next.startsWith("--")) {
        console.error("Error: --baseline requires a file path argument.");
        process.exit(2);
      }
      args.baseline = next;
      i++;
    } else if (arg === "--current") {
      if (!next || next.startsWith("--")) {
        console.error("Error: --current requires a file path argument.");
        process.exit(2);
      }
      args.current = next;
      i++;
    } else if (arg === "--tolerance") {
      if (!next) {
        console.error("Error: --tolerance requires a numeric argument.");
        process.exit(2);
      }
      const val = parseFloat(next);
      if (isNaN(val)) {
        console.error(`Error: Invalid --tolerance value: ${next}. Must be a float.`);
        process.exit(2);
      }
      args.tolerance = val;
      i++;
    } else if (arg === "--format") {
      if (!next || !["markdown", "json"].includes(next)) {
        console.error(`Error: Invalid --format value: ${next}. Use markdown or json.`);
        process.exit(2);
      }
      args.format = next;
      i++;
    } else {
      console.error(`Error: Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (!args.baseline || !args.current) {
    console.error(
      "Error: --baseline and --current are required.\n" +
      "Usage: node eval/compare.js --baseline <path> --current <path> [--tolerance 0.05] [--format markdown|json]"
    );
    process.exit(2);
  }

  return args;
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function loadReport(filePath) {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

/**
 * Extract the primary metric value for an ability from a report's abilities map.
 * Returns null if the ability or metric is absent.
 */
function getPrimaryValue(abilityData, ability) {
  if (!abilityData) return null;
  const metric = primaryMetric(ability);
  const val = abilityData[metric];
  return typeof val === "number" ? val : null;
}

/**
 * Classify the status of a delta given the tolerance.
 *
 * Boundary values (exactly at ±tolerance) are "steady" per spec.
 */
function classify(delta, tolerance) {
  if (delta < -tolerance) return "regressed";
  if (delta > tolerance) return "improved";
  return "steady";
}

/**
 * Build the comparison result for all abilities across both reports.
 *
 * Returns:
 *   { abilities: { [ability]: { baseline, current, delta, status, metrics } }, pass, tolerance }
 */
function buildComparison(baselineReport, currentReport, tolerance) {
  const baselineAbilities = baselineReport.abilities || {};
  const currentAbilities = currentReport.abilities || {};

  const allAbilities = new Set([
    ...Object.keys(baselineAbilities),
    ...Object.keys(currentAbilities),
  ]);

  const abilities = {};
  let pass = true;

  for (const ability of allAbilities) {
    const inBaseline = ability in baselineAbilities;
    const inCurrent = ability in currentAbilities;

    if (!inBaseline) {
      // Ability only exists in current — "new"
      abilities[ability] = {
        baseline: null,
        current: getPrimaryValue(currentAbilities[ability], ability),
        delta: null,
        status: "new",
        metrics: {},
      };
      continue;
    }

    if (!inCurrent) {
      // Ability only exists in baseline — "removed" (does NOT set pass to false)
      abilities[ability] = {
        baseline: getPrimaryValue(baselineAbilities[ability], ability),
        current: null,
        delta: null,
        status: "removed",
        metrics: {},
      };
      continue;
    }

    // Ability in both — compute delta and status
    const baselineVal = getPrimaryValue(baselineAbilities[ability], ability);
    const currentVal = getPrimaryValue(currentAbilities[ability], ability);

    let delta = null;
    let status = "steady";

    if (baselineVal !== null && currentVal !== null) {
      delta = currentVal - baselineVal;
      status = classify(delta, tolerance);
    }

    if (status === "regressed") {
      pass = false;
    }

    // Build full metrics breakdown (keep-list only)
    const metrics = {};
    for (const metric of KEEP_METRICS) {
      const bVal = baselineAbilities[ability][metric];
      const cVal = currentAbilities[ability][metric];
      if (typeof bVal === "number" || typeof cVal === "number") {
        metrics[metric] = {
          baseline: typeof bVal === "number" ? bVal : null,
          current: typeof cVal === "number" ? cVal : null,
          delta: typeof bVal === "number" && typeof cVal === "number"
            ? cVal - bVal
            : null,
        };
      }
    }

    abilities[ability] = {
      baseline: baselineVal,
      current: currentVal,
      delta,
      status,
      metrics,
    };
  }

  return { abilities, pass, tolerance };
}

// ---------------------------------------------------------------------------
// Git commit hash helper
// ---------------------------------------------------------------------------

function getBaselineCommit(baselinePath) {
  try {
    const dir = path.dirname(path.resolve(baselinePath));
    const hash = execSync(`git -C "${dir}" log -1 --pretty=format:%h -- "${path.resolve(baselinePath)}"`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return hash || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const ABILITY_ORDER = [
  "information_extraction",
  "multi_hop",
  "knowledge_updates",
  "keyword_metadata",
  "filtered_search",
  "abstention",
];

function fmtVal(val) {
  if (val === null || val === undefined) return "—";
  return val.toFixed(2);
}

function fmtDelta(delta) {
  if (delta === null || delta === undefined) return "—";
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)}`;
}

function statusEmoji(status) {
  switch (status) {
    case "regressed": return ":x: regressed";
    case "improved":  return ":arrow_up: improved";
    case "steady":    return ":white_check_mark: steady";
    case "new":       return ":new: new";
    case "removed":   return ":wastebasket: removed";
    default:          return status;
  }
}

/** The column header label for the primary metric, per ability */
function primaryColumnLabel(ability) {
  return ability === "abstention" ? "Accuracy" : "Recall@5";
}

function metricDisplayName(metric) {
  const names = {
    recall_at_1:        "recall_at_1",
    recall_at_5:        "recall_at_5",
    recall_at_10:       "recall_at_10",
    ndcg_at_5:          "ndcg_at_5",
    ndcg_at_10:         "ndcg_at_10",
    abstention_accuracy:"abstention_accuracy",
  };
  return names[metric] || metric;
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function renderMarkdown(comparison, baselineCommit, tolerance) {
  const { abilities } = comparison;

  // Ordered list of abilities to render (known abilities first, then any unknown)
  const knownOrder = ABILITY_ORDER.filter((a) => a in abilities);
  const unknownOrder = Object.keys(abilities).filter(
    (a) => !ABILITY_ORDER.includes(a)
  );
  const ordered = [...knownOrder, ...unknownOrder];

  const lines = [];
  lines.push("<!-- eval-regression-report -->");
  lines.push("## Eval Regression Report");
  lines.push("");

  // Summary table — column header says "Recall@5" or "Accuracy" depending on ability.
  // Since we have mixed abilities in one table, we label it "Recall@5" for retrieval
  // and note abstention separately. Per spec, the column header is "Recall@5" for the
  // table, but the abstention row shows accuracy value in the same slot.
  lines.push("| Ability | Recall@5 | Delta | Status |");
  lines.push("|---------|----------|-------|--------|");

  for (const ability of ordered) {
    const a = abilities[ability];
    const displayName = ABILITY_DISPLAY_NAMES[ability] || ability;

    // For abstention, the column is labeled "Recall@5" in the header per spec
    // but the value shown is accuracy; the header note "(accuracy)" is in the display name.
    const valStr = fmtVal(a.current);
    const deltaStr = fmtDelta(a.delta);
    const statusStr = statusEmoji(a.status);

    lines.push(`| ${displayName} | ${valStr} | ${deltaStr} | ${statusStr} |`);
  }

  lines.push("");

  const commitNote = baselineCommit ? ` | **Baseline commit:** ${baselineCommit}` : "";
  lines.push(`**Tolerance:** ${tolerance}${commitNote}`);
  lines.push("");

  // Full metric breakdown in a collapsible <details> block
  lines.push("<details>");
  lines.push("<summary>Full metric breakdown</summary>");
  lines.push("");
  lines.push("| Ability | Metric | Baseline | Current | Delta |");
  lines.push("|---------|--------|----------|---------|-------|");

  for (const ability of ordered) {
    const a = abilities[ability];
    const displayName = ABILITY_DISPLAY_NAMES[ability] || ability;

    if (a.status === "new" || a.status === "removed") {
      // For new/removed, show the primary metric if available
      const metric = primaryMetric(ability);
      const bStr = fmtVal(a.baseline);
      const cStr = fmtVal(a.current);
      lines.push(`| ${displayName} | ${metricDisplayName(metric)} | ${bStr} | ${cStr} | — |`);
    } else {
      for (const [metric, m] of Object.entries(a.metrics)) {
        const bStr = fmtVal(m.baseline);
        const cStr = fmtVal(m.current);
        const dStr = fmtDelta(m.delta);
        lines.push(`| ${displayName} | ${metricDisplayName(metric)} | ${bStr} | ${cStr} | ${dStr} |`);
      }
    }
  }

  lines.push("");
  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function renderJson(comparison) {
  const { abilities, pass, tolerance } = comparison;

  const out = {
    pass,
    tolerance,
    abilities: {},
  };

  for (const [ability, a] of Object.entries(abilities)) {
    out.abilities[ability] = {
      baseline: a.baseline,
      current: a.current,
      delta: a.delta,
      status: a.status,
    };
  }

  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  // Check that --current file exists (exit 2 if missing)
  const currentPath = path.isAbsolute(args.current)
    ? args.current
    : path.resolve(process.cwd(), args.current);

  if (!fs.existsSync(currentPath)) {
    console.error(`Error: Current report not found: ${args.current}`);
    process.exit(2);
  }

  // Check that --baseline file exists (exit 0 with message if missing)
  const baselinePath = path.isAbsolute(args.baseline)
    ? args.baseline
    : path.resolve(process.cwd(), args.baseline);

  if (!fs.existsSync(baselinePath)) {
    console.log("No baseline found. Run the update-baseline workflow to establish one.");
    process.exit(0);
  }

  // Load reports
  let baselineReport, currentReport;
  try {
    baselineReport = loadReport(baselinePath);
  } catch (err) {
    console.error(`Error: Failed to parse baseline report: ${err.message}`);
    process.exit(2);
  }
  try {
    currentReport = loadReport(currentPath);
  } catch (err) {
    console.error(`Error: Failed to parse current report: ${err.message}`);
    process.exit(2);
  }

  // Build comparison
  const comparison = buildComparison(baselineReport, currentReport, args.tolerance);

  // Get baseline commit hash for markdown output
  const baselineCommit = getBaselineCommit(baselinePath);

  // Render output
  if (args.format === "json") {
    console.log(renderJson(comparison));
  } else {
    process.stdout.write(renderMarkdown(comparison, baselineCommit, args.tolerance));
  }

  // Exit code: 1 if any regression, 0 otherwise
  process.exit(comparison.pass ? 0 : 1);
}

main();
