// eval/generate/corpus.js — Synthetic corpus generator for the Lore eval benchmark harness.
// Generates a lore-compatible directory structure with seeded-PRNG determinism.
// Testing strategy: verify-existing — correctness verified via the spec's verification command.

import { buildPage } from "../../dist/scoring.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Seeded Linear Congruential Generator
// Constants: multiplier=1664525, increment=1013904223, modulus=2^32
// ---------------------------------------------------------------------------
export class LCG {
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  float() {
    return this.next() / 0x100000000;
  }

  int(min, max) {
    return min + (this.next() % (max - min + 1));
  }

  pick(arr) {
    return arr[this.next() % arr.length];
  }

  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.next() % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
const VOCAB = {
  billing: {
    nouns: [
      "invoice", "payment", "ledger", "receipt", "statement", "charge",
      "credit", "debit", "subscription", "refund", "balance", "account",
      "transaction", "billing", "fee", "rate", "discount", "proration",
      "overage", "threshold", "quota", "cycle", "period", "renewal",
    ],
  },
  tenants: {
    nouns: [
      "lease", "occupant", "unit", "tenant", "landlord", "property",
      "agreement", "deposit", "eviction", "notice", "renewal", "vacancy",
      "screening", "application", "onboarding", "offboarding", "occupancy",
      "sublease", "guarantor", "cotenancy", "holdover", "termination",
      "portfolio", "building",
    ],
  },
  maintenance: {
    nouns: [
      "repair", "inspection", "plumbing", "electrical", "hvac", "roofing",
      "fixture", "appliance", "technician", "workorder", "schedule",
      "preventive", "reactive", "vendor", "contractor", "permit", "safety",
      "compliance", "warranty", "parts", "downtime", "escalation", "priority",
    ],
  },
};

const MODIFIERS = [
  "processing", "management", "validation", "override", "tracking",
  "reporting", "configuration", "integration", "automation", "policy",
  "workflow", "escalation", "approval", "auditing", "reconciliation",
  "enforcement", "resolution", "delegation", "archival", "notification",
];

const TYPE_LABELS = {
  concept: "Concept",
  entity: "Entity",
  rule: "Rule",
  role: "Role",
  decision: "Decision",
  glossary: "Glossary",
  source: "Source",
};

const TYPE_DIR = {
  concept: "concepts",
  entity: "entities",
  rule: "rules",
  role: "roles",
  decision: "decisions",
  glossary: "glossary",
  source: "sources",
};

// Entry type distribution: 24% concepts, 20% entities, 16% rules, 10% roles,
// 10% decisions, 10% glossary, 10% sources.  The remaining ~6% rounds into concepts.
// We build a pool of 100 slots and cycle through it.
const TYPE_POOL = [
  ...Array(24).fill("concept"),
  ...Array(20).fill("entity"),
  ...Array(16).fill("rule"),
  ...Array(10).fill("role"),
  ...Array(10).fill("decision"),
  ...Array(10).fill("glossary"),
  ...Array(10).fill("source"),
];
// 100 entries in the pool

const DOMAINS = ["billing", "tenants", "maintenance"];
const CONFIDENCES = [
  ...Array(30).fill("verified"),
  ...Array(40).fill("inferred"),
  ...Array(30).fill("assumed"),
];

const TIER_CONFIG = {
  small: { entries: 50 },
  medium: { entries: 200 },
  large: { entries: 500 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function dateFromOffset(startMs, offsetDays) {
  const d = new Date(startMs + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// BFS connectivity check — returns array of connected component arrays (by index).
function findComponents(n, adjacency) {
  const visited = new Array(n).fill(false);
  const components = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const comp = [];
    const queue = [start];
    visited[start] = true;
    while (queue.length > 0) {
      const node = queue.shift();
      comp.push(node);
      for (const neighbor of adjacency[node]) {
        if (!visited[neighbor]) {
          visited[neighbor] = true;
          queue.push(neighbor);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
export async function generateCorpus(tier, outputDir) {
  const config = TIER_CONFIG[tier];
  if (!config) throw new Error(`Unknown tier: ${tier}. Use small, medium, or large.`);

  const rng = new LCG(42);
  const totalEntries = config.entries;
  const startMs = Date.parse("2025-01-01");
  const rangeHalf = 182; // ~half of 365

  // -------------------------------------------------------------------------
  // Phase 1: Plan all base entries (before version pairs)
  // -------------------------------------------------------------------------
  // We'll generate floor(totalEntries * 0.9) base entries, then add v2 pairs
  // for 10% of those, staying within totalEntries.
  // Total slots = totalEntries. v2 count = floor(totalEntries * 0.1).
  // base count = totalEntries - v2count.
  const v2Count = Math.floor(totalEntries * 0.1);
  const baseCount = totalEntries - v2Count;

  // Build proportional type array for baseCount entries, then shuffle
  // Distribution: 24% concepts, 20% entities, 16% rules, 10% roles,
  //               10% decisions, 10% glossary, 10% sources
  const RATIOS = [
    ["concept",  0.24],
    ["entity",   0.20],
    ["rule",     0.16],
    ["role",     0.10],
    ["decision", 0.10],
    ["glossary", 0.10],
    ["source",   0.10],
  ];
  const typePool = [];
  let assigned = 0;
  for (let r = 0; r < RATIOS.length; r++) {
    const [typeName, ratio] = RATIOS[r];
    // For the last type, use remainder to avoid rounding gaps
    const count = r === RATIOS.length - 1
      ? baseCount - assigned
      : Math.round(ratio * baseCount);
    for (let j = 0; j < count; j++) typePool.push(typeName);
    assigned += count;
  }
  const types = rng.shuffle(typePool);

  // Assign domains and confidences
  const shuffledDomains = [];
  for (let i = 0; i < baseCount; i++) {
    shuffledDomains.push(DOMAINS[rng.next() % DOMAINS.length]);
  }

  const shuffledConf = rng.shuffle(CONFIDENCES);
  const confidences = [];
  for (let i = 0; i < baseCount; i++) {
    confidences.push(shuffledConf[i % shuffledConf.length]);
  }

  // Unique compound term counter (global, ensures no duplicates across corpus)
  let termSeq = 0;

  function makeUniqueTerms(domain, count) {
    const nouns = VOCAB[domain].nouns;
    const terms = [];
    for (let i = 0; i < count; i++) {
      const noun = nouns[rng.next() % nouns.length];
      const mod = MODIFIERS[rng.next() % MODIFIERS.length];
      terms.push(`${noun}-${mod}-${termSeq++}`);
    }
    return terms;
  }

  // Build base entry metadata (no wikilinks yet)
  const entries = [];
  const titleSet = new Set();

  for (let i = 0; i < baseCount; i++) {
    const domain = shuffledDomains[i];
    const type = types[i];
    const confidence = confidences[i];
    const nouns = VOCAB[domain].nouns;

    const noun = nouns[rng.next() % nouns.length];
    const mod = MODIFIERS[rng.next() % MODIFIERS.length];
    const typeLabel = TYPE_LABELS[type];

    // Ensure unique titles by appending index if collision
    let title = `${noun.charAt(0).toUpperCase() + noun.slice(1)} ${mod.charAt(0).toUpperCase() + mod.slice(1)} ${typeLabel}`;
    if (titleSet.has(title)) {
      title = `${title} ${i + 1}`;
    }
    titleSet.add(title);

    // Temporal metadata: spread over first half of 365-day range (v1 entries)
    const createdOffset = rng.int(0, rangeHalf);
    const updatedOffset = rng.int(createdOffset, rangeHalf);

    // Generate unique compound terms for body
    const termCount = rng.int(2, 3);
    const uniqueTerms = makeUniqueTerms(domain, termCount);

    entries.push({
      title,
      type,
      domain,
      confidence,
      created: dateFromOffset(startMs, createdOffset),
      updated: dateFromOffset(startMs, updatedOffset),
      uniqueTerms,
      wikilinks: [], // filled in phase 2
      isV2: false,
      supersedes: null,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 2: Assign wikilinks (connected graph)
  // -------------------------------------------------------------------------
  // For each base entry, pick 2-3 wikilink targets from other entries.
  // Build an undirected adjacency structure for BFS connectivity check.
  const adjacency = Array.from({ length: baseCount }, () => new Set());

  for (let i = 0; i < baseCount; i++) {
    const count = rng.int(2, 3);
    const targets = new Set();
    let attempts = 0;
    while (targets.size < count && attempts < baseCount * 2) {
      attempts++;
      const j = rng.next() % baseCount;
      if (j !== i) {
        targets.add(j);
      }
    }
    for (const j of targets) {
      entries[i].wikilinks.push(entries[j].title);
      adjacency[i].add(j);
      adjacency[j].add(i); // undirected for connectivity
    }
  }

  // BFS connectivity check — add bridge links if disconnected
  const components = findComponents(baseCount, adjacency);
  if (components.length > 1) {
    for (let c = 1; c < components.length; c++) {
      // Bridge from first node of this component to first node of previous component
      const from = components[c][0];
      const to = components[c - 1][0];
      if (!entries[from].wikilinks.includes(entries[to].title)) {
        entries[from].wikilinks.push(entries[to].title);
        adjacency[from].add(to);
        adjacency[to].add(from);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: Generate v2 version pairs
  // -------------------------------------------------------------------------
  // Pick the first v2Count base entries to pair (deterministic).
  for (let k = 0; k < v2Count; k++) {
    const original = entries[k];
    const v2Title = `${original.title} v2`;

    // v2 dates in second half of 365-day range
    const v2UpdatedOffset = rng.int(rangeHalf + 1, 364);
    const v2CreatedOffset = rng.int(rangeHalf, v2UpdatedOffset);

    // Shared domain/confidence/type as original
    const v2TermCount = rng.int(2, 3);
    const v2UniqueTerms = makeUniqueTerms(original.domain, v2TermCount);

    // v2 also links to same wikilink targets as original (shared vocabulary
    // signal), plus a supersedes link to the original
    const v2Wikilinks = [...original.wikilinks];
    // Include the supersedes link (as wikilink in body text, not in the array
    // which tracks explicit [[]] links in body — we add it separately in body)

    titleSet.add(v2Title);

    entries.push({
      title: v2Title,
      type: original.type,
      domain: original.domain,
      confidence: original.confidence,
      created: dateFromOffset(startMs, v2CreatedOffset),
      updated: dateFromOffset(startMs, v2UpdatedOffset),
      uniqueTerms: v2UniqueTerms,
      wikilinks: v2Wikilinks,
      isV2: true,
      supersedes: original.title,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 4: Build body text for each entry
  // -------------------------------------------------------------------------
  function buildBody(entry) {
    const domain = entry.domain;
    const nouns = VOCAB[domain].nouns;
    const lines = [];

    // Opening sentence using domain vocabulary
    const n1 = nouns[rng.next() % nouns.length];
    const n2 = nouns[rng.next() % nouns.length];
    const mod = MODIFIERS[rng.next() % MODIFIERS.length];
    lines.push(
      `The ${entry.type} of ${n1} ${mod} covers ${n2} operations in the ${domain} domain.`
    );

    // Sentence with wikilinks
    if (entry.wikilinks.length > 0) {
      const linkRef = entry.wikilinks.map((t) => `[[${t}]]`).join(", ");
      lines.push(`See also: ${linkRef}.`);
    }

    // Sentence with unique terms
    lines.push(
      `Key terms: ${entry.uniqueTerms.join(", ")}.`
    );

    // For v2 entries, add supersedes reference
    if (entry.isV2 && entry.supersedes) {
      lines.push(`This supersedes the earlier [[${entry.supersedes}]].`);
    }

    // Additional sentence for body richness
    const n3 = nouns[rng.next() % nouns.length];
    const n4 = nouns[rng.next() % nouns.length];
    lines.push(
      `This ${entry.type} governs ${n3} and ${n4} procedures as defined by domain policy.`
    );

    return lines.join(" ");
  }

  // Build bodies (rng must be called in deterministic order — iterate all entries)
  for (const entry of entries) {
    entry.body = buildBody(entry);
  }

  // -------------------------------------------------------------------------
  // Phase 5: Write files
  // -------------------------------------------------------------------------
  // Create type subdirectories
  for (const dir of Object.values(TYPE_DIR)) {
    await fs.mkdir(path.join(outputDir, dir), { recursive: true });
  }

  const manifest = {};

  for (const entry of entries) {
    const typeDir = TYPE_DIR[entry.type];
    const filename = `${slug(entry.title)}.md`;
    const filePath = path.join(outputDir, typeDir, filename);
    const relPath = `${typeDir}/${filename}`;

    const frontmatter = {
      title: entry.title,
      type: entry.type,
      domain: entry.domain,
      confidence: entry.confidence,
      created: entry.created,
      updated: entry.updated,
      tags: [entry.domain, entry.type],
    };

    // For source type, add optional fields expected by buildPage
    if (entry.type === "source") {
      frontmatter.source_url = "";
      frontmatter.source_file = "";
    }

    const pageContent = buildPage(frontmatter, entry.body);
    await fs.writeFile(filePath, pageContent, "utf8");

    const manifestEntry = {
      path: relPath,
      type: entry.type,
      domain: entry.domain,
      confidence: entry.confidence,
      created: entry.created,
      updated: entry.updated,
      wikilinks: entry.wikilinks,
      uniqueTerms: entry.uniqueTerms,
    };

    if (entry.supersedes) {
      manifestEntry.supersedes = entry.supersedes;
    }

    manifest[entry.title] = manifestEntry;
  }

  // -------------------------------------------------------------------------
  // Phase 6: Write index.md
  // -------------------------------------------------------------------------
  const byType = {};
  for (const [title, meta] of Object.entries(manifest)) {
    if (!byType[meta.type]) byType[meta.type] = [];
    byType[meta.type].push({ title, path: meta.path });
  }

  const indexLines = ["# Lore Corpus Index", ""];
  for (const type of Object.keys(TYPE_DIR)) {
    if (!byType[type] || byType[type].length === 0) continue;
    indexLines.push(`## ${TYPE_LABELS[type]}s`, "");
    for (const { title, path: p } of byType[type]) {
      indexLines.push(`- [${title}](${p})`);
    }
    indexLines.push("");
  }

  await fs.writeFile(path.join(outputDir, "index.md"), indexLines.join("\n"), "utf8");

  return manifest;
}
