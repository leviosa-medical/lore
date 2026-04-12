---
status: ready
---

# Spec: Multi-hop Retrieval Improvements

## Problem Statement

Multi-hop reasoning is Lore's weakest retrieval ability (recall@5: 66.7%). The eval suite under-tests it: only 8 questions in small tier, only forward 1-hop patterns, only synthetic compound-slug queries. The retrieval pipeline itself is limited to a crude "top-3 sources, expand top-3 wikilinks" strategy that misses 2-hop chains, reverse links, and entries related through shared attributes rather than explicit wikilinks. We cannot improve what we cannot measure, and we cannot measure what we do not test.

## Proposed Solution

A two-phase improvement delivered in one PR:

**Phase 1 (Eval Foundation):** Expand multi-hop eval coverage from 8 to 20 questions in small tier across four sub-types: forward 1-hop, reverse 1-hop, 2-hop chains, and shared-attribute. Add natural-language query patterns alongside synthetic slugs. Reset the baseline after Phase 1 lands.

**Phase 2 (Retrieval Improvements):** Replace the fixed top-3x3 wikilink expansion with a seeded-walk graph expansion inspired by memento-vault's PPR approach. Add shared-attribute traversal inspired by mempalace's tunnel-finding. Add metadata-driven pre-filtering to constrain the BM25 search space. Each change is measured against the Phase 1 baseline.

**Success criteria:** Phase 1 baseline multi_hop recall@5 is expected to drop to ~0.45-0.50 (harder questions dilute the current 0.667). Phase 2 target: multi-hop recall@5 >= 0.60 against the Phase 1 baseline, representing a ~10-15 point improvement. All four sub-types have test coverage. No other ability regresses beyond 0.05 tolerance. If Phase 2 recall@5 remains below 0.60 after constant tuning, ship Phase 1 eval expansion only and split Phase 2 into a follow-up PR for further investigation.

## User Stories

- As a user querying about a concept, I want entries linked FROM my result to surface so I discover related knowledge I would not have found directly (forward 1-hop)
- As a user querying about a concept, I want entries that link TO my result to surface so I see the broader context of what references this topic (reverse 1-hop)
- As a user querying about a concept, I want entries two links away to surface when they are structurally important so I discover transitive relationships (2-hop chains)
- As a user querying about a concept, I want entries sharing the same domain and tags to surface even without explicit wikilinks so I find related knowledge through shared attributes (shared-attribute)
- As an eval developer, I want per-sub-type recall breakdowns in the eval report so I can pinpoint which traversal strategy regressed

## Technical Approach

### Architecture

Phase 1 changes are confined to `eval/generate/questions.js` and `eval/generate/corpus.js`. Phase 2 changes are confined to `src/scoring.ts` (new pure functions) and `src/server.ts` (the `lore_query` handler's expansion step). The eval harness (`eval/run.js`, `eval/layers/integration.js`, `eval/scoring/metrics.js`) requires minor reporting additions for sub-type breakdowns but no structural changes.

### Data Model Changes

No data model changes required. Shared-attribute connections are derived at query time from existing frontmatter fields (domain, type, tags). No new frontmatter fields, no migration.

### Phase 1: Eval Foundation

#### Corpus Changes (`eval/generate/corpus.js`)

Add deliberate graph structures to the corpus that test multi-hop traversal:

1. **Reverse-link pairs:** After Phase 2 (wikilink assignment), identify 5 entries that are linked TO by many others but whose own content does not share query terms with those sources. These already exist naturally in the corpus due to random wikilink assignment -- no corpus change needed, only question generation changes.

2. **2-hop chains:** After wikilink assignment, plant 5 explicit 2-hop chains: pick entry A, find its wikilink target B, ensure B links to a C that A does not directly link to. The random graph already produces these -- the question generator identifies and uses them.

3. **Shared-attribute clusters:** The corpus already groups entries by domain (billing, tenants, maintenance) and type. Shared-attribute questions query for entries that share domain+type but have no wikilink path between them. No corpus change needed.

**Net corpus change:** Add a `findChains(entries, depth)` helper function after Phase 2 (wikilink assignment, around the BFS connectivity check) that returns an array of `{chain: [idx0, idx1, ...idxN]}` objects. This function performs BFS from each entry up to `depth` hops, recording chains where the endpoint is NOT directly linked from the start. Export this alongside the manifest for use by the question generator. Add a `sharedAttributeGroups` field to the manifest: a map of `"domain:type"` keys to arrays of titles, filtered to only include groups where at least 2 members have no direct wikilink between them.

Concretely, after Phase 2's connectivity check (after the `findComponents` block), add:

```js
// Build 2-hop chains for multi-hop eval
function findTwoHopChains(entries, adjacency, maxChains = 100) {
  const chains = [];
  for (let a = 0; a < entries.length && chains.length < maxChains; a++) {
    const aNeighbors = adjacency[a];
    for (const b of aNeighbors) {
      for (const c of adjacency[b]) {
        if (c !== a && !aNeighbors.has(c)) {
          chains.push({ a, b, c });
          if (chains.length >= maxChains) break;
        }
      }
      if (chains.length >= maxChains) break;
    }
  }
  return chains;
}
```

Add the chains and shared-attribute groups as top-level fields on the returned manifest object (not per-entry):

```js
manifest.__twoHopChains = findTwoHopChains(entries, adjacency);
manifest.__sharedAttributeGroups = buildSharedAttributeGroups(entries, adjacency);
```

The `buildSharedAttributeGroups` function groups entries by `"domain:type"`, then filters each group to pairs where neither entry wikilinks to the other (and they share no wikilink target).

#### Question Generator Changes (`eval/generate/questions.js`)

Replace the existing multi_hop section (lines 78-109) with four sub-type generators. Update `TIER_COUNTS` to allocate 20 multi-hop questions in small tier (5 per sub-type), 32 in medium (8 per sub-type), 60 in large (15 per sub-type). This increases total questions per tier (small: ~62→74, medium: ~75→92, large: ~150→180). The additional ~12-30 MCP calls add negligible eval runtime (~120-300ms at ~10ms each).

Each question gets a `subType` field (`"forward_1hop"`, `"reverse_1hop"`, `"two_hop_chain"`, `"shared_attribute"`) for reporting breakdown.

**Sub-type 1: Forward 1-hop (improved existing).** Same as current but with mixed query patterns. For 3 of 5 questions, use a natural-language query template: `"What relates to [Title]?"` or `"[domain] entries connected to [uniqueTerm]"`. For 2 of 5, keep synthetic unique-term queries for backward compatibility. Expected titles: source + 1-hop targets. Grades: source=1.0, targets=0.5.

**Sub-type 2: Reverse 1-hop.** Find entries that are wikilink targets of many other entries (high inbound count). Query uses a unique term from the TARGET entry. Expected titles: the target entry itself + the entries that link TO it (reverse neighbors). Grades: target=1.0, reverse neighbors=0.5. This tests whether the system can surface "what links to this?" relationships.

**Sub-type 3: 2-hop chains.** Use `manifest.__twoHopChains` to pick chains A->B->C where A does not directly link C. Query uses a unique term from entry A. Expected titles: [A, B, C]. Grades: A=1.0, B=0.7, C=0.5. This tests whether the expansion can reach beyond 1 hop.

**Sub-type 4: Shared-attribute.** Use `manifest.__sharedAttributeGroups` to pick pairs of entries sharing domain+type but no wikilink path. Query: `"[domain] [type] entries"`. Expected titles: all entries in that domain+type group (same as keyword_metadata but scored under multi_hop to test attribute-based traversal specifically). Grades: all entries=1.0. This sub-type is expected to score poorly until Phase 2's shared-attribute traversal lands.

#### Eval Reporting Changes

Add sub-type breakdown to the aggregation in `eval/run.js`. In `aggregateIntegration`, when processing `multi_hop` results, group by `subType` and compute per-sub-type recall@5. Include this in the JSON report under `abilities.multi_hop.sub_types`. The CI comparison (`eval/compare.js`) does NOT check sub-types for regression -- only the aggregate `multi_hop` recall@5 is compared. Sub-types are informational only.

In `printTable`, add an optional expanded view for multi_hop that shows sub-type breakdown below the main row when the `--verbose` flag is passed.

#### Baseline Reset

After Phase 1 is implemented and all tests pass, run `node eval/run.js` and commit the new `eval/baseline.json`. This becomes the Phase 2 baseline. Shared-attribute sub-type will have low recall (expected ~0.2-0.3 since it falls back to BM25 keyword matching on domain+type terms without graph traversal).

### Phase 2: Retrieval Improvements

#### Change 1: Seeded-Walk Graph Expansion (`src/scoring.ts` + `src/server.ts`)

**Problem:** The current expansion in `lore_query` (server.ts lines 711-780) takes top-3 results, extracts their wikilinks, and appends up to 3 linked pages with a flat discount. It only goes 1 hop deep, ignores reverse links, and treats all expansion candidates equally regardless of graph structure.

**Solution:** Replace with a lightweight Personalized PageRank-style seeded walk. Inspired by memento-vault's `ppr_expand` function but implemented without networkx using simple power iteration.

New pure functions in `src/scoring.ts`:

```ts
export interface GraphEdge {
  source: string; // relative path
  target: string; // relative path
}

export function buildWikilinkGraph(
  documents: Array<{ path: string; content: string }>,
  titleMap: Map<string, string>,
  slugMap: Map<string, string>
): Map<string, Set<string>>
```

`buildWikilinkGraph` constructs a **bidirectional** adjacency list (path -> Set of linked paths) by extracting wikilinks from each document and resolving them via `titleMap`/`slugMap`. For each directed edge A->B, both A->B and B->A are added to the adjacency map. This ensures PPR propagates score to nodes that link TO seed nodes (reverse links), not just nodes linked FROM seeds. This is the same resolution logic already in `lore_query` but factored into a reusable function with bidirectional edges added.

```ts
export function seededPageRank(
  graph: Map<string, Set<string>>,
  seeds: Map<string, number>, // path -> BM25 score as weight
  alpha?: number,   // damping factor, default 0.85
  iterations?: number, // default 20
  minScore?: number // minimum PPR score to include, default 0.001
): Map<string, number>
```

`seededPageRank` performs iterative PPR: initialize a score vector from `seeds` (normalized to sum=1), then iterate `score[node] = (1-alpha) * seed[node] + alpha * sum(score[neighbor]/degree[neighbor])` for each neighbor. After convergence, return all non-seed nodes with score >= `minScore`, sorted descending.

For a 50-entry corpus (small tier), 20 iterations of power iteration over a sparse adjacency list is sub-millisecond. For 500 entries (large tier), still under 5ms. No performance concern.

**Integration in `lore_query` handler (server.ts):** Replace the existing Step 5 (lines 711-780) with:

1. Build the wikilink graph using `buildWikilinkGraph`.
2. Seed PPR with all qualifying results (score/maxScore >= `EXPANSION_THRESHOLD`), weighted by their BM25 scores.
3. Run `seededPageRank` with alpha=0.85, 20 iterations.
4. Take the top `MAX_EXPANSION` (default 5, up from 3) non-seed nodes from PPR results, excluding all paths already present in BM25 results (not just seeds) to prevent score overwrites.
5. Look up each expanded path in the documents array, assign score = `pprScore * maxBM25Score * EXPANSION_DISCOUNT`.
6. Merge into results.

This naturally handles forward links, reverse links (the bidirectional graph ensures PPR propagates score in both directions -- nodes that link TO seed nodes are reachable via the reverse edges), and 2-hop chains (PPR at 20 iterations reaches the entire connected component).

**Constants** (exported from `scoring.ts`):

```ts
export const PPR_ALPHA = 0.85;
export const PPR_ITERATIONS = 20;
export const PPR_MIN_SCORE = 0.001;
export const MAX_EXPANSION = 5;
```

#### Change 2: Shared-Attribute Traversal (`src/scoring.ts` + `src/server.ts`)

**Problem:** Entries sharing domain and tags but lacking wikilinks are invisible to graph expansion. mempalace's "tunnel finding" connects rooms through shared wings (attributes).

**Solution:** After PPR expansion, perform a second expansion pass for shared-attribute connections.

New function in `src/scoring.ts`:

```ts
export function findSharedAttributeNeighbors(
  seedPaths: string[],
  documents: Array<{ path: string; frontmatter: Frontmatter }>,
  maxResults?: number // default 3
): Array<{ path: string; sharedAttributes: string[] }>
```

For each seed document, collect its domain and tags. Find other documents sharing at least domain + 1 tag (or 2+ tags if no domain match). Exclude documents already in results or PPR expansion. Return up to `maxResults` neighbors, prioritized by number of shared attributes.

**Integration in `lore_query`:** After PPR expansion (Change 1), call `findSharedAttributeNeighbors` with the seed paths (top qualifying BM25 results). Assign score = `SHARED_ATTR_DISCOUNT * parentScore` where `SHARED_ATTR_DISCOUNT = 0.7` (lower than PPR discount since the connection is weaker). Merge into final results.

**Constant:**

```ts
export const SHARED_ATTR_DISCOUNT = 0.7;
export const SHARED_ATTR_MAX = 3;
```

#### Change 3: Metadata-Driven Pre-Filtering (`src/server.ts`)

**Problem:** BM25 scores all documents equally regardless of query-metadata alignment. A query about "billing concepts" scores every document's body text, even maintenance entries that are structurally irrelevant.

**Solution:** When the query contains terms matching known domain or type values, pre-filter the document set before BM25 scoring. This is a soft filter (boost, not exclude) to avoid accidentally dropping relevant results.

Implementation: Before calling `computeBM25Scores` in `lore_query`, extract domain/type signal from the query:

```ts
function extractQueryMetadataHints(
  query: string,
  documents: Array<{ frontmatter: Frontmatter }>
): { domains: string[]; types: string[] }
```

Collect all unique domains and types from the corpus. Check which ones appear as tokens in the query, excluding overly common values that would cause false positives: values with length <= 2, and a hardcoded stoplist `['concept', 'entry', 'note', 'guide', 'item', 'record']` exported as `METADATA_HINT_STOPLIST` from `scoring.ts`. If any match, apply a pre-score boost: documents matching the hinted domain/type get a 1.5x multiplier on their BM25 score after scoring. This is applied before the existing link boost and confidence/recency steps.

This is deliberately a soft boost (not a hard filter) because queries like "how does billing relate to maintenance?" span multiple domains.

**Constant:**

```ts
export const METADATA_HINT_BOOST = 1.5;
```

### Service Layer

All new functions are pure and exported from `src/scoring.ts` for unit testability:
- `buildWikilinkGraph` -- graph construction
- `seededPageRank` -- PPR computation
- `findSharedAttributeNeighbors` -- attribute-based expansion
- `extractQueryMetadataHints` -- query metadata extraction
- `findTwoHopChains` (eval only, in `eval/generate/corpus.js`)

The `lore_query` handler in `src/server.ts` orchestrates these in sequence. No new MCP tools.

### View Layer

No view changes. The `lore_query` output format (`## Title (path)`) is unchanged. Expanded results appear in the same format, just with improved ranking.

### Implementation Order

1. **Phase 1a:** Corpus generator changes (chain-finding helpers, shared-attribute groups on manifest)
2. **Phase 1b:** Question generator changes (4 sub-types, natural language queries, updated tier counts)
3. **Phase 1c:** Eval reporting changes (sub-type breakdown in aggregation and JSON report)
4. **Phase 1d:** Run eval, commit new baseline
5. **Phase 2a:** `buildWikilinkGraph` + `seededPageRank` in scoring.ts, integrate in server.ts
6. **Phase 2b:** `findSharedAttributeNeighbors` in scoring.ts, integrate in server.ts
7. **Phase 2c:** `extractQueryMetadataHints` in server.ts
8. **Phase 2d:** Run eval, compare against Phase 1 baseline, tune constants if needed
9. **Final:** Commit updated baseline with all Phase 2 changes

After each Phase 2 sub-step, run `node eval/run.js` and `node eval/compare.js --baseline eval/baseline.json --current <report>` to verify no regressions.

## UI/UX Description

No UI changes. Users interact with the same `lore_query` tool. Results may include additional related entries that were previously missed, but the output format is identical.

## Edge Cases & Error Handling

- **Disconnected graph components:** `seededPageRank` only propagates through connected nodes. Seeds in disconnected components only expand within their component. The shared-attribute pass catches cross-component relationships.
- **Empty wikilink graph:** If no documents have wikilinks (e.g., a fresh lore with no cross-references), `seededPageRank` returns an empty map. Falls back to BM25-only results. No error.
- **Self-loops in graph:** A document linking to itself via `[[Own Title]]` creates a self-loop. PPR handles self-loops naturally -- the score cycles back to the node. No special handling needed.
- **Large corpus (500+ entries):** PPR with 20 iterations over a 500-node sparse graph is O(iterations * edges), roughly 20 * 1500 = 30K operations. Well under 1ms. The existing p95 latency budget of 200ms is not threatened.
- **Query with no metadata hints:** `extractQueryMetadataHints` returns empty arrays. No boost is applied. BM25 runs on the full document set as before.
- **Shared-attribute expansion finds too many candidates:** Capped at `SHARED_ATTR_MAX=3` results. Prioritized by attribute overlap count, then by BM25 score of the candidate if tied.
- **2-hop chain questions with no chains in corpus:** `findTwoHopChains` may return an empty array for very small or very dense graphs. The question generator skips 2-hop questions if fewer than 5 chains exist, reallocating those slots to forward 1-hop.
- **Phase 1 shared-attribute questions scoring poorly:** Expected. The baseline after Phase 1 will reflect this. Phase 2 improvements are measured as delta against that baseline.

## Performance Considerations

- **PPR computation:** O(iterations * edges). For small tier (50 entries, ~125 edges), ~2500 operations per query. For large tier (500 entries, ~1250 edges), ~25000 operations. Both sub-millisecond on modern hardware.
- **Graph construction:** O(documents * avg_wikilinks). Built once per query. For 500 documents with 2-3 links each, ~1500 wikilink resolution calls. Each is a Map lookup (O(1)). Total: sub-millisecond.
- **Shared-attribute index:** O(documents) to build the domain+tags index. O(seeds * group_size) to find neighbors. Negligible.
- **Memory:** The adjacency list for 500 nodes is ~50KB. The PPR score vector is 500 floats. No memory concern.
- **Eval runtime:** 20 multi-hop questions (up from 8) adds ~12 extra MCP tool calls. At ~10ms each, adds ~120ms to total eval time. Negligible against the current ~2s total.

## Accessibility

Not applicable -- backend retrieval pipeline changes with no UI.

## Out of Scope

- Vector/embedding search (no embeddings, stays BM25-based per constraint)
- Global PageRank precomputation (PPR is query-specific, not a static graph metric)
- Persisted graph cache (graph is rebuilt per query; caching is a future optimization)
- Changes to `lore_search` tool (only `lore_query` gets graph expansion)
- Eval sub-type regression detection in CI (sub-types are informational; only aggregate multi_hop is gated)
- Updating CI thresholds in `.github/workflows/eval.yml` (done after final baseline is committed)

## Rabbit Holes

- **Full PageRank with eigenvector convergence:** Do not implement convergence detection or adaptive iteration counts. Fixed 20 iterations is sufficient for graphs under 1000 nodes. Use a simple loop, not a matrix library.
- **Separate forward/reverse adjacency lists:** Do not maintain two separate graphs. `buildWikilinkGraph` builds a single bidirectional adjacency map (each directed wikilink A->B adds both A->B and B->A). This is simpler and sufficient for PPR to discover both forward and reverse relationships.
- **Sophisticated shared-attribute similarity (Jaccard, cosine over tag vectors):** Simple set intersection (domain + tags overlap count) is sufficient. Do not build a tag embedding or similarity matrix.
- **Refactoring the entire lore_query handler:** The expansion step replacement is surgical (lines 711-780 of server.ts). Do not restructure the full handler pipeline. Keep the existing BM25 -> link boost -> confidence/recency flow, and replace only the expansion step.

## No-Gos

- Do not add external dependencies to `package.json` (no networkx, no graph libraries)
- Do not regress any existing ability beyond 0.05 tolerance (Information Extraction, Keyword Metadata, Filtered Search, Knowledge Updates, Abstention)
- Do not change MCP tool output formats (eval harness parses `## Title (path)` for lore_query)
- Do not modify `lore_search`, `lore_read`, or `lore_list` behavior
- Do not split this into multiple PRs -- one PR, one baseline reset

## Open Questions

No open questions.
