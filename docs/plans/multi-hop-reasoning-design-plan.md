---
spec: docs/specs/multi-hop-reasoning-design.md
---

# Multi-hop Retrieval Improvements Implementation Plan

**Goal:** Expand multi-hop eval coverage from 8 to 20 questions across four sub-types, then improve retrieval with PPR graph expansion, shared-attribute traversal, and metadata pre-filtering -- measured against a Phase 1 baseline.

**Architecture:** Phase 1 adds corpus helpers (`findTwoHopChains`, `buildSharedAttributeGroups`) to `eval/generate/corpus.js`, replaces the single multi-hop generator in `eval/generate/questions.js` with four sub-type generators, and adds sub-type breakdown reporting to `eval/run.js`. Phase 2 adds four pure functions to `src/scoring.ts` (`buildWikilinkGraph`, `seededPageRank`, `findSharedAttributeNeighbors`, `extractQueryMetadataHints`) and replaces the fixed top-3x3 wikilink expansion in `src/server.ts` with PPR-based expansion, shared-attribute traversal, and metadata hint boosting. A baseline reset separates the two phases.

---

### Task 1: Add corpus graph helpers (chain finder and shared-attribute groups)

**Files:**
- Modify: `eval/generate/corpus.js`

**Acceptance criteria:**
- [ ] `findTwoHopChains(entries, adjacency, maxChains)` returns an array of `{ a, b, c }` index triples where A links to B, B links to C, and A does NOT directly link to C
- [ ] `buildSharedAttributeGroups(entries, adjacency)` returns a map of `"domain:type"` keys to arrays of entry titles, filtered to groups where at least 2 members have no direct wikilink between them
- [ ] Manifest object has `__twoHopChains` and `__sharedAttributeGroups` top-level fields populated after Phase 2 wikilink assignment
- [ ] Existing corpus generation and deterministic seeding are not broken

**Verification:**
- Run: `npm run build && node -e "import('./eval/generate/corpus.js').then(async m => { const os = await import('os'); const fs = await import('fs/promises'); const d = await fs.mkdtemp(os.tmpdir() + '/lore-test-'); const manifest = await m.generateCorpus('small', d); console.log('chains:', manifest.__twoHopChains?.length); console.log('groups:', Object.keys(manifest.__sharedAttributeGroups || {}).length); await fs.rm(d, {recursive:true}); })"`
- Expected: `chains: <number >= 5>` and `groups: <number >= 1>` printed to stdout

#### Steps

- [ ] Step 1: After the `findComponents` block (line 303-315 area) and before Phase 3 (body text), add the `findTwoHopChains` function. It takes `entries` (array), `adjacency` (array of Sets), and `maxChains` (default 100). For each entry index `a`, iterate its forward neighbors `b` (from adjacency[a]), then for each `b`, iterate adjacency[b] entries as `c`. Include `{ a, b, c }` only if `c !== a` and `adjacency[a]` does NOT contain `c`. Stop when `maxChains` is reached. Note: `adjacency` is undirected (contains both directions) but `entries[i].wikilinks` tracks directed links -- use `entries[a].wikilinks` to check if A directly links to C by checking `entries[a].wikilinks.includes(entries[c].title)` instead of `adjacency[a].has(c)`, because adjacency is bidirectional and would miss chains where A and C are undirectedly connected but not directly linked.

- [ ] Step 2: Add the `buildSharedAttributeGroups` function after `findTwoHopChains`. It takes `entries` and `adjacency`. Build a map keyed by `"domain:type"` string, with values being arrays of `{ index, title }`. For each group, filter to pairs where entry i's `wikilinks` array does not include entry j's title AND entry j's `wikilinks` array does not include entry i's title. Only include groups that have at least 2 members satisfying this disconnection criterion. Return a plain object mapping `"domain:type"` to arrays of title strings (not indices).

- [ ] Step 3: After the BFS connectivity bridge-link block and before Phase 3 (body text building), compute the two new manifest fields: call `findTwoHopChains(entries, adjacency)` and store the result. Call `buildSharedAttributeGroups(entries, adjacency)` and store the result.

- [ ] Step 4: In the Phase 5 file-writing section, after the manifest object is fully built (after the `for (const entry of entries)` loop around line 439), attach the two new fields: `manifest.__twoHopChains = twoHopChains` (converting index triples to title triples: `{ a: entries[c.a].title, b: entries[c.b].title, c: entries[c.c].title }`), and `manifest.__sharedAttributeGroups = sharedAttributeGroups`.

- [ ] Step 5: Commit

---

### Task 2: Replace multi-hop question generator with four sub-type generators

**Files:**
- Modify: `eval/generate/questions.js`

**Acceptance criteria:**
- [ ] `TIER_COUNTS` updated: small multi_hop=20, medium=32, large=60
- [ ] Four sub-types generated: `forward_1hop`, `reverse_1hop`, `two_hop_chain`, `shared_attribute`
- [ ] Each question has a `subType` field with one of the four sub-type strings
- [ ] Small tier produces 5 questions per sub-type (20 total multi-hop)
- [ ] Forward 1-hop: 3 of 5 use natural-language query templates, 2 use synthetic unique-term queries
- [ ] Reverse 1-hop: queries a high-inbound-count target entry, expects target + entries that link TO it
- [ ] 2-hop chain: uses `manifest.__twoHopChains`, expects [A, B, C] with grades A=1.0, B=0.7, C=0.5
- [ ] Shared-attribute: uses `manifest.__sharedAttributeGroups`, queries `"domain type entries"`, expects all group members with grade 1.0
- [ ] Falls back gracefully: if fewer than 5 two-hop chains exist, reallocates slots to forward 1-hop

**Verification:**
- Run: `npm run build && node -e "import('./eval/generate/corpus.js').then(async m => { const os = await import('os'); const fs = await import('fs/promises'); const d = await fs.mkdtemp(os.tmpdir() + '/lore-test-'); const manifest = await m.generateCorpus('small', d); const q = await import('./eval/generate/questions.js'); const questions = q.generateQuestions(manifest, 'small'); const mh = questions.filter(q => q.ability === 'multi_hop'); console.log('total multi_hop:', mh.length); const types = {}; mh.forEach(q => { types[q.subType] = (types[q.subType]||0)+1 }); console.log('sub-types:', JSON.stringify(types)); await fs.rm(d, {recursive:true}); })"`
- Expected: `total multi_hop: 20` and `sub-types: {"forward_1hop":5,"reverse_1hop":5,"two_hop_chain":5,"shared_attribute":5}` (or forward_1hop may be higher if chains were scarce)

#### Steps

- [ ] Step 1: Update `TIER_COUNTS` to set multi_hop values: small=20, medium=32, large=60. This changes total question counts to approximately small=74, medium=92, large=180.

- [ ] Step 2: Compute per-sub-type counts from the total. Define a helper at the top of the multi_hop section: `const totalMH = counts.multi_hop; const perSubType = Math.floor(totalMH / 4); const remainder = totalMH - perSubType * 4;`. Allocate: forward_1hop gets `perSubType + remainder` (absorbs rounding), reverse_1hop/two_hop_chain/shared_attribute each get `perSubType`.

- [ ] Step 3: Replace the existing multi_hop block (lines 78-109) with sub-type 1: **Forward 1-hop (improved)**. Filter `allTitles` to entries with wikilinks. Use `pickDistinct(rng, withLinks, forward1hopCount)`. For each candidate: if index < 3 (first 3 of 5 in small tier), use a natural-language query template picked from `["What relates to TITLE?", "DOMAIN entries connected to TERM"]` using `rng.pick()`, substituting TITLE with the entry's title, DOMAIN with the entry's domain, and TERM with a unique term. If index >= 3, use a raw unique term as query (backward compatible). Expected titles: `[sourceTitle, ...hopTargets]`. Grades: source=1.0, targets=0.5. Set `subType: "forward_1hop"` on each question.

- [ ] Step 4: Add sub-type 2: **Reverse 1-hop**. Build a reverse-link index: iterate all entries, for each wikilink target that exists in the manifest, record the source title in a `reverseLinks` map (target title -> array of source titles). Sort targets by number of reverse links descending. Pick the top `reverse1hopCount` targets using `pickDistinct(rng, highInboundTargets, reverse1hopCount)` where `highInboundTargets` are entries with at least 2 reverse links. For each: query uses a unique term from the TARGET entry. Expected titles: `[targetTitle, ...reverseNeighborTitles]`. Grades: target=1.0, each reverse neighbor=0.5. Set `subType: "reverse_1hop"`.

- [ ] Step 5: Add sub-type 3: **2-hop chain**. Read `manifest.__twoHopChains`. If fewer than `twoHopCount` chains are available, reduce `twoHopCount` to available chains and add the deficit to forward_1hop count (generate additional forward_1hop questions after this block). Pick `twoHopCount` chains using `pickDistinct(rng, manifest.__twoHopChains, twoHopCount)`. For each chain `{ a, b, c }` (these are title strings from Task 1 Step 4): query uses a unique term from entry A (`manifest[chain.a].uniqueTerms`). Expected titles: `[chain.a, chain.b, chain.c]`. Grades: A=1.0, B=0.7, C=0.5. Set `subType: "two_hop_chain"`.

- [ ] Step 6: Add sub-type 4: **Shared-attribute**. Read `manifest.__sharedAttributeGroups`. Pick `sharedAttrCount` groups from the available keys using `pickDistinct(rng, Object.keys(manifest.__sharedAttributeGroups), sharedAttrCount)`. For each key (format `"domain:type"`): split to get domain and type. Query: `"${domain} ${type} entries"`. Expected titles: all titles in the group. Grades: Map with all titles = 1.0. Set `subType: "shared_attribute"`. If fewer groups exist than `sharedAttrCount`, generate as many as possible.

- [ ] Step 7: Commit

---

### Task 3: Add sub-type breakdown to eval reporting

**Files:**
- Modify: `eval/run.js`

**Acceptance criteria:**
- [ ] `aggregateIntegration` computes per-sub-type recall@5 for multi_hop questions and stores them in the metrics object under a `sub_types` key
- [ ] JSON report includes `abilities.multi_hop.sub_types` with keys `forward_1hop`, `reverse_1hop`, `two_hop_chain`, `shared_attribute` and their recall@5 values
- [ ] `printTable` shows sub-type breakdown rows below the multi_hop row when `--verbose` flag is passed
- [ ] `--verbose` CLI flag is parsed and forwarded to `printTable`
- [ ] Sub-types are informational only; `eval/compare.js` is NOT modified

**Verification:**
- Run: `npm run build && node eval/run.js --verbose 2>&1 | head -20`
- Expected: Table output includes a "Multi-hop Reasoning" row followed by indented sub-type rows showing recall@5 for each sub-type
- Run: `npm run build && node eval/run.js 2>&1 | grep -c "forward_1hop"`
- Expected: `0` (sub-types not shown without --verbose)

#### Steps

- [ ] Step 1: In `parseArgs`, add a `verbose: false` field to the defaults object. Add a clause: `if (arg === "--verbose") { args.verbose = true; }` (no `i++` needed since it's a boolean flag with no value).

- [ ] Step 2: In `aggregateIntegration`, inside the `else` block that handles non-abstention, non-knowledge_updates abilities (line 163 area), add a sub-type grouping step specifically for `multi_hop`. After computing the standard metrics, check `if (ability === "multi_hop")`. Group the results by `r.subType` (falling back to `"unknown"` if absent). For each sub-type group, compute recall@5 as the mean of `recallAtK(r.retrieved_titles, r.expected_titles, 5)` across results in that group. Store this as `abilityMetrics[ability].sub_types = { forward_1hop: <recall@5>, ... }`.

- [ ] Step 3: In `writeReport`, inside the abilities section builder (line 377 area), after setting the standard metrics for non-abstention abilities, check if `m.sub_types` exists and include it: `if (m.sub_types) { abilities[ability].sub_types = m.sub_types; }`.

- [ ] Step 4: Modify the `printTable` function signature to accept a fourth parameter `verbose` (boolean, default false). In the main orchestrator's Step 6 call to `printTable`, pass `args.verbose` as the fourth argument. Inside `printTable`, after rendering the `multi_hop` row, if `verbose` is true and `abilityMetrics["multi_hop"]?.sub_types` exists, iterate over the sub-types in order `["forward_1hop", "reverse_1hop", "two_hop_chain", "shared_attribute"]` and print an indented row for each: `"  forward_1hop".padEnd(COL_ABILITY)` with recall@5 in the Recall@5 column and dashes in other columns.

- [ ] Step 5: Commit

---

### Task 4: Run eval and commit Phase 1 baseline

**Files:**
- Modify: `eval/baseline.json`

**Acceptance criteria:**
- [ ] Eval suite passes with no server errors
- [ ] `eval/baseline.json` contains updated scores reflecting 20 multi-hop questions
- [ ] `abilities.multi_hop` in baseline has `sub_types` field with per-sub-type recall@5
- [ ] All non-multi-hop abilities have scores (no accidental breakage)

**Verification:**
- Run: `node eval/run.js`
- Expected: All questions completed, no server errors, report written
- Run: `node eval/compare.js --baseline eval/baseline.json --current eval/results/<latest-report>.json`
- Expected: All abilities show "steady" status (since baseline was just regenerated from same run)

#### Steps

- [ ] Step 1: Run `npm run build` to ensure TypeScript is compiled.

- [ ] Step 2: Run `node eval/run.js` and verify it completes without server errors. Note the report file path.

- [ ] Step 3: Open the generated report JSON. Extract the top-level fields needed for baseline format: `generated_at` (from `timestamp`), `tier`, `layer`, a `commit` field (get current git short hash via `git rev-parse --short HEAD`), and the `abilities` object. Write this to `eval/baseline.json` in the same format as the existing baseline (see current baseline.json for structure: `{ generated_at, tier, layer, commit, abilities: { ... } }`).

- [ ] Step 4: Run `node eval/compare.js --baseline eval/baseline.json --current eval/results/<report>.json` to verify all abilities show "steady" with exit code 0.

- [ ] Step 5: Commit

---

### Task 5: Add `buildWikilinkGraph` and `seededPageRank` to scoring.ts

**Files:**
- Modify: `src/scoring.ts`
- Modify: `eval/layers/unit.js`

**Acceptance criteria:**
- [ ] `GraphEdge` interface exported with `source` and `target` string fields
- [ ] `buildWikilinkGraph` exported: takes documents array with `path` and `content` fields plus `titleMap`/`slugMap`, returns `Map<string, Set<string>>` with bidirectional edges
- [ ] `seededPageRank` exported: takes graph, seeds map (path->score), optional alpha/iterations/minScore, returns `Map<string, number>` of non-seed node scores
- [ ] Constants exported: `PPR_ALPHA = 0.85`, `PPR_ITERATIONS = 20`, `PPR_MIN_SCORE = 0.001`, `MAX_EXPANSION = 5`
- [ ] Unit tests verify: bidirectional graph construction, PPR converges and returns non-seed neighbors, PPR with empty graph returns empty map, PPR with disconnected components only expands within component

**Verification:**
- Run: `npm run build`
- Expected: No TypeScript compilation errors
- Run: `node eval/run.js --layer unit`
- Expected: All unit tests pass including new graph and PPR tests

#### Steps

- [ ] Step 1: At the end of `src/scoring.ts`, add the `GraphEdge` interface: `export interface GraphEdge { source: string; target: string; }`.

- [ ] Step 2: Add the `buildWikilinkGraph` function. Signature: `export function buildWikilinkGraph(documents: Array<{ path: string; content: string }>, titleMap: Map<string, string>, slugMap: Map<string, string>): Map<string, Set<string>>`. For each document, call `extractBody(doc.content)` then `extractWikilinks(body)` to get link texts. For each link text, resolve via titleMap (case-insensitive) then slugMap (using `slugify`). If resolved to a path, add bidirectional edges: `graph.get(doc.path).add(resolvedPath)` and `graph.get(resolvedPath).add(doc.path)`. Initialize the graph map with empty Sets for all document paths first (so isolated nodes exist). Do not skip self-loops — PPR handles them naturally (score cycles back to the node). Per spec: "No special handling needed."

- [ ] Step 3: Add the constants: `export const PPR_ALPHA = 0.85; export const PPR_ITERATIONS = 20; export const PPR_MIN_SCORE = 0.001; export const MAX_EXPANSION = 5;`.

- [ ] Step 4: Add the `seededPageRank` function. Signature: `export function seededPageRank(graph: Map<string, Set<string>>, seeds: Map<string, number>, alpha: number = PPR_ALPHA, iterations: number = PPR_ITERATIONS, minScore: number = PPR_MIN_SCORE): Map<string, number>`. Implementation: (a) Normalize seed scores to sum=1, storing as `seedVec: Map<string, number>`. (b) Initialize `scores: Map<string, number>` from seedVec. (c) Collect all reachable nodes from seeds by BFS/DFS up to `iterations` depth, or simply iterate all nodes present as keys in `graph`. (d) For each iteration: create a new `nextScores` map. For each node in the working set: `nextScores[node] = (1 - alpha) * (seedVec.get(node) || 0)`. Then for each node, distribute `alpha * scores[node] / degree(node)` to each neighbor. (e) After all iterations, filter to non-seed nodes with score >= minScore. Return as `Map<string, number>`.

- [ ] Step 5: In `eval/layers/unit.js`, add `import { buildWikilinkGraph, seededPageRank, PPR_ALPHA, PPR_ITERATIONS, PPR_MIN_SCORE } from "../../dist/scoring.js";` to the existing import statement (extend the destructuring).

- [ ] Step 6: Add `testBuildWikilinkGraph()` unit test function. Create 3 documents: A contains `[[B Title]]`, B contains `[[C Title]]`, C has no links. Build titleMap/slugMap using `buildLookupMaps`. Call `buildWikilinkGraph`. Assert: graph has 3 keys (A, B, C paths). A's neighbors include B's path AND B's neighbors include A's path (bidirectional). B's neighbors include C's path AND C's neighbors include B's path. A's neighbors do NOT include C's path.

- [ ] Step 7: Add `testSeededPageRank()` unit test function. Build a small graph: A-B, B-C, C-D (linear chain). Seed with A=1.0. Run `seededPageRank`. Assert: returned map does NOT contain A (seed excluded). B has higher score than C, C has higher score than D (score decays with distance). All returned scores are >= PPR_MIN_SCORE. Also test: empty graph with seed returns empty map.

- [ ] Step 8: Register both new test functions in the `runUnitLayer` results array.

- [ ] Step 9: Commit

---

### Task 6: Replace wikilink expansion with PPR-based expansion in server.ts

**Files:**
- Modify: `src/server.ts`

**Acceptance criteria:**
- [ ] Step 5 (lines 711-780) of `lore_query` handler is replaced with PPR-based expansion
- [ ] Graph is built via `buildWikilinkGraph` using the existing documents array and lookup maps
- [ ] Seeds are all qualifying results (score/maxScore >= EXPANSION_THRESHOLD), weighted by BM25 score
- [ ] PPR runs with PPR_ALPHA, PPR_ITERATIONS defaults
- [ ] Top MAX_EXPANSION (5) non-seed, non-existing-result nodes are expanded
- [ ] Expanded node scores = pprScore * maxBM25Score * EXPANSION_DISCOUNT
- [ ] Merged into final results by score descending
- [ ] No other steps in the lore_query handler are modified

**Verification:**
- Run: `npm run build && node eval/run.js`
- Expected: No server errors, eval completes successfully
- Run: `node eval/compare.js --baseline eval/baseline.json --current eval/results/<report>.json --tolerance 0.10`
- Expected: Exit code 0 (no regressions beyond temporary relaxed tolerance during development)

#### Steps

- [ ] Step 1: Add imports at the top of `src/server.ts` for the new functions. Extend the existing import from `"./scoring.js"` to include `buildWikilinkGraph`, `seededPageRank`, `PPR_ALPHA`, `PPR_ITERATIONS`, `PPR_MIN_SCORE`, `MAX_EXPANSION`.

- [ ] Step 2: Replace the Step 5 block (lines 711-780). Keep the `maxScore` and `qualifyingResults` computation (lines 712-715). Remove everything from line 717 (`let finalResults`) through line 780 (end of merge block). Replace with: (a) Build lookup maps: `const { titleMap, slugMap } = buildLookupMaps(documents.map(d => ({ path: d.path, title: d.title })));`. (b) Build graph: `const wikilinkGraph = buildWikilinkGraph(documents.map(d => ({ path: d.path, content: d.content })), titleMap, slugMap);`. (c) Build seeds map from qualifyingResults: `const seeds = new Map<string, number>(); for (const r of qualifyingResults) { seeds.set(r.path, r.score); }`. (d) Run PPR: `const pprScores = seededPageRank(wikilinkGraph, seeds);`. (e) Collect existing result paths: `const existingPaths = new Set(results.map(r => r.path));`. (f) Build expansion candidates from PPR results: sort pprScores entries by score descending, filter out paths in existingPaths or seeds, take top MAX_EXPANSION. (g) For each candidate, find the document in the documents array, create a ScoredResult with `score = pprScore * maxScore * EXPANSION_DISCOUNT`. (h) Merge: `let finalResults = [...results, ...expansionResults]; finalResults.sort((a, b) => b.score - a.score);`. If no expansion candidates found, `finalResults = [...results];`.

- [ ] Step 3: Verify the `resolveWikilink` function in server.ts is still used only for its original purpose (it is async and uses filesystem access). The new `buildWikilinkGraph` in scoring.ts uses synchronous titleMap/slugMap resolution only, so no conflict. Remove any now-dead code from the old expansion block (the old lookup map building, wikilink extraction loop, dedup logic).

- [ ] Step 4: Commit

---

### Task 7: Add shared-attribute traversal

**Files:**
- Modify: `src/scoring.ts`
- Modify: `src/server.ts`
- Modify: `eval/layers/unit.js`

**Acceptance criteria:**
- [ ] `findSharedAttributeNeighbors` exported from scoring.ts: takes seed paths, documents array with frontmatter, and optional maxResults (default 3), returns array of `{ path, sharedAttributes }` objects
- [ ] Constants exported: `SHARED_ATTR_DISCOUNT = 0.7`, `SHARED_ATTR_MAX = 3`
- [ ] Function finds documents sharing domain + at least 1 tag (or 2+ tags if no domain match) with seed documents
- [ ] Excludes documents already in a provided `excludePaths` set
- [ ] Prioritizes by number of shared attributes, breaks ties deterministically
- [ ] Integration in server.ts: called after PPR expansion, seeds are qualifying BM25 results, score = SHARED_ATTR_DISCOUNT * parentScore
- [ ] Unit test verifies correct shared-attribute neighbor discovery

**Verification:**
- Run: `npm run build`
- Expected: No compilation errors
- Run: `node eval/run.js --layer unit`
- Expected: All unit tests pass
- Run: `node eval/run.js`
- Expected: No server errors

#### Steps

- [ ] Step 1: Add constants to `src/scoring.ts`: `export const SHARED_ATTR_DISCOUNT = 0.7; export const SHARED_ATTR_MAX = 3;`.

- [ ] Step 2: Add `findSharedAttributeNeighbors` function to `src/scoring.ts`. Signature: `export function findSharedAttributeNeighbors(seedPaths: string[], documents: Array<{ path: string; frontmatter: Frontmatter }>, excludePaths: Set<string>, maxResults: number = SHARED_ATTR_MAX): Array<{ path: string; sharedAttributes: string[] }>`. Implementation: (a) Build a set of seed document frontmatter attributes (domain, tags) per seed path by looking up the seed in the documents array. (b) For each non-excluded, non-seed document, count shared attributes with any seed: +1 for matching domain, +1 for each shared tag. Require at minimum: (domain match AND 1+ shared tag) OR (2+ shared tags without domain match). (c) Collect candidates with their shared attribute count and shared attribute names. (d) Sort by shared count descending, then by BM25 score of the candidate descending as tie-breaker (per spec). (e) Return top `maxResults`.

- [ ] Step 3: In `src/server.ts`, after the PPR expansion block (from Task 6), add the shared-attribute expansion. Import `findSharedAttributeNeighbors`, `SHARED_ATTR_DISCOUNT`, `SHARED_ATTR_MAX` from scoring.ts (extend existing import). Call: `const sharedAttrNeighbors = findSharedAttributeNeighbors(qualifyingResults.map(r => r.path), documents.map(d => ({ path: d.path, frontmatter: d.frontmatter })), new Set(finalResults.map(r => r.path)), SHARED_ATTR_MAX);`. For each neighbor, find the document, compute score as `SHARED_ATTR_DISCOUNT * qualifyingResults[0].score` (use the top qualifying result's score as parent). Create ScoredResults and append to finalResults. Re-sort finalResults by score descending.

- [ ] Step 4: In `eval/layers/unit.js`, add a `testFindSharedAttributeNeighbors()` function. Import `findSharedAttributeNeighbors` from scoring.js. Create 4 documents: A (domain=billing, tags=[billing,concept]), B (domain=billing, tags=[billing,rule]), C (domain=tenants, tags=[tenants,concept]), D (domain=billing, tags=[billing,concept]). Call with seedPaths=[A.path], excludePaths=empty set. Assert: D is returned (same domain + shared tag "billing" + shared tag "concept"), B is returned (same domain + shared tag "billing"). C is NOT returned (different domain, no shared tags). Assert D ranks above B (more shared attributes).

- [ ] Step 5: Register the new test in `runUnitLayer`.

- [ ] Step 6: Commit

---

### Task 8: Add metadata-driven pre-filtering (hint boost)

**Files:**
- Modify: `src/scoring.ts`
- Modify: `src/server.ts`
- Modify: `eval/layers/unit.js`

**Acceptance criteria:**
- [ ] `extractQueryMetadataHints` exported from scoring.ts: takes query string and documents array, returns `{ domains: string[], types: string[] }`
- [ ] `METADATA_HINT_BOOST = 1.5` and `METADATA_HINT_STOPLIST` exported from scoring.ts
- [ ] Stoplist contains `['concept', 'entry', 'note', 'guide', 'item', 'record']`
- [ ] Values with length <= 2 are excluded from matching
- [ ] Boost is applied as a 1.5x multiplier on BM25 scores for documents matching hinted domain/type, applied after BM25 scoring but before link boost and confidence/recency steps
- [ ] Empty hints (no matches) result in no boost applied
- [ ] Unit test verifies correct hint extraction and that stoplisted terms are excluded

**Verification:**
- Run: `npm run build`
- Expected: No compilation errors
- Run: `node eval/run.js --layer unit`
- Expected: All unit tests pass
- Run: `node eval/run.js`
- Expected: No server errors

#### Steps

- [ ] Step 1: Add constants to `src/scoring.ts`: `export const METADATA_HINT_BOOST = 1.5; export const METADATA_HINT_STOPLIST = ['concept', 'entry', 'note', 'guide', 'item', 'record'];`.

- [ ] Step 2: Add `extractQueryMetadataHints` function to `src/scoring.ts`. Signature: `export function extractQueryMetadataHints(query: string, documents: Array<{ frontmatter: Frontmatter }>): { domains: string[]; types: string[] }`. Implementation: (a) Collect all unique domain values and type values from documents' frontmatter. (b) Filter out values with length <= 2 and values in METADATA_HINT_STOPLIST. (c) Tokenize the query (lowercase, split on whitespace). (d) For each remaining domain value, check if the lowercased value appears as a token in the query tokens. (e) Same for type values. (f) Return `{ domains, types }` arrays of matching values.

- [ ] Step 3: Add `applyMetadataHintBoost` function to `src/scoring.ts`. Signature: `export function applyMetadataHintBoost(results: ScoredResult[], hints: { domains: string[]; types: string[] }): ScoredResult[]`. If hints.domains and hints.types are both empty, return results unchanged. Otherwise, for each result: if `result.frontmatter.domain` is in hints.domains OR `result.frontmatter.type` is in hints.types, multiply score by METADATA_HINT_BOOST. Return new array.

- [ ] Step 4: In `src/server.ts`, in the `lore_query` handler, after Step 2 (BM25 scoring, around line 697) and before Step 3 (link boost), insert the metadata hint boost. Import `extractQueryMetadataHints`, `applyMetadataHintBoost` from scoring.ts. Call: `const hints = extractQueryMetadataHints(question, documents); scored = applyMetadataHintBoost(scored, hints);`. This goes between the BM25 scoring and the `applyLinkBoost` call.

- [ ] Step 5: In `eval/layers/unit.js`, add `testExtractQueryMetadataHints()`. Import `extractQueryMetadataHints` from scoring.js. Create documents with domains ["billing", "tenants"] and types ["concept", "rule"]. Test 1: query "billing rules" returns domains=["billing"], types=["rule"] (not "rules" -- check against exact frontmatter values). Test 2: query "concept overview" returns domains=[], types=[] (concept is in stoplist). Test 3: query "ab" returns empty (values <= 2 chars excluded). Test 4: query "no match here" returns empty.

- [ ] Step 6: Register the new test in `runUnitLayer`.

- [ ] Step 7: Commit

---

### Task 9: Run final eval, tune constants, and commit Phase 2 baseline

**Files:**
- Modify: `eval/baseline.json`
- Modify: `src/scoring.ts` (only if constant tuning is needed)

**Acceptance criteria:**
- [ ] Eval suite runs with no server errors
- [ ] Multi-hop recall@5 >= 0.60 against Phase 1 baseline, OR constants are tuned to achieve this, OR Phase 2 retrieval changes are reverted and only Phase 1 eval expansion ships (per spec fallback)
- [ ] No other ability regresses beyond 0.05 tolerance against Phase 1 baseline
- [ ] `eval/baseline.json` updated with final scores
- [ ] All sub-type breakdowns are populated in the report

**Verification:**
- Run: `node eval/run.js --verbose`
- Expected: Full table with sub-type breakdown, no server errors
- Run: `node eval/compare.js --baseline eval/baseline.json --current eval/results/<report>.json`
- Expected: All abilities "steady", exit code 0
- Run: `node eval/compare.js --baseline <phase1-baseline-copy>.json --current eval/results/<report>.json --tolerance 0.05`
- Expected: No ability regressed beyond 0.05 from Phase 1

#### Steps

- [ ] Step 1: Run `npm run build && node eval/run.js --verbose`. Capture the report path and review the table output. Check that all 20 multi-hop questions completed without server errors. Note the multi-hop recall@5 and per-sub-type breakdown.

- [ ] Step 2: Run `node eval/compare.js --baseline eval/baseline.json --current eval/results/<report>.json` (where baseline.json is the Phase 1 baseline from Task 4). Check that multi_hop recall@5 improved and no other ability regressed beyond 0.05.

- [ ] Step 3: If multi-hop recall@5 < 0.60, try tuning constants in `src/scoring.ts`: increase `MAX_EXPANSION` from 5 to 7, increase `PPR_ITERATIONS` from 20 to 30, adjust `SHARED_ATTR_DISCOUNT` from 0.7 to 0.8, adjust `METADATA_HINT_BOOST` from 1.5 to 1.8. Re-run `npm run build && node eval/run.js` after each change. If still below 0.60 after reasonable tuning, follow spec fallback: revert Phase 2 changes (Tasks 5-8), keep only Phase 1 eval expansion, and commit the Phase 1 baseline as final.

- [ ] Step 4: Once satisfied with scores, update `eval/baseline.json` with the final report data in baseline format: `{ generated_at, tier, layer, commit, abilities }`. Get commit hash via `git rev-parse --short HEAD`.

- [ ] Step 5: Run `node eval/compare.js --baseline eval/baseline.json --current eval/results/<report>.json` one final time to confirm all "steady" with exit code 0.

- [ ] Step 6: Commit
