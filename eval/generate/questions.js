// eval/generate/questions.js — Ground-truth question set generator for the Lore eval benchmark harness.
// Produces question sets from a corpus manifest covering six retrieval abilities.
// Testing strategy: verify-existing — correctness verified via the spec's verification command.

import { LCG } from "./corpus.js";

// ---------------------------------------------------------------------------
// Tier question counts
// ---------------------------------------------------------------------------
const TIER_COUNTS = {
  small:  { information_extraction: 10, multi_hop: 20, knowledge_updates: 5, keyword_metadata: 5, filtered_search: 5, abstention: 5 },
  medium: { information_extraction: 20, multi_hop: 32, knowledge_updates: 10, keyword_metadata: 10, filtered_search: 10, abstention: 10 },
  large:  { information_extraction: 40, multi_hop: 60, knowledge_updates: 20, keyword_metadata: 20, filtered_search: 20, abstention: 20 },
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
 * @param {Object} manifest - Map of title -> { path, type, domain, confidence, created, updated, wikilinks, uniqueTerms, historyTerms? }
 * @param {string} tier     - "small" | "medium" | "large"
 * @returns {Array}         - Array of question objects { id, ability, query, expected_titles, k, grades?, filterParams? }
 */
export function generateQuestions(manifest, tier) {
  const counts = TIER_COUNTS[tier];
  if (!counts) throw new Error(`Unknown tier: ${tier}. Use small, medium, or large.`);

  // Use the same fixed seed as the corpus generator for determinism.
  const rng = new LCG(42);

  const questions = [];

  // Filter out manifest meta-fields (prefixed with __) to get only entry titles.
  const allTitles = Object.keys(manifest).filter(t => !t.startsWith("__"));
  const titlesWithHistory = allTitles.filter(t => manifest[t].historyTerms && manifest[t].historyTerms.length > 0);

  // -------------------------------------------------------------------------
  // Ability 1: information_extraction
  // -------------------------------------------------------------------------
  // Pick entries; use one of their uniqueTerms as query.
  {
    const candidates = pickDistinct(rng, allTitles, counts.information_extraction);
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
  // Ability 2: multi_hop — four sub-types
  // -------------------------------------------------------------------------
  // Counts: split total evenly; forward_1hop absorbs rounding remainder.
  {
    const totalMH = counts.multi_hop;
    const perSubType = Math.floor(totalMH / 4);
    const remainder = totalMH - perSubType * 4;

    let forward1hopCount = perSubType + remainder; // absorbs rounding
    const reverse1hopCount = perSubType;
    let twoHopCount = perSubType;
    const sharedAttrCount = perSubType;

    // Counter for question IDs across all multi_hop sub-types
    let mhIdx = 0;

    // -----------------------------------------------------------------------
    // Sub-type 1: Forward 1-hop (improved existing)
    // -----------------------------------------------------------------------
    // First 3 questions use natural-language query templates; rest use raw unique terms.
    {
      const withLinks = allTitles.filter(t => manifest[t].wikilinks.length > 0);
      const candidates = pickDistinct(rng, withLinks, forward1hopCount);
      const nlTemplates = [
        (title, _domain, _term) => `What relates to ${title}?`,
        (_title, domain, term) => `${domain} entries connected to ${term}`,
      ];

      for (let i = 0; i < candidates.length; i++) {
        const sourceTitle = candidates[i];
        const sourceEntry = manifest[sourceTitle];
        const term = sourceEntry.uniqueTerms[rng.next() % sourceEntry.uniqueTerms.length];

        let query;
        if (i < 3) {
          // Natural-language query template
          const template = nlTemplates[rng.next() % nlTemplates.length];
          query = template(sourceTitle, sourceEntry.domain, term);
        } else {
          // Synthetic unique-term query (backward compatible)
          query = term;
        }

        // 1-hop targets: only include wikilink targets that exist in the manifest
        const hopTargets = sourceEntry.wikilinks.filter(t => manifest[t] != null);
        const expectedTitles = [sourceTitle, ...hopTargets];
        const grades = new Map();
        grades.set(sourceTitle, 1.0);
        for (const target of hopTargets) {
          grades.set(target, 0.5);
        }

        questions.push({
          id: formatId("mh", ++mhIdx),
          ability: "multi_hop",
          subType: "forward_1hop",
          query,
          expected_titles: expectedTitles,
          k: 5,
          grades,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Sub-type 2: Reverse 1-hop
    // -----------------------------------------------------------------------
    // Build reverse-link index: target title -> array of source titles.
    // Pick high-inbound-count targets; query via a unique term from the target.
    {
      const reverseLinks = new Map(); // targetTitle -> [sourceTitles]
      for (const sourceTitle of allTitles) {
        const sourceEntry = manifest[sourceTitle];
        for (const targetTitle of sourceEntry.wikilinks) {
          if (manifest[targetTitle] != null) {
            if (!reverseLinks.has(targetTitle)) reverseLinks.set(targetTitle, []);
            reverseLinks.get(targetTitle).push(sourceTitle);
          }
        }
      }

      // Sort by inbound count descending; pick those with at least 2 reverse links
      const highInboundTargets = [...reverseLinks.entries()]
        .filter(([, srcs]) => srcs.length >= 2)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([title]) => title);

      const candidates = pickDistinct(rng, highInboundTargets, reverse1hopCount);

      for (let i = 0; i < candidates.length; i++) {
        const targetTitle = candidates[i];
        const targetEntry = manifest[targetTitle];
        const term = targetEntry.uniqueTerms[rng.next() % targetEntry.uniqueTerms.length];

        const reverseNeighbors = reverseLinks.get(targetTitle) || [];
        const expectedTitles = [targetTitle, ...reverseNeighbors];
        const grades = new Map();
        grades.set(targetTitle, 1.0);
        for (const src of reverseNeighbors) {
          grades.set(src, 0.5);
        }

        questions.push({
          id: formatId("mh", ++mhIdx),
          ability: "multi_hop",
          subType: "reverse_1hop",
          query: term,
          expected_titles: expectedTitles,
          k: 5,
          grades,
        });
      }
    }

    // -----------------------------------------------------------------------
    // Sub-type 3: 2-hop chain
    // -----------------------------------------------------------------------
    // Use manifest.__twoHopChains (array of { a, b, c } title strings).
    // Falls back: if fewer chains than twoHopCount, reallocate deficit to forward_1hop.
    {
      const availableChains = manifest.__twoHopChains || [];
      if (availableChains.length < twoHopCount) {
        const deficit = twoHopCount - availableChains.length;
        twoHopCount = availableChains.length;
        forward1hopCount += deficit; // generate extra forward_1hop below
      }

      const selectedChains = pickDistinct(rng, availableChains, twoHopCount);

      for (let i = 0; i < selectedChains.length; i++) {
        const chain = selectedChains[i];
        const entryA = manifest[chain.a];
        if (!entryA) continue;
        const term = entryA.uniqueTerms[rng.next() % entryA.uniqueTerms.length];

        const expectedTitles = [chain.a, chain.b, chain.c];
        const grades = new Map();
        grades.set(chain.a, 1.0);
        grades.set(chain.b, 0.7);
        grades.set(chain.c, 0.5);

        questions.push({
          id: formatId("mh", ++mhIdx),
          ability: "multi_hop",
          subType: "two_hop_chain",
          query: term,
          expected_titles: expectedTitles,
          k: 5,
          grades,
        });
      }

      // Reallocated forward_1hop questions (if deficit > 0)
      const baseForward1hopCount = perSubType + remainder;
      const extraForwardCount = forward1hopCount - baseForward1hopCount;
      if (extraForwardCount > 0) {
        const withLinks = allTitles.filter(t => manifest[t].wikilinks.length > 0);
        // Avoid already-picked titles by using a fresh pick
        const extras = pickDistinct(rng, withLinks, extraForwardCount);
        for (let i = 0; i < extras.length; i++) {
          const sourceTitle = extras[i];
          const sourceEntry = manifest[sourceTitle];
          const term = sourceEntry.uniqueTerms[rng.next() % sourceEntry.uniqueTerms.length];
          const hopTargets = sourceEntry.wikilinks.filter(t => manifest[t] != null);
          const expectedTitles = [sourceTitle, ...hopTargets];
          const grades = new Map();
          grades.set(sourceTitle, 1.0);
          for (const target of hopTargets) {
            grades.set(target, 0.5);
          }
          questions.push({
            id: formatId("mh", ++mhIdx),
            ability: "multi_hop",
            subType: "forward_1hop",
            query: term,
            expected_titles: expectedTitles,
            k: 5,
            grades,
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Sub-type 4: Shared-attribute
    // -----------------------------------------------------------------------
    // Use manifest.__sharedAttributeGroups (map of "domain:type" -> [titles]).
    // Query: "${domain} ${type} entries". Grades: all group members = 1.0.
    {
      const groupMap = manifest.__sharedAttributeGroups || {};
      const groupKeys = Object.keys(groupMap);
      const selectedKeys = pickDistinct(rng, groupKeys, sharedAttrCount);

      for (let i = 0; i < selectedKeys.length; i++) {
        const key = selectedKeys[i];
        const [domain, type] = key.split(":");
        const query = `${domain} ${type} entries`;
        const groupTitles = groupMap[key];

        const grades = new Map();
        for (const t of groupTitles) {
          grades.set(t, 1.0);
        }

        questions.push({
          id: formatId("mh", ++mhIdx),
          ability: "multi_hop",
          subType: "shared_attribute",
          query,
          expected_titles: groupTitles,
          k: 5,
          grades,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ability 3: knowledge_updates
  // -------------------------------------------------------------------------
  // Positive: use uniqueTerms from entries with historyTerms; expected_titles = [title]
  // Negative: use historyTerms as query; expected_titles = [] (history pollution check)
  {
    const count = counts.knowledge_updates;
    const positiveCount = Math.ceil(count / 2);
    const negativeCount = count - positiveCount;

    const candidates = pickDistinct(rng, titlesWithHistory, count);

    // Positive questions
    for (let i = 0; i < Math.min(positiveCount, candidates.length); i++) {
      const title = candidates[i];
      const entry = manifest[title];
      const term = entry.uniqueTerms[rng.next() % entry.uniqueTerms.length];
      questions.push({
        id: formatId("ku", i + 1),
        ability: "knowledge_updates",
        questionType: "positive",
        query: term,
        expected_titles: [title],
        k: 5,
      });
    }

    // Negative questions
    for (let i = 0; i < Math.min(negativeCount, candidates.length); i++) {
      const title = candidates[i];
      const entry = manifest[title];
      const historyTerm = entry.historyTerms[rng.next() % entry.historyTerms.length];
      questions.push({
        id: formatId("ku", positiveCount + i + 1),
        ability: "knowledge_updates",
        questionType: "negative",
        query: historyTerm,
        expected_titles: [],
        k: 5,
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
      const sourceTitle = allTitles[rng.next() % allTitles.length];
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
