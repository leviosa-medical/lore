---
spec: docs/specs/eval-benchmark-design.md
---

# Eval Benchmark Harness Implementation Plan

**Goal:** Build a self-contained benchmark harness in `eval/` that measures Recall@k, NDCG@k, and latency for Lore's retrieval pipeline across six abilities, using a synthetic corpus and deterministic evaluation.

**Architecture:** Scoring internals are extracted from `src/server.ts` into `src/scoring.ts` so the eval unit layer can import pure functions directly from `dist/scoring.js`. The harness has three phases: generate (synthetic corpus + question sets), evaluate (unit layer calling scoring functions directly, integration layer calling MCP tools via StdioClientTransport), and report (table to stdout, JSON to `eval/results/`). All eval files are plain `.js` importing from `../dist/scoring.js` and Node built-ins only.

---

### Task 1: Extract scoring internals into `src/scoring.ts`

**Files:**
- Create: `src/scoring.ts`
- Modify: `src/server.ts`

**Acceptance criteria:**
- [ ] `src/scoring.ts` exports: `computeBM25Scores`, `tokenize`, `confidenceBonus`, `applyLinkBoost`, `buildInboundCounts`, `extractWikilinks`, `buildLookupMaps`, `parseFrontmatter`, `buildPage`, `extractBody`, `type Frontmatter`, `type ScoredResult`
- [ ] `src/server.ts` imports all the above from `"./scoring.js"` and contains no duplicate definitions of extracted functions/types
- [ ] `npm run build` succeeds and produces both `dist/scoring.js` and `dist/server.js`
- [ ] `dist/scoring.js` is the unbundled tsc output (not overwritten by esbuild)
- [ ] `dist/server.js` is the esbuild bundle (self-contained, inlines scoring.js content)
- [ ] `npm start` still works (server starts and connects)

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build`
- Expected: Exit code 0, `dist/scoring.js` and `dist/server.js` both exist
- Run: `node -e "import('./dist/scoring.js').then(m => console.log(Object.keys(m).sort().join(',')))"`
- Expected: `applyLinkBoost,buildInboundCounts,buildLookupMaps,buildPage,computeBM25Scores,confidenceBonus,extractBody,extractWikilinks,parseFrontmatter,tokenize`

#### Steps

- [ ] Step 1: Create `src/scoring.ts` with the `Frontmatter` interface, `ScoredResult` interface, and these functions moved verbatim from `src/server.ts`: `parseFrontmatter`, `extractBody`, `buildPage`, `tokenize`, `computeBM25Scores`, `extractWikilinks`, `buildLookupMaps`, `buildInboundCounts`, `applyLinkBoost`, `confidenceBonus`. Add `export` to each function and both interfaces. Add the necessary Node imports (`import * as path from "node:path"` is not needed since none of these functions use `path`).
- [ ] Step 2: In `src/server.ts`, remove the function and interface definitions that were moved. Add `import { computeBM25Scores, tokenize, confidenceBonus, applyLinkBoost, buildInboundCounts, extractWikilinks, buildLookupMaps, parseFrontmatter, buildPage, extractBody, type Frontmatter, type ScoredResult } from "./scoring.js";` near the top of the file.
- [ ] Step 3: Run `npm run build` and verify both `dist/scoring.js` (tsc output) and `dist/server.js` (esbuild bundle) exist. Verify `dist/scoring.js` contains the exported functions by running the dynamic import check.
- [ ] Step 4: Commit: "refactor: extract scoring internals into src/scoring.ts for eval harness"

---

### Task 2: Create scoring metrics module (`eval/scoring/metrics.js`)

**Files:**
- Create: `eval/scoring/metrics.js`

**Acceptance criteria:**
- [ ] Exports `recallAtK(retrieved, expected, k)` returning float in [0, 1]
- [ ] Exports `ndcgAtK(retrieved, expected, k, grades?)` returning float in [0, 1], supporting both binary relevance and graded relevance via optional `grades` Map
- [ ] Exports `abstentionAccuracy(retrieved)` returning 1.0 if empty, 0.0 otherwise
- [ ] Exports `latencyStats(latencies)` returning `{ p50, p95, max }` using sorted-array floor indexing, returning `{ p50: 0, p95: 0, max: 0 }` for empty input

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && node -e "import('./eval/scoring/metrics.js').then(m => { console.log(m.recallAtK(['a','b','c'], ['a','b'], 3)); console.log(m.ndcgAtK(['a','b','c'], ['a','b'], 3)); console.log(m.abstentionAccuracy([])); console.log(JSON.stringify(m.latencyStats([10,20,30,40,50]))); })"`
- Expected: `1` (recall), a float close to 1.0 (ndcg), `1` (abstention), `{"p50":30,"p95":50,"max":50}` (latency)

#### Steps

- [ ] Step 1: Create directory `eval/scoring/`.
- [ ] Step 2: Implement `recallAtK(retrieved, expected, k)`: slice `retrieved` to length `k`, count how many of `expected` appear in the slice, divide by `expected.length`. If `expected` is empty, return 1.0 (vacuous truth).
- [ ] Step 3: Implement `ndcgAtK(retrieved, expected, k, grades)`: Compute DCG as `sum over i in [0, k) of rel(retrieved[i]) / log2(i + 2)` where `rel(title)` is `grades.get(title) || 0` if grades provided, or `1` if title is in expected set (binary). Compute IDCG by sorting relevance grades descending, applying same formula. Return DCG / IDCG. If IDCG is 0, return 0.
- [ ] Step 4: Implement `abstentionAccuracy(retrieved)`: return `retrieved.length === 0 ? 1.0 : 0.0`.
- [ ] Step 5: Implement `latencyStats(latencies)`: if empty return `{ p50: 0, p95: 0, max: 0 }`. Otherwise sort ascending, return `{ p50: sorted[Math.floor(0.5 * n)], p95: sorted[Math.floor(0.95 * n)], max: sorted[n - 1] }` where `n = sorted.length`.
- [ ] Step 6: Export all four functions as named exports in an ESM module (use `export function` syntax, no default export).
- [ ] Step 7: Commit: "feat(eval): add scoring metrics module with Recall@k, NDCG@k, abstention, latency"

---

### Task 3: Create PRNG utility and synthetic corpus generator (`eval/generate/corpus.js`)

**Files:**
- Create: `eval/generate/corpus.js`

**Acceptance criteria:**
- [ ] Exports `generateCorpus(tier, outputDir)` that creates a lore-compatible directory structure in `outputDir`
- [ ] Returns a manifest object mapping entry titles to `{ path, type, domain, confidence, created, updated, wikilinks, uniqueTerms }`
- [ ] Uses a seeded LCG PRNG (seed=42, multiplier=1664525, increment=1013904223, modulus=2^32) -- no `Math.random()`
- [ ] Supports three tiers: small (50 entries), medium (200), large (500)
- [ ] Entry distribution: 24% concepts, 20% entities, 16% rules, 10% roles, 10% decisions, 10% glossary, 10% sources
- [ ] Three domains: "billing", "tenants", "maintenance"; confidence: 30% verified, 40% inferred, 30% assumed
- [ ] Each entry has 2-3 unique compound terms in its body that appear nowhere else in the corpus
- [ ] Average 2-3 wikilinks per entry forming a connected graph
- [ ] 10% of entries are version pairs (v1/v2) with overlapping vocabulary, different `updated` dates, and a supersedes wikilink
- [ ] Writes `index.md` to `outputDir`
- [ ] Uses `buildPage` from `../dist/scoring.js` to write entry files
- [ ] Two runs with the same tier produce byte-identical output

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/generate/corpus.js').then(async m => { const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path'); const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-')); const manifest = await m.generateCorpus('small', d); console.log('entries:', Object.keys(manifest).length); console.log('has index:', (await fs.stat(path.join(d, 'index.md')).catch(() => null)) !== null); await fs.rm(d, { recursive: true }); })"`
- Expected: `entries: 50`, `has index: true`

#### Steps

- [ ] Step 1: Implement a seeded LCG class at the top of the file: `class LCG { constructor(seed = 42) { this.state = seed >>> 0; } next() { this.state = (this.state * 1664525 + 1013904223) >>> 0; return this.state; } float() { return this.next() / 0x100000000; } int(min, max) { return min + (this.next() % (max - min + 1)); } pick(arr) { return arr[this.next() % arr.length]; } shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = this.next() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; } }`.
- [ ] Step 2: Define vocabulary arrays: a list of 20+ domain nouns per domain ("billing": ["invoice", "payment", "ledger", ...], "tenants": ["lease", "occupant", "unit", ...], "maintenance": ["repair", "inspection", "plumbing", ...]). Define a list of 15+ action/modifier words (["processing", "management", "validation", "override", ...]). Define the tier configs: `{ small: { entries: 50 }, medium: { entries: 200 }, large: { entries: 500 } }`.
- [ ] Step 3: Define entry type distribution as a flat array of type strings repeated by proportion: concepts (24%), entities (20%), rules (16%), roles (10%), decisions (10%), glossary (10%), sources (10%). Use `rng.shuffle()` and assign types by cycling through entries.
- [ ] Step 4: Implement title and body generation. Each entry gets a title from `"<Domain-Noun> <Modifier> <Type-label>"` (e.g., "Invoice Processing Concept"). Body is 3-5 sentences using domain vocabulary. Inject 2-3 unique compound terms per entry (format: `"<noun>-<modifier>-<seq>"` where seq is a global counter, guaranteeing uniqueness across the corpus). Track these unique terms in the manifest.
- [ ] Step 5: Implement wikilink generation. After all entries are titled, assign 2-3 wikilinks per entry pointing to other entries by title. Use the LCG to pick targets. Ensure the graph is connected: after random assignment, verify connectivity via BFS from entry 0. If disconnected components exist, add a bridge link from each component to the previous one.
- [ ] Step 6: Implement version-pair generation. For 10% of entries (rounded), generate a second entry with the same base title + " v2", sharing 60%+ of body vocabulary with the original but with different unique compound terms and a newer `updated` date. The v2 body includes `"This supersedes the earlier [[<v1 title>]]"`. Both entries are included in the manifest; v2 entries have a `supersedes` field pointing to the v1 title.
- [ ] Step 7: Implement temporal metadata. Spread `created` and `updated` dates across a 365-day range starting from `"2025-01-01"`. For version pairs, v1 gets an earlier `updated` date (first half of range) and v2 gets a later one (second half).
- [ ] Step 8: Implement confidence distribution: 30% verified, 40% inferred, 30% assumed, assigned deterministically via the LCG.
- [ ] Step 9: Import `buildPage` from `"../dist/scoring.js"`. For each entry, construct the frontmatter object and body string, call `buildPage(frontmatter, body)`, and write to the appropriate type subdirectory (`<outputDir>/<type-dir>/<slug>.md`). Write `index.md` listing all entries grouped by type.
- [ ] Step 10: Return the manifest object with all entry metadata including `uniqueTerms`, `wikilinks`, `supersedes` (for v2 entries), and file paths relative to `outputDir`.
- [ ] Step 11: Commit: "feat(eval): add synthetic corpus generator with seeded PRNG and version pairs"

---

### Task 4: Create question set generator (`eval/generate/questions.js`)

**Files:**
- Create: `eval/generate/questions.js`

**Acceptance criteria:**
- [ ] Exports `generateQuestions(manifest, tier)` returning an array of question objects
- [ ] Each question has `{ id, ability, query, expected_titles, k, grades? }`
- [ ] Question counts match tier table: small = 38 total (10+8+5+5+5+5), medium = 75, large = 150
- [ ] Six abilities: "information_extraction", "multi_hop", "knowledge_updates", "keyword_metadata", "filtered_search", "abstention"
- [ ] Filtered Search questions include `filterParams: { domain?, confidence? }` for domain-only, confidence-only, and combined filters
- [ ] Information Extraction queries use unique compound terms from the manifest
- [ ] Multi-hop queries reference entry vocabulary that is disjoint from linked entry vocabulary
- [ ] Knowledge Updates queries use shared vocabulary between v1/v2 pairs
- [ ] Abstention queries use fabricated terms with no corpus match
- [ ] Deterministic output via the same seeded LCG (seed=42)

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/generate/corpus.js').then(async mc => { const mq = await import('./eval/generate/questions.js'); const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path'); const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-')); const manifest = await mc.generateCorpus('small', d); const qs = mq.generateQuestions(manifest, 'small'); console.log('total:', qs.length); const abilities = {}; for (const q of qs) abilities[q.ability] = (abilities[q.ability]||0)+1; console.log(JSON.stringify(abilities)); await fs.rm(d, { recursive: true }); })"`
- Expected: `total: 38`, abilities matching `{"information_extraction":10,"multi_hop":8,"knowledge_updates":5,"keyword_metadata":5,"filtered_search":5,"abstention":5}`

#### Steps

- [ ] Step 1: Import the LCG class from `./corpus.js` (export it from corpus.js as a named export alongside `generateCorpus`). Define tier question counts: `{ small: { information_extraction: 10, multi_hop: 8, knowledge_updates: 5, keyword_metadata: 5, filtered_search: 5, abstention: 5 }, medium: { ... }, large: { ... } }`.
- [ ] Step 2: Implement Information Extraction question generation. For each question, pick a random non-v2 entry from the manifest, use one of its `uniqueTerms` as the query. `expected_titles: [entry.title]`, `k: 5`. Generate an auto-incrementing `id` (format: `"ie-001"`).
- [ ] Step 3: Implement Multi-hop question generation. Pick entries that have wikilinks to other entries. Use a distinctive term from the source entry as the query (not shared with linked entries). `expected_titles`: the source entry plus its wikilink targets (1-hop). `k: 5`. Add `grades` map: source entry gets grade 1.0, each wikilink target gets grade `0.5`. ID format: `"mh-001"`.
- [ ] Step 4: Implement Knowledge Updates question generation. For each v2 entry in the manifest, use a term that appears in both v1 and v2 bodies (the shared vocabulary). `expected_titles: [v2Title, v1Title]` (v2 first). `k: 5`. Add `grades` map: v2 title gets grade 2, v1 title gets grade 1. ID format: `"ku-001"`.
- [ ] Step 5: Implement Keyword Metadata question generation. Pick entries and construct queries from their tags, domain name, and type label (metadata terms) rather than body terms. `expected_titles`: all entries matching those metadata terms. `k: 5`. ID format: `"km-001"`.
- [ ] Step 6: Implement Filtered Search question generation. Generate three kinds: domain-only filter (query + `filterParams: { domain }`), confidence-only filter (query + `filterParams: { confidence }`), and combined filter (query + `filterParams: { domain, confidence }`). Pick a body term as the query and compute `expected_titles` as entries matching both the keyword and the filter criteria. `k: 5`. ID format: `"fs-001"`.
- [ ] Step 7: Implement Abstention question generation. Generate queries from fabricated compound terms not in any entry (e.g., `"xyzzy-quantum-<seq>"`). `expected_titles: []`, `k: 5`. ID format: `"ab-001"`.
- [ ] Step 8: Commit: "feat(eval): add question set generator for six retrieval abilities"

---

### Task 5: Create unit test layer (`eval/layers/unit.js`)

**Files:**
- Create: `eval/layers/unit.js`

**Acceptance criteria:**
- [ ] Exports `runUnitLayer()` returning an array of `{ id, ability, passed, recall, ndcg, details }` objects
- [ ] Imports scoring functions from `../../dist/scoring.js` and metric functions from `../scoring/metrics.js`
- [ ] Tests BM25 correctness: 5 hand-crafted documents, assert `computeBM25Scores` returns them in expected relevance order
- [ ] Tests confidence bonus: asserts `confidenceBonus("verified") === 0.3`, `confidenceBonus("inferred") === 0.15`, `confidenceBonus("assumed") === 0` (passing `undefined`)
- [ ] Tests link boost: given known inbound counts, asserts `applyLinkBoost` increases scores proportionally
- [ ] Tests metric functions: `recallAtK` and `ndcgAtK` with hand-crafted inputs (perfect=1.0, empty=0.0, partial=expected fraction)
- [ ] Tests wikilink extraction: asserts `extractWikilinks` parses `[[links]]` and ignores content inside code blocks

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/layers/unit.js').then(async m => { const results = await m.runUnitLayer(); console.log('tests:', results.length); console.log('passed:', results.filter(r => r.passed).length); })"`
- Expected: `tests: 5` (or more), `passed: 5` (all pass)

#### Steps

- [ ] Step 1: Import `computeBM25Scores`, `tokenize`, `confidenceBonus`, `applyLinkBoost`, `extractWikilinks` from `"../../dist/scoring.js"`. Import `recallAtK`, `ndcgAtK` from `"../scoring/metrics.js"`.
- [ ] Step 2: Implement BM25 correctness test: Create 5 documents about different topics (e.g., "billing invoices", "tenant leases", "plumbing repairs", "payment processing", "roof inspection"). Query "invoice payment billing". Assert that the billing and payment documents score highest (positions 0 and 1 in the sorted result). Return `{ id: "unit-bm25", ability: "bm25_correctness", passed, recall, ndcg, details }`.
- [ ] Step 3: Implement confidence bonus test: Assert `confidenceBonus("verified") === 0.3`, `confidenceBonus("inferred") === 0.15`, `confidenceBonus(undefined) === 0`. Return `{ id: "unit-confidence", ability: "confidence_bonus", passed, ... }`.
- [ ] Step 4: Implement link boost test: Create 3 `ScoredResult` objects with scores `[1.0, 1.0, 1.0]`. Create an inbound counts map where entry A has 10 inbound links, B has 1, C has 0. Call `applyLinkBoost(results, counts)`. Assert A's score > B's score > C's score (C unchanged since `log(1+0) = 0`). Return result object.
- [ ] Step 5: Implement metrics test: (a) `recallAtK(["a","b","c"], ["a","b"], 3)` === 1.0. (b) `recallAtK(["x","y","z"], ["a","b"], 3)` === 0.0. (c) `recallAtK(["a","x","y"], ["a","b"], 3)` === 0.5. (d) `ndcgAtK(["a","b"], ["a","b"], 2)` === 1.0 (perfect). (e) `ndcgAtK(["b","a"], ["a","b"], 2)` === 1.0 (binary relevance, order doesn't matter for binary). Assert all hold. Return result object.
- [ ] Step 6: Implement wikilink extraction test: Assert `extractWikilinks("See [[Topic A]] and [[Topic B]]")` returns `["Topic A", "Topic B"]`. Assert `extractWikilinks("```\n[[Not a link]]\n```\nSee [[Real Link]]")` returns `["Real Link"]`. Assert `extractWikilinks("Use \`[[inline code]]\` and [[Actual]]")` returns `["Actual"]`. Return result object.
- [ ] Step 7: Wrap all tests in a `runUnitLayer()` async function that runs each test, catches errors (marking as failed with error detail), and returns the results array.
- [ ] Step 8: Commit: "feat(eval): add unit test layer for scoring internals"

---

### Task 6: Create integration test layer (`eval/layers/integration.js`)

**Files:**
- Create: `eval/layers/integration.js`

**Acceptance criteria:**
- [ ] Exports `runIntegrationLayer(questions, lorePath)` returning an array of `{ id, ability, query, expected_titles, retrieved_titles, recall, ndcg, latencyMs, status }` per question
- [ ] Spawns the lore MCP server as a child process using `StdioClientTransport` with `LORE_PATH` env var
- [ ] Uses `Client` from `@modelcontextprotocol/sdk/client/index.js` to call `lore_search` or `lore_query` based on ability
- [ ] Routes abilities to tools: information_extraction/knowledge_updates/keyword_metadata/filtered_search/abstention -> `lore_search`; multi_hop -> `lore_query`
- [ ] Parses titles from tool output using the two format-specific regexes from the spec
- [ ] Measures per-question latency via `performance.now()`
- [ ] Handles Abstention questions with `abstentionAccuracy` instead of recall/ndcg
- [ ] Handles server crash: catches transport errors, marks remaining questions as `status: "server_error"` with score 0, exits gracefully
- [ ] Shuts down cleanly via `client.close()` after all questions
- [ ] 10-second connection timeout: if server doesn't connect within 10s, throws with a clear error

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/generate/corpus.js').then(async mc => { const mi = await import('./eval/layers/integration.js'); const mq = await import('./eval/generate/questions.js'); const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path'); const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-')); const manifest = await mc.generateCorpus('small', d); const qs = mq.generateQuestions(manifest, 'small'); const results = await mi.runIntegrationLayer(qs.slice(0, 3), d); console.log('results:', results.length); console.log('statuses:', results.map(r => r.status)); await fs.rm(d, { recursive: true }); })"`
- Expected: `results: 3`, statuses all `"ok"` or `"completed"`

#### Steps

- [ ] Step 1: Import `Client` from `"@modelcontextprotocol/sdk/client/index.js"` and `StdioClientTransport` from `"@modelcontextprotocol/sdk/client/stdio.js"`. Import metric functions from `"../scoring/metrics.js"`.
- [ ] Step 2: Implement `createClient(lorePath)` helper: creates `StdioClientTransport` with `command: "node"`, `args: ["dist/server.js"]`, `env: { ...process.env, LORE_PATH: lorePath }`. Creates `Client` with `{ name: "eval-harness", version: "1.0.0" }`. Calls `client.connect(transport)`. Wraps in a 10-second timeout using `Promise.race` with a timeout rejection. Returns `{ client, transport }`.
- [ ] Step 3: Implement `parseSearchTitles(text)`: applies regex `/\*\*(.+?)\*\*\s+\(/g` to extract titles from `lore_search` format. Returns empty array if text matches `No results found for:`.
- [ ] Step 4: Implement `parseQueryTitles(text)`: applies regex `/^## (.+?) \(/gm` to extract titles from `lore_query` format. Returns empty array if text matches `No relevant lore entries found for:`.
- [ ] Step 5: Implement the tool routing map: `{ information_extraction: "lore_search", multi_hop: "lore_query", knowledge_updates: "lore_search", keyword_metadata: "lore_search", filtered_search: "lore_search", abstention: "lore_search" }`.
- [ ] Step 6: Implement `runIntegrationLayer(questions, lorePath)`. Create the MCP client. Iterate over questions. For each: record `performance.now()` start time; call `client.callTool({ name: toolName, arguments: args })` where args include `query`/`question` and for filtered_search also `domain`/`confidence` from `question.filterParams`; record end time and compute `latencyMs`; parse titles using the tool-specific parser; compute metrics (recall/ndcg for normal abilities, abstentionAccuracy for abstention); push result object. Wrap the loop in try/catch: on transport error, mark remaining questions as `{ status: "server_error", recall: 0, ndcg: 0, latencyMs: 0 }`.
- [ ] Step 7: After the loop (in a `finally` block), call `client.close()` to shut down cleanly.
- [ ] Step 8: Commit: "feat(eval): add integration test layer with MCP client and title parsing"

---

### Task 7: Create runner script (`eval/run.js`) and results directory

**Files:**
- Create: `eval/run.js`
- Create: `eval/results/.gitkeep`

**Acceptance criteria:**
- [ ] `node eval/run.js` runs end-to-end: build, generate, evaluate, report, clean up
- [ ] Parses CLI args: `--tier small|medium|large` (default: small), `--layer unit|integration|all` (default: all), `--threshold <float>`, `--max-latency-ms <int>` (default: 200), `--output <dir>` (default: eval/results/)
- [ ] Runs `npm run build` first; exits with code 2 on build failure
- [ ] Generates corpus into temp dir via `fs.mkdtemp`, cleans up in `finally` block
- [ ] Prints results table to stdout matching the spec format (columns: Ability, Recall@1, Recall@5, Recall@10, NDCG@5, NDCG@10, p50ms, p95ms)
- [ ] Latency columns omitted when `--layer unit`
- [ ] Abstention row shows accuracy under Recall@5, dashes in other metric columns
- [ ] Overall row shows only latency stats (integration layer only)
- [ ] Writes JSON report to `eval/results/report-<timestamp>.json` with all fields from the spec
- [ ] Exit code 0 when no threshold or all abilities pass; exit code 1 when any ability fails threshold or p95 latency exceeds `--max-latency-ms`; exit code 2 on build/server failure
- [ ] `eval/results/` is gitignored

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small --layer unit`
- Expected: Exit code 0, results table printed to stdout, JSON report written to `eval/results/`
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small --layer all`
- Expected: Exit code 0, results table with latency columns, JSON report with per-question latencies

#### Steps

- [ ] Step 1: Implement CLI arg parsing using `process.argv`. Parse `--tier` (validate: small/medium/large, default: small), `--layer` (validate: unit/integration/all, default: all), `--threshold` (parse as float, optional), `--max-latency-ms` (parse as int, default: 200), `--output` (string, default: `"eval/results/"`).
- [ ] Step 2: Implement the build step: run `npm run build` via `child_process.execSync`. On failure, print the build error to stderr and exit with code 2.
- [ ] Step 3: Import `generateCorpus` from `"./generate/corpus.js"` and `generateQuestions` from `"./generate/questions.js"`. Create temp directory via `fs.mkdtemp(path.join(os.tmpdir(), "lore-eval-"))`. Generate corpus and questions.
- [ ] Step 4: Import `runUnitLayer` from `"./layers/unit.js"` and `runIntegrationLayer` from `"./layers/integration.js"`. Conditionally run based on `--layer` flag. Collect results from each layer.
- [ ] Step 5: Implement results aggregation. Group integration results by ability. For each ability, compute Recall@1, Recall@5, Recall@10 (re-compute recall at different k values from the raw retrieved/expected data) and NDCG@5, NDCG@10. For Abstention, compute mean `abstentionAccuracy`. Compute per-ability `latencyStats` from per-question `latencyMs` values. Compute overall latency stats from the flat array of all per-question latencies.
- [ ] Step 6: Implement the stdout results table. Use fixed-width columns with `String.padStart`/`padEnd`. Ability names: "Information Extraction", "Multi-hop Reasoning", "Knowledge Updates", "Keyword Metadata", "Filtered Search", "Abstention (accuracy)", "Overall". Format floats to 2 decimal places. Show dashes for inapplicable cells. Omit p50ms/p95ms columns when `--layer unit`.
- [ ] Step 7: Implement JSON report generation. Construct the report object with: `timestamp` (ISO string), `tier`, `layer`, `corpus_size`, per-ability metrics (including latency percentiles), overall latency stats, `threshold` (null if not set), `max_latency_ms`, `pass` boolean, and `per_question` array. Write to `<output>/report-<timestamp>.json` using `fs.writeFile`. Create the output directory if it doesn't exist.
- [ ] Step 8: Implement threshold checking. If `--threshold` is set: iterate abilities; for retrieval abilities, check `recall_at_5 >= threshold`; for abstention, check `abstentionAccuracy >= threshold`. Also check `overall_p95 <= max_latency_ms` (integration layer only). If any check fails, set pass=false.
- [ ] Step 9: Implement cleanup in a `finally` block: `await fs.rm(tempDir, { recursive: true, force: true })`. Determine exit code: 0 if pass or no threshold, 1 if threshold fail, 2 if build/server error (set earlier). Call `process.exit(code)`.
- [ ] Step 10: Add `eval/results/` to the project `.gitignore`. Create `eval/results/.gitkeep` as an empty file so the directory exists in the repo.
- [ ] Step 11: Commit: "feat(eval): add runner script with CLI args, table output, and JSON reporting"

---

### Task 8: End-to-end validation and adjustments

**Files:**
- Modify: `eval/generate/corpus.js` (if fixes needed)
- Modify: `eval/generate/questions.js` (if fixes needed)
- Modify: `eval/layers/integration.js` (if fixes needed)
- Modify: `eval/run.js` (if fixes needed)

**Acceptance criteria:**
- [ ] `node eval/run.js --tier small --layer unit` completes with exit code 0 and all unit tests pass
- [ ] `node eval/run.js --tier small --layer integration` completes with exit code 0, all questions get `status: "ok"`, and non-zero scores for non-abstention abilities
- [ ] `node eval/run.js --tier small --layer all` completes with exit code 0, prints full results table with latency columns, and writes a valid JSON report
- [ ] `node eval/run.js --tier small --threshold 0.5` exits with code 0 (baseline should exceed 0.5 for most abilities)
- [ ] `node eval/run.js --tier medium --layer all` completes within 30 seconds
- [ ] Two consecutive runs of `node eval/run.js --tier small` produce identical metric values (determinism check)
- [ ] JSON report contains all required fields: timestamp, tier, layer, corpus_size, per-ability metrics with latency, overall latency, threshold, pass, per_question array

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small --layer all`
- Expected: Exit code 0, complete results table with all six abilities + Overall row, JSON report in `eval/results/`
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small --threshold 0.01`
- Expected: Exit code 0 (very low threshold should always pass)
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small --threshold 1.0`
- Expected: Exit code 1 (impossibly high threshold should fail)

#### Steps

- [ ] Step 1: Run `node eval/run.js --tier small --layer unit` and verify all unit tests pass. Fix any import path issues, function signature mismatches, or assertion failures.
- [ ] Step 2: Run `node eval/run.js --tier small --layer integration` and verify all questions complete. Debug any MCP client connection issues, title parsing failures, or tool call errors. Ensure the server starts and connects within the 10-second timeout.
- [ ] Step 3: Run `node eval/run.js --tier small --layer all` and verify the full pipeline. Check the results table format matches the spec. Check the JSON report has all required fields.
- [ ] Step 4: Run the determinism check: execute the small-tier run twice and compare the metric values in both JSON reports. If they differ, trace the non-determinism to a `Math.random()` usage or non-deterministic iteration order, and fix it.
- [ ] Step 5: Run `node eval/run.js --tier small --threshold 0.01` (should pass) and `node eval/run.js --tier small --threshold 1.0` (should fail with exit code 1). Verify threshold behavior and exit codes.
- [ ] Step 6: Review the actual Recall@5 and NDCG scores in the results. If any non-abstention ability scores exactly 0 on all questions, investigate whether the corpus generator or question generator has a bug (e.g., unique terms not actually unique, wikilinks pointing to non-existent entries, filter params not matching any entries).
- [ ] Step 7: Commit: "fix(eval): end-to-end validation fixes for benchmark harness"
