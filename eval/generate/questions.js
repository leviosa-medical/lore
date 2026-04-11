// eval/generate/questions.js — Ground-truth question set generator for the Lore eval benchmark harness.
// Produces question sets from a corpus manifest covering six retrieval abilities.
// Testing strategy: verify-existing — correctness verified via the spec's verification command.

import { LCG } from "./corpus.js";

// ---------------------------------------------------------------------------
// Tier question counts
// ---------------------------------------------------------------------------
const TIER_COUNTS = {
  small:  { information_extraction: 10, multi_hop: 8, knowledge_updates: 5, keyword_metadata: 5, filtered_search: 5, abstention: 5 },
  medium: { information_extraction: 20, multi_hop: 15, knowledge_updates: 10, keyword_metadata: 10, filtered_search: 10, abstention: 10 },
  large:  { information_extraction: 40, multi_hop: 30, knowledge_updates: 20, keyword_metadata: 20, filtered_search: 20, abstention: 20 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Format an id like "ie-001", "mh-012", etc.
function formatId(prefix, n) {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

// Pick `count` distinct items from `pool` using the LCG, returning at most
// min(count, pool.length) items.
function pickDistinct(rng, pool, count) {
  if (pool.length === 0) return [];
  const n = Math.min(count, pool.length);
  const shuffled = rng.shuffle(pool);
  return shuffled.slice(0, n);
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate ground-truth question sets from a corpus manifest.
 *
 * @param {Object} manifest - Map of title -> { path, type, domain, confidence, created, updated, wikilinks, uniqueTerms, supersedes? }
 * @param {string} tier     - "small" | "medium" | "large"
 * @returns {Array}         - Array of question objects { id, ability, query, expected_titles, k, grades?, filterParams? }
 */
export function generateQuestions(manifest, tier) {
  const counts = TIER_COUNTS[tier];
  if (!counts) throw new Error(`Unknown tier: ${tier}. Use small, medium, or large.`);

  // Use the same fixed seed as the corpus generator for determinism.
  const rng = new LCG(42);

  const questions = [];

  // Separate v2 entries (those with supersedes) from base entries
  const allTitles = Object.keys(manifest);
  const v2Titles = allTitles.filter(t => manifest[t].supersedes != null);
  const baseTitles = allTitles.filter(t => manifest[t].supersedes == null);

  // Build a set of v2 entry titles for quick lookup
  const v2TitleSet = new Set(v2Titles);

  // Build supersedes map: v2Title -> v1Title
  const supersededBy = new Map(); // v1Title -> v2Title
  for (const v2Title of v2Titles) {
    const v1Title = manifest[v2Title].supersedes;
    supersededBy.set(v1Title, v2Title);
  }

  // -------------------------------------------------------------------------
  // Ability 1: information_extraction
  // -------------------------------------------------------------------------
  // Pick non-v2 entries; use one of their uniqueTerms as query.
  {
    const candidates = pickDistinct(rng, baseTitles, counts.information_extraction);
    for (let i = 0; i < candidates.length; i++) {
      const title = candidates[i];
      const entry = manifest[title];
      const term = entry.uniqueTerms[rng.next() % entry.uniqueTerms.length];
      questions.push({
        id: formatId("ie", i + 1),
        ability: "information_extraction",
        query: term,
        expected_titles: [title],
        k: 5,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ability 2: multi_hop
  // -------------------------------------------------------------------------
  // Pick base entries that have wikilinks; use a unique term from the source as
  // query. expected_titles = [source] + 1-hop targets.
  // grades: source = 1.0, each wikilink target = 0.5.
  {
    const withLinks = baseTitles.filter(t => manifest[t].wikilinks.length > 0);
    const candidates = pickDistinct(rng, withLinks, counts.multi_hop);
    for (let i = 0; i < candidates.length; i++) {
      const sourceTitle = candidates[i];
      const sourceEntry = manifest[sourceTitle];
      const term = sourceEntry.uniqueTerms[rng.next() % sourceEntry.uniqueTerms.length];

      // 1-hop targets: only include wikilink targets that exist in the manifest
      const hopTargets = sourceEntry.wikilinks.filter(t => manifest[t] != null);

      const expectedTitles = [sourceTitle, ...hopTargets];
      const grades = new Map();
      grades.set(sourceTitle, 1.0);
      for (const target of hopTargets) {
        grades.set(target, 0.5);
      }

      questions.push({
        id: formatId("mh", i + 1),
        ability: "multi_hop",
        query: term,
        expected_titles: expectedTitles,
        k: 5,
        grades,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ability 3: knowledge_updates
  // -------------------------------------------------------------------------
  // For v2 entries, use shared vocabulary (domain + type) as the query.
  // expected_titles: [v2Title, v1Title]
  // grades: v2 = 2, v1 = 1
  {
    const candidates = pickDistinct(rng, v2Titles, counts.knowledge_updates);
    for (let i = 0; i < candidates.length; i++) {
      const v2Title = candidates[i];
      const v2Entry = manifest[v2Title];
      const v1Title = v2Entry.supersedes;

      // Use domain + type as shared vocabulary query (both appear in both bodies)
      const query = `${v2Entry.domain} ${v2Entry.type}`;

      const grades = new Map();
      grades.set(v2Title, 2);
      grades.set(v1Title, 1);

      questions.push({
        id: formatId("ku", i + 1),
        ability: "knowledge_updates",
        query,
        expected_titles: [v2Title, v1Title],
        k: 5,
        grades,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ability 4: keyword_metadata
  // -------------------------------------------------------------------------
  // Query from tags/domain/type metadata. Construct a query like
  // "<domain> <type>" and expect all entries matching both domain and type.
  {
    // Build unique (domain, type) pairs present in the corpus
    const pairMap = new Map(); // "domain:type" -> [titles]
    for (const title of allTitles) {
      const e = manifest[title];
      const key = `${e.domain}:${e.type}`;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(title);
    }
    const pairKeys = [...pairMap.keys()];
    const selectedKeys = pickDistinct(rng, pairKeys, counts.keyword_metadata);

    for (let i = 0; i < selectedKeys.length; i++) {
      const key = selectedKeys[i];
      const [domain, type] = key.split(":");
      const query = `${domain} ${type}`;
      const expectedTitles = pairMap.get(key);

      questions.push({
        id: formatId("km", i + 1),
        ability: "keyword_metadata",
        query,
        expected_titles: expectedTitles,
        k: 5,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Ability 5: filtered_search
  // -------------------------------------------------------------------------
  // Three kinds: domain-only, confidence-only, combined.
  // Query uses a uniqueTerm from an entry as keyword; filterParams narrows scope.
  // expected_titles: entries matching both keyword (by domain/confidence) and filter.
  {
    const filterKinds = ["domain", "confidence", "combined"];
    const total = counts.filtered_search;
    let fsIdx = 0;

    // For filtered search we need entries whose uniqueTerms we can use as
    // discriminative queries, paired with filter parameters that meaningfully
    // narrow the result set.  We generate one question per filter kind,
    // cycling through kinds until we've generated `total` questions.
    for (let i = 0; i < total; i++) {
      const kind = filterKinds[i % filterKinds.length];

      // Pick a random base entry to build the query from
      const sourceTitle = baseTitles[rng.next() % baseTitles.length];
      const sourceEntry = manifest[sourceTitle];
      const term = sourceEntry.uniqueTerms[rng.next() % sourceEntry.uniqueTerms.length];

      let filterParams;
      let expectedTitles;

      if (kind === "domain") {
        filterParams = { domain: sourceEntry.domain };
        // expected: entries in this domain that contain the term in uniqueTerms
        // Since uniqueTerms are guaranteed unique per entry, only the source
        // matches — but the filter restricts to domain, so expected = [sourceTitle]
        // (provided the source entry is in this domain, which it is).
        expectedTitles = [sourceTitle];
      } else if (kind === "confidence") {
        filterParams = { confidence: sourceEntry.confidence };
        // expected: entries with this confidence level that contain the term
        // Since uniqueTerms are unique, only the source matches.
        expectedTitles = [sourceTitle];
      } else {
        // combined: domain + confidence
        filterParams = { domain: sourceEntry.domain, confidence: sourceEntry.confidence };
        expectedTitles = [sourceTitle];
      }

      questions.push({
        id: formatId("fs", i + 1),
        ability: "filtered_search",
        query: term,
        expected_titles: expectedTitles,
        k: 5,
        filterParams,
      });

      fsIdx++;
    }
  }

  // -------------------------------------------------------------------------
  // Ability 6: abstention
  // -------------------------------------------------------------------------
  // Fabricated compound terms that do not appear in any corpus entry.
  {
    for (let i = 0; i < counts.abstention; i++) {
      const query = `xyzzy-quantum-${String(i + 1).padStart(3, "0")}`;
      questions.push({
        id: formatId("ab", i + 1),
        ability: "abstention",
        query,
        expected_titles: [],
        k: 5,
      });
    }
  }

  return questions;
}
