// eval/layers/unit.js — Direct-call unit tests against scoring internals and metric functions.

import {
  computeBM25Scores,
  tokenize,
  confidenceBonus,
  applyLinkBoost,
  extractWikilinks,
  decomposeQuery,
} from "../../dist/scoring.js";

import { recallAtK, ndcgAtK } from "../scoring/metrics.js";

/**
 * BM25 correctness: given a hand-crafted corpus and query, assert that the
 * most relevant documents rank highest.
 */
function testBM25Correctness() {
  const id = "unit-bm25";
  const ability = "bm25_correctness";
  try {
    const documents = [
      {
        path: "billing/invoices.md",
        title: "Billing Invoices",
        content:
          "---\ntitle: Billing Invoices\ntype: concept\n---\n\nThis document covers billing invoices and invoice management for payment cycles.",
        frontmatter: { title: "Billing Invoices", type: "concept" },
      },
      {
        path: "tenants/leases.md",
        title: "Tenant Leases",
        content:
          "---\ntitle: Tenant Leases\ntype: concept\n---\n\nThis document covers tenant lease agreements, rental terms, and occupancy rules.",
        frontmatter: { title: "Tenant Leases", type: "concept" },
      },
      {
        path: "maintenance/plumbing.md",
        title: "Plumbing Repairs",
        content:
          "---\ntitle: Plumbing Repairs\ntype: concept\n---\n\nThis document covers plumbing repairs, pipe maintenance, and water system inspections.",
        frontmatter: { title: "Plumbing Repairs", type: "concept" },
      },
      {
        path: "billing/payments.md",
        title: "Payment Processing",
        content:
          "---\ntitle: Payment Processing\ntype: concept\n---\n\nThis document covers payment processing workflows, billing cycles, and invoice reconciliation.",
        frontmatter: { title: "Payment Processing", type: "concept" },
      },
      {
        path: "maintenance/roof.md",
        title: "Roof Inspection",
        content:
          "---\ntitle: Roof Inspection\ntype: concept\n---\n\nThis document covers roof inspection procedures and structural maintenance schedules.",
        frontmatter: { title: "Roof Inspection", type: "concept" },
      },
    ];

    const query = "invoice payment billing";
    const results = computeBM25Scores(query, documents);

    // Sort by score descending
    const sorted = [...results].sort((a, b) => b.score - a.score);

    if (sorted.length < 2) {
      return {
        id,
        ability,
        passed: false,
        details: `Expected at least 2 results, got ${sorted.length}`,
      };
    }

    const topTwo = sorted.slice(0, 2).map((r) => r.title);
    const expectedTitles = new Set(["Billing Invoices", "Payment Processing"]);
    const topTwoHitAll =
      topTwo.every((t) => expectedTitles.has(t)) && topTwo.length === 2;

    if (!topTwoHitAll) {
      return {
        id,
        ability,
        passed: false,
        details: `Expected top-2 to be billing/payment docs, got: ${topTwo.join(", ")}`,
      };
    }

    return {
      id,
      ability,
      passed: true,
      details: `Top-2 docs are ${topTwo.join(", ")} as expected`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Confidence bonus: assert known return values for each confidence level.
 */
function testConfidenceBonus() {
  const id = "unit-confidence";
  const ability = "confidence_bonus";
  try {
    const verifiedBonus = confidenceBonus("verified");
    const inferredBonus = confidenceBonus("inferred");
    const undefinedBonus = confidenceBonus(undefined);

    const checks = [
      {
        label: 'confidenceBonus("verified") === 0.3',
        ok: verifiedBonus === 0.3,
        got: verifiedBonus,
      },
      {
        label: 'confidenceBonus("inferred") === 0.15',
        ok: inferredBonus === 0.15,
        got: inferredBonus,
      },
      {
        label: "confidenceBonus(undefined) === 0",
        ok: undefinedBonus === 0,
        got: undefinedBonus,
      },
    ];

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const detail = failed
        .map((c) => `${c.label} (got ${c.got})`)
        .join("; ");
      return { id, ability, passed: false, details: `Failures: ${detail}` };
    }

    return {
      id,
      ability,
      passed: true,
      details: "verified=0.3, inferred=0.15, undefined=0",
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Link boost: assert that higher inbound counts produce higher scores.
 */
function testLinkBoost() {
  const id = "unit-linkboost";
  const ability = "link_boost";
  try {
    const makeFrontmatter = () => ({ title: "", type: "concept" });

    const results = [
      {
        path: "a.md",
        title: "Entry A",
        score: 1.0,
        content: "",
        frontmatter: makeFrontmatter(),
      },
      {
        path: "b.md",
        title: "Entry B",
        score: 1.0,
        content: "",
        frontmatter: makeFrontmatter(),
      },
      {
        path: "c.md",
        title: "Entry C",
        score: 1.0,
        content: "",
        frontmatter: makeFrontmatter(),
      },
    ];

    const inboundCounts = new Map([
      ["entry a", 10],
      ["entry b", 1],
      // Entry C has no inbound links (0)
    ]);

    const boosted = applyLinkBoost(results, inboundCounts);

    const a = boosted.find((r) => r.title === "Entry A");
    const b = boosted.find((r) => r.title === "Entry B");
    const c = boosted.find((r) => r.title === "Entry C");

    if (!a || !b || !c) {
      return {
        id,
        ability,
        passed: false,
        details: "Could not find boosted results by title",
      };
    }

    if (!(a.score > b.score && b.score > c.score)) {
      return {
        id,
        ability,
        passed: false,
        details: `Expected A.score > B.score > C.score, got A=${a.score.toFixed(4)} B=${b.score.toFixed(4)} C=${c.score.toFixed(4)}`,
      };
    }

    return {
      id,
      ability,
      passed: true,
      details: `A=${a.score.toFixed(4)} > B=${b.score.toFixed(4)} > C=${c.score.toFixed(4)}`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Metric functions: assert recallAtK and ndcgAtK produce known values for
 * hand-crafted inputs.
 */
function testMetrics() {
  const id = "unit-metrics";
  const ability = "metrics";
  try {
    const checks = [];

    // recallAtK: perfect retrieval
    checks.push({
      label: 'recallAtK(["a","b","c"], ["a","b"], 3) === 1.0',
      ok: recallAtK(["a", "b", "c"], ["a", "b"], 3) === 1.0,
    });

    // recallAtK: completely wrong
    checks.push({
      label: 'recallAtK(["x","y","z"], ["a","b"], 3) === 0.0',
      ok: recallAtK(["x", "y", "z"], ["a", "b"], 3) === 0.0,
    });

    // recallAtK: partial (1 of 2 expected found)
    checks.push({
      label: 'recallAtK(["a","x","y"], ["a","b"], 3) === 0.5',
      ok: recallAtK(["a", "x", "y"], ["a", "b"], 3) === 0.5,
    });

    // recallAtK: empty expected (vacuous truth)
    checks.push({
      label: "recallAtK([], [], 5) === 1.0",
      ok: recallAtK([], [], 5) === 1.0,
    });

    // ndcgAtK: perfect binary retrieval
    checks.push({
      label: 'ndcgAtK(["a","b"], ["a","b"], 2) === 1.0',
      ok: ndcgAtK(["a", "b"], ["a", "b"], 2) === 1.0,
    });

    // ndcgAtK: reversed order still yields 1.0 with binary relevance
    checks.push({
      label: 'ndcgAtK(["b","a"], ["a","b"], 2) === 1.0',
      ok: ndcgAtK(["b", "a"], ["a", "b"], 2) === 1.0,
    });

    // ndcgAtK: completely wrong
    checks.push({
      label: 'ndcgAtK(["x","y"], ["a","b"], 2) === 0.0',
      ok: ndcgAtK(["x", "y"], ["a", "b"], 2) === 0.0,
    });

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const detail = failed.map((c) => c.label).join("; ");
      return { id, ability, passed: false, details: `Failed: ${detail}` };
    }

    return {
      id,
      ability,
      passed: true,
      details: `All ${checks.length} metric assertions passed`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Wikilink extraction: assert [[links]] are parsed correctly and code blocks
 * are ignored.
 */
function testWikilinkExtraction() {
  const id = "unit-wikilinks";
  const ability = "wikilink_extraction";
  try {
    const checks = [];

    // Basic extraction
    const basic = extractWikilinks("See [[Topic A]] and [[Topic B]]");
    checks.push({
      label: "extracts [[Topic A]] and [[Topic B]]",
      ok:
        basic.length === 2 &&
        basic.includes("Topic A") &&
        basic.includes("Topic B"),
      got: JSON.stringify(basic),
    });

    // Fenced code block ignored
    const fenced = extractWikilinks(
      "```\n[[Not a link]]\n```\nSee [[Real Link]]"
    );
    checks.push({
      label: "ignores [[Not a link]] inside fenced code block",
      ok: fenced.length === 1 && fenced[0] === "Real Link",
      got: JSON.stringify(fenced),
    });

    // Inline code ignored
    const inline = extractWikilinks(
      "Use `[[inline code]]` and [[Actual]]"
    );
    checks.push({
      label: "ignores [[inline code]] inside backtick inline code",
      ok: inline.length === 1 && inline[0] === "Actual",
      got: JSON.stringify(inline),
    });

    // Deduplication
    const dupes = extractWikilinks("[[Topic A]] and again [[Topic A]]");
    checks.push({
      label: "deduplicates repeated [[Topic A]]",
      ok: dupes.length === 1 && dupes[0] === "Topic A",
      got: JSON.stringify(dupes),
    });

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const detail = failed
        .map((c) => `${c.label} (got ${c.got})`)
        .join("; ");
      return { id, ability, passed: false, details: `Failures: ${detail}` };
    }

    return {
      id,
      ability,
      passed: true,
      details: `All ${checks.length} wikilink extraction assertions passed`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Decompose query: assert that compound queries are split correctly and simple
 * queries pass through unchanged.
 */
function testDecomposeQuery() {
  const id = "unit-decompose-query";
  const ability = "decompose_query";
  try {
    const checks = [];

    // Simple query — no decomposition
    const simple = decomposeQuery("billing rules");
    checks.push({
      label: '"billing rules" returns ["billing rules"]',
      ok: simple.length === 1 && simple[0] === "billing rules",
      got: JSON.stringify(simple),
    });

    // Compound with "and what"
    const compound = decomposeQuery(
      "what role handles terminations and what is the notice period"
    );
    checks.push({
      label: "compound 'and what' query returns 2 parts",
      ok: compound.length === 2,
      got: JSON.stringify(compound),
    });

    // Semicolons
    const semicolons = decomposeQuery(
      "explain the billing rules; what are the tenant policies"
    );
    checks.push({
      label: "semicolon-separated query returns 2 parts",
      ok: semicolons.length === 2,
      got: JSON.stringify(semicolons),
    });

    // Question marks
    const questions = decomposeQuery(
      "what is BM25 scoring? how does retrieval work"
    );
    checks.push({
      label: "question-mark-separated query returns 2 parts",
      ok: questions.length === 2,
      got: JSON.stringify(questions),
    });

    // Sub-part under 15 chars gets filtered
    const shortPart = decomposeQuery("hello and what is x");
    checks.push({
      label: "sub-part under 15 chars gets filtered, returns original",
      ok:
        shortPart.length === 1 &&
        shortPart[0] === "hello and what is x",
      got: JSON.stringify(shortPart),
    });

    // Casual "and" without question word — no split
    const casual = decomposeQuery("roles and responsibilities in billing");
    checks.push({
      label: 'casual "and" without question word returns original',
      ok:
        casual.length === 1 &&
        casual[0] === "roles and responsibilities in billing",
      got: JSON.stringify(casual),
    });

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      const detail = failed
        .map((c) => `${c.label} (got ${c.got})`)
        .join("; ");
      return { id, ability, passed: false, details: `Failures: ${detail}` };
    }

    return {
      id,
      ability,
      passed: true,
      details: `All ${checks.length} decomposeQuery assertions passed`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Metadata weighting: assert that metadata matches score higher than body-only
 * matches due to METADATA_WEIGHT (2.0x) boost.
 */
function testMetadataWeighting() {
  const id = "unit-metadata-weighting";
  const ability = "metadata_weighting";
  try {
    const documents = [
      {
        path: "billing/concepts.md",
        title: "Billing Concepts",
        content:
          "---\ntitle: Billing Concepts\ndomain: billing\ntype: concept\n---\n\nThis document covers general accounting concepts and payment workflows.",
        frontmatter: {
          title: "Billing Concepts",
          domain: "billing",
          type: "concept",
        },
      },
      {
        path: "tenants/overview.md",
        title: "Tenant Overview",
        content:
          "---\ntitle: Tenant Overview\ndomain: tenants\ntype: entity\n---\n\nThis document covers tenant management. The billing process is handled elsewhere.",
        frontmatter: {
          title: "Tenant Overview",
          domain: "tenants",
          type: "entity",
        },
      },
    ];

    const query = "billing";
    const results = computeBM25Scores(query, documents);

    const docA = results.find((r) => r.title === "Billing Concepts");
    const docB = results.find((r) => r.title === "Tenant Overview");

    if (!docA || !docB) {
      return {
        id,
        ability,
        passed: false,
        details: `Expected both docs to have scores, got: ${JSON.stringify(results.map((r) => r.title))}`,
      };
    }

    if (!(docA.score > docB.score)) {
      return {
        id,
        ability,
        passed: false,
        details: `Expected metadata-match doc (A=${docA.score.toFixed(4)}) to score higher than body-only doc (B=${docB.score.toFixed(4)})`,
      };
    }

    return {
      id,
      ability,
      passed: true,
      details: `Metadata match A=${docA.score.toFixed(4)} > body-only B=${docB.score.toFixed(4)}`,
    };
  } catch (err) {
    return { id, ability, passed: false, details: `Error: ${err.message}` };
  }
}

/**
 * Run all unit tests and return results array.
 * Each result: { id, ability, passed, details }
 */
export async function runUnitLayer() {
  const results = [
    testBM25Correctness(),
    testConfidenceBonus(),
    testLinkBoost(),
    testMetrics(),
    testWikilinkExtraction(),
    testDecomposeQuery(),
    testMetadataWeighting(),
  ];
  return results;
}
