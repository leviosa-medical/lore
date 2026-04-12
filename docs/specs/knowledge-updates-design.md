---
status: ready
---

# Spec: Write-Time Knowledge Update Consolidation

## Problem Statement

The eval's "knowledge_updates" ability tests whether retrieval can rank a v2 entry above a v1 entry when two separate files represent the same concept at different points in time. This is an artificial problem: the production `lore_write` tool already overwrites entries in-place when the title matches, so two co-existing version files never occur in practice. BM25 has no meaningful signal to prefer one version over the other when they share vocabulary, and the baseline scores confirm this (Recall@5 = 0.50, NDCG@5 = 0.477). The eval is testing a scenario the system was not designed for.

## Proposed Solution

Consolidate knowledge updates at write-time. When `lore_write` updates an existing entry, the caller provides a `change_note` describing what changed and why. The system appends this note with a timestamp to a `## History` section at the bottom of the entry body. BM25 indexing strips everything below `## History` so old vocabulary does not pollute search results. `lore_read` and `lore_query` still return the full content including history. The eval's "knowledge_updates" ability is redesigned to test this real-world behavior: updated entries are retrievable by current content, and historical terms do not surface the entry.

## User Stories

- As an LLM agent calling `lore_write` via MCP, I want to provide a `change_note` when updating an existing entry so that the knowledge base preserves an audit trail of what changed and why
- As an LLM agent searching the knowledge base via `lore_search`, I want results ranked only by current content so that obsolete terminology from prior versions does not surface stale matches
- As an LLM agent reading an entry via `lore_read`, I want to see the full history section so I can explain how a concept evolved over time
- As an LLM agent calling `lore_write` to update an entry without providing `change_note`, I want a clear error message so I know the parameter is required for updates
- As a developer running the eval, I want the knowledge_updates ability to test realistic write-time consolidation so that scores reflect actual system behavior

## Technical Approach

### Architecture

Three layers are affected: the `lore_write` tool schema and handler in `src/server.ts`, the BM25 scoring pipeline in `src/scoring.ts`, and the eval harness in `eval/generate/` and `eval/layers/`.

### Named Constant

Define the history section marker once in `src/scoring.ts` and export it:

```typescript
export const HISTORY_MARKER = "\n## History\n";
```

All code that detects or splits on the history heading must use this constant. Import it in `src/server.ts` and reference it in eval code via the built `dist/scoring.js`.

### Data Model Changes

No new files or frontmatter fields. The `## History` section is embedded in the markdown body of existing entries. Format:

```markdown
## History

- **2026-04-11**: Increased late fee from 5% to 10% per updated billing policy
- **2026-03-15**: Initial entry created from billing team interview
```

Each change note is a bullet with a bold ISO 8601 date (YYYY-MM-DD) prefix followed by the caller-provided text. Newest entries are prepended at the top of the list (reverse chronological).

### Service Layer

**`lore_write` schema change (`src/server.ts`):**

Add an optional `change_note` parameter to the `lore_write` input schema:

```typescript
change_note: z
  .string()
  .min(1)
  .optional()
  .describe("Required when updating an existing entry. Describes what changed and why."),
```

The `.min(1)` constraint rejects empty strings.

**`lore_write` handler changes (`src/server.ts`):**

In the handler, after the `isUpdate` check (near the `findPageByTitle` call):

1. If `isUpdate` is true and `change_note` is falsy, return an error: `"change_note is required when updating an existing entry (title already exists: '<title>')"`.
2. If `isUpdate` is false, ignore `change_note` silently (no error if provided on new entries).
3. If `isUpdate` is true and `change_note` is provided, modify the body before writing:
   - Extract the existing body via `extractBody(existingContent)`.
   - Split on `HISTORY_MARKER`: if the existing body contains the marker, everything before is the "current body" and everything after (including the marker) is the "history block." If no marker exists, the entire existing body is the current body and the history block is empty.
   - The caller-provided `body` parameter replaces the current body entirely (existing overwrite behavior is preserved).
   - Construct the new change note line using the existing `today()` helper (defined at line 96 of `src/server.ts`, returns `new Date().toISOString().slice(0, 10)`): `- **${today()}**: ${change_note}`.
   - If a history block exists, prepend the new line after the `## History` heading (before existing bullets). If no history block exists, append `\n\n## History\n\n${newLine}` after the new body.
   - Pass the combined body (new body + history section) to `buildPage`.

**New function `extractSearchableBody` (`src/scoring.ts`):**

```typescript
export function extractSearchableBody(content: string): string {
  const body = extractBody(content);
  const idx = body.indexOf(HISTORY_MARKER);
  if (idx === -1) return body;
  return body.slice(0, idx).trim();
}
```

Note on edge case: if the body starts exactly with `## History\n` (no preceding newline), `HISTORY_MARKER` (which begins with `\n`) will not match. This is an accepted limitation. In practice, `buildPage` always places body content before the history section, so the marker will always be preceded by body text and a newline. Document this as a known constraint in a code comment.

**BM25 indexing change (`src/scoring.ts`, `computeBM25Scores` function):**

In the tokenization loop, replace the call to `extractBody(doc.content)` with `extractSearchableBody(doc.content)`. Specifically, the line:

```typescript
const bodyText = doc.title + " " + extractBody(doc.content) + " " + searchKeys;
```

becomes:

```typescript
const bodyText = doc.title + " " + extractSearchableBody(doc.content) + " " + searchKeys;
```

This ensures BM25 never sees tokens from the `## History` section. The `extractBody` function remains unchanged and continues to return the full body for `lore_read` and `lore_query` output.

### View Layer

No UI changes. `lore_read` and `lore_query` already return full page content, which now includes the `## History` section when present.

### Eval Redesign

**Corpus generator (`eval/generate/corpus.js`):**

Remove the v2 version-pair system entirely. The `v2Count`, `baseCount` split, Phase 3 (v2 generation), and all `isV2`/`supersedes` fields are deleted. All `totalEntries` slots become base entries.

Add a new phase after body generation: for 10% of entries (deterministic via PRNG), append a `## History` section containing 2-3 change notes with old vocabulary that differs from the current body. Specifically:

- Pick `Math.floor(totalEntries * 0.1)` entries deterministically.
- For each, generate 2-3 unique compound terms from the same domain vocabulary (using `makeUniqueTerms`) that do NOT appear in the entry's current body terms.
- Build a `## History` section with timestamped bullets containing these old terms:
  ```
  ## History

  - **2025-02-10**: Changed from old-term-1 to current approach
  - **2025-01-05**: Originally described as old-term-2 process
  ```
- Append this section to the entry body.
- Record the history terms and the entry title in the manifest as `historyTerms: string[]` for question generation.

The manifest entry gains a new optional field: `historyTerms`. Entries without history have no `historyTerms` field. The `supersedes` field is removed.

**Question generator (`eval/generate/questions.js`):**

Replace the knowledge_updates question generation entirely. Two sub-types of questions, distinguished by a `questionType` field on each question object:

1. **Current-content retrieval (positive), `questionType: "positive"`:** For each entry with `historyTerms`, use one of the entry's `uniqueTerms` as the query. `expected_titles: [title]`. This verifies the entry is findable by current content.

2. **History-pollution check (negative), `questionType: "negative"`:** For each entry with `historyTerms`, use one of the `historyTerms` as the query. `expected_titles: []` (empty). This verifies that searching for obsolete vocabulary returns no results.

Split the question count: `ceil(count / 2)` positive, remainder negative. For the `small` tier with 5 knowledge_updates questions, that is 3 positive and 2 negative.

**Integration layer (`eval/layers/integration.js`):**

Change the metric routing condition at the `if (question.ability === "abstention")` branch. The new condition checks `expected_titles` length instead of ability name:

```javascript
if (question.expected_titles.length === 0) {
  abstentionAcc = abstentionAccuracy(retrieved);
} else {
  recall = recallAtK(retrieved, question.expected_titles, question.k);
  ndcg = ndcgAtK(retrieved, question.expected_titles, question.k, question.grades);
}
```

This correctly routes both `abstention` questions (which always have empty `expected_titles`) and negative `knowledge_updates` questions (which also have empty `expected_titles`) to `abstentionAccuracy`. The existing `abstention` ability continues to work identically because its questions already have `expected_titles: []`.

**Aggregation (`eval/run.js`, `aggregateIntegration` function):**

Add a third code path for `knowledge_updates`:

```javascript
if (ability === "abstention") {
  // ... existing abstention aggregation (unchanged)
} else if (ability === "knowledge_updates") {
  // Split positive vs negative by expected_titles length
  const positive = results.filter(r => r.expected_titles.length > 0);
  const negative = results.filter(r => r.expected_titles.length === 0);

  // Positive: recall/ndcg as usual
  let sumR1 = 0, sumR5 = 0, sumR10 = 0, sumN5 = 0, sumN10 = 0;
  for (const r of positive) {
    sumR1  += recallAtK(r.retrieved_titles, r.expected_titles, 1);
    sumR5  += recallAtK(r.retrieved_titles, r.expected_titles, 5);
    sumR10 += recallAtK(r.retrieved_titles, r.expected_titles, 10);
    sumN5  += ndcgAtK(r.retrieved_titles, r.expected_titles, 5);
    sumN10 += ndcgAtK(r.retrieved_titles, r.expected_titles, 10);
  }
  const pn = positive.length || 1;

  // Negative: abstention accuracy
  const isoAcc = negative.length > 0
    ? negative.reduce((sum, r) => sum + r.abstentionAcc, 0) / negative.length
    : 1.0;

  const latencies = results.map(r => r.latencyMs);
  const stats = latencyStats(latencies);

  abilityMetrics[ability] = {
    recall_at_5:                sumR5 / pn,
    history_isolation_accuracy: isoAcc,
    recall_at_1:                sumR1 / pn,
    recall_at_10:               sumR10 / pn,
    ndcg_at_5:                  sumN5 / pn,
    ndcg_at_10:                 sumN10 / pn,
    question_count:             results.length,
    latency_p50_ms:             Math.round(stats.p50),
    latency_p95_ms:             Math.round(stats.p95),
    latency_max_ms:             Math.round(stats.max),
  };
} else {
  // ... existing recall/ndcg aggregation for other abilities (unchanged)
}
```

**Baseline schema for `knowledge_updates` in `eval/baseline.json`:**

```json
"knowledge_updates": {
  "recall_at_1": 0.67,
  "recall_at_5": 1.00,
  "recall_at_10": 1.00,
  "ndcg_at_5": 0.92,
  "ndcg_at_10": 0.92,
  "history_isolation_accuracy": 1.00,
  "question_count": 5
}
```

(Values above are illustrative. Actual values are committed after running the eval post-implementation.)

**Threshold check (`eval/run.js`, `checkThresholds` function):**

Add a condition for `knowledge_updates`:

```javascript
if (ability === "knowledge_updates") {
  // Check both metrics; fail if either is below threshold
  if (m.recall_at_5 < threshold) {
    failures.push(`Knowledge Updates recall@5 ${fmt2(m.recall_at_5)} < threshold ${fmt2(threshold)}`);
  }
  if (m.history_isolation_accuracy < threshold) {
    failures.push(`Knowledge Updates history_isolation_accuracy ${fmt2(m.history_isolation_accuracy)} < threshold ${fmt2(threshold)}`);
  }
}
```

This replaces the generic `else` branch for `knowledge_updates` specifically.

**Compare script (`eval/compare.js`):**

Add `"history_isolation_accuracy"` to the `KEEP_METRICS` array:

```javascript
const KEEP_METRICS = [
  "recall_at_1", "recall_at_5", "recall_at_10",
  "ndcg_at_5", "ndcg_at_10",
  "abstention_accuracy", "history_isolation_accuracy",
];
```

Update the `primaryMetric` function to return the minimum of both metrics for regression detection:

```javascript
function primaryMetric(ability) {
  if (ability === "abstention") return "abstention_accuracy";
  if (ability === "knowledge_updates") return "recall_at_5";
  return "recall_at_5";
}
```

The `primaryMetric` for `knowledge_updates` remains `recall_at_5` for the summary table. The `history_isolation_accuracy` metric appears in the full metric breakdown (the `<details>` block) and in the `KEEP_METRICS` list, so regressions in either metric are visible. The threshold check in `run.js` (not `compare.js`) enforces both metrics independently.

**Results table (`eval/run.js`, `printTable` function):**

The `knowledge_updates` row falls through to the existing `else` branch which prints recall and NDCG columns. The `history_isolation_accuracy` metric is not shown in the summary table (it appears in the JSON report and the compare script's full breakdown). This avoids adding a new column to the table.

**Baseline update:** After implementation, re-run `node eval/run.js` and commit an updated `eval/baseline.json`. The knowledge_updates scores should improve substantially since the eval now tests achievable behavior.

## UI/UX Description

Not applicable. Changes are to an MCP tool API consumed by LLM agents and a CLI eval harness.

## Edge Cases & Error Handling

- **Missing `change_note` on update:** `lore_write` returns an `isError: true` response with message `"change_note is required when updating an existing entry (title already exists: '<title>')"`. The entry is not modified.
- **`change_note` provided on new entry:** Silently ignored. The entry is created without a `## History` section.
- **Entry body already contains `## History`:** The handler detects the existing section via `HISTORY_MARKER` and prepends the new note below the heading, above existing bullets. No duplicate headings.
- **Entry body contains a similar heading (e.g., `## Historical Context`):** `HISTORY_MARKER` requires `\n## History\n` exactly. `## Historical Context` does not match.
- **Body starts exactly with `## History\n` (no preceding newline):** `HISTORY_MARKER` starts with `\n`, so this would not match. Accepted limitation. In practice, `buildPage` always produces body content before any history section. A code comment documents this.
- **Empty `change_note` string:** Rejected by `.min(1)` on the Zod schema.
- **Negative eval question returns results (history pollution):** Scored as `abstentionAccuracy = 0.0`, which drags down `history_isolation_accuracy` and flags a regression.

## Performance Considerations

- `extractSearchableBody` is called once per document per BM25 scoring pass. The `indexOf` call is O(n) in body length but negligible compared to tokenization.
- No additional file reads. The history section is part of the existing file content already loaded into memory.
- Eval corpus generation time is unchanged (removing v2 pairs and adding history sections is roughly equivalent work).

## Accessibility

Not applicable -- changes are to an MCP tool API and a CLI eval harness with no user interface.

## Out of Scope

- Per-version file model (explicitly rejected in constraints)
- LLM-generated change notes or summaries
- Wikilink rewriting when entries are updated
- Title changes on update (same concept, same title, evolving body)
- Querying history specifically (e.g., "what changed in this entry last month")
- Displaying history differently in `lore_read` output (it is just markdown)

## Rabbit Holes

- **Parsing history sections with regex instead of simple string split:** The `## History` marker is a fixed string. Do not use a regex to find it or try to parse individual history entries. `body.indexOf(HISTORY_MARKER)` is sufficient and unambiguous. Use the exported `HISTORY_MARKER` constant everywhere.
- **Making `extractSearchableBody` recursive or configurable for other sections:** Only `## History` needs stripping. Do not build a generic "strip sections by heading" utility. Hardcode via the constant.
- **Versioning or diffing history entries:** Change notes are append-only text. Do not build a structured diff format, version numbers, or a way to revert to previous content. The `## History` section is a human-readable log, not a version control system.
- **Splitting the eval's knowledge_updates into two separate abilities:** Keep it as one ability with mixed positive/negative questions. Adding a new ability name would require changes to the baseline schema, CI workflow, and results table. Report sub-metrics within the existing ability instead.

## No-Gos

- Do not modify `extractBody` behavior -- it must continue returning the full body including `## History` for `lore_read` and `lore_query`
- Do not index history content in BM25 under any circumstances -- the entire point is that old vocabulary is invisible to search
- Do not break existing entries that have no `## History` section -- `extractSearchableBody` must return the full body unchanged when no marker is present
- Do not use `Math.random()` in the eval changes -- all randomness must use the seeded LCG

## Open Questions

No open questions.
