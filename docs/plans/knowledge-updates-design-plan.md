---
spec: docs/specs/knowledge-updates-design.md
---

# Write-Time Knowledge Update Consolidation Implementation Plan

**Goal:** Consolidate knowledge updates at write-time by appending timestamped change notes to a `## History` section, stripping that section from BM25 indexing, and redesigning the eval's knowledge_updates ability to test this real-world behavior.

**Architecture:** Three layers are modified: (1) `src/scoring.ts` gains a `HISTORY_MARKER` constant and `extractSearchableBody` function that strips the `## History` section from BM25 input; (2) `src/server.ts` gains a `change_note` parameter on `lore_write` that appends timestamped notes to the history section on updates; (3) the eval harness (`eval/generate/corpus.js`, `eval/generate/questions.js`, `eval/layers/integration.js`, `eval/run.js`, `eval/compare.js`) is redesigned to remove v2 version pairs and test history-aware retrieval with positive/negative question types.

---

### Task 1: Add HISTORY_MARKER and extractSearchableBody to scoring.ts

**Files:**
- Modify: `src/scoring.ts`

**Acceptance criteria:**
- [ ] `HISTORY_MARKER` is exported as `"\n## History\n"`
- [ ] `extractSearchableBody` is exported and returns body text before the history marker, trimmed
- [ ] `extractSearchableBody` returns the full body unchanged when no history marker is present
- [ ] `computeBM25Scores` uses `extractSearchableBody` instead of `extractBody` for the body text line
- [ ] A code comment documents the edge case where body starts exactly with `## History\n`

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npx tsc --noEmit`
- Expected: No TypeScript compilation errors

#### Steps

- [ ] Step 1: Add the exported constant after the existing `extractBody` function (around line 52):
  ```typescript
  export const HISTORY_MARKER = "\n## History\n";
  ```
- [ ] Step 2: Add the `extractSearchableBody` function immediately after `HISTORY_MARKER`:
  ```typescript
  /**
   * Returns the body text with the ## History section stripped for BM25 indexing.
   * Known limitation: if the body starts exactly with "## History\n" (no preceding
   * newline), HISTORY_MARKER will not match because it begins with "\n". In practice,
   * buildPage always places body content before the history section.
   */
  export function extractSearchableBody(content: string): string {
    const body = extractBody(content);
    const idx = body.indexOf(HISTORY_MARKER);
    if (idx === -1) return body;
    return body.slice(0, idx).trim();
  }
  ```
- [ ] Step 3: In `computeBM25Scores` (line 161), change:
  ```typescript
  const bodyText = doc.title + " " + extractBody(doc.content) + " " + searchKeys;
  ```
  to:
  ```typescript
  const bodyText = doc.title + " " + extractSearchableBody(doc.content) + " " + searchKeys;
  ```
- [ ] Step 4: Verify the build succeeds with `npx tsc --noEmit`
- [ ] Step 5: Commit

---

### Task 2: Add change_note parameter and history handling to lore_write in server.ts

**Files:**
- Modify: `src/server.ts`

**Acceptance criteria:**
- [ ] `lore_write` input schema includes an optional `change_note` parameter with `.min(1)` validation
- [ ] When `isUpdate` is true and `change_note` is falsy, the handler returns an `isError: true` response with message `"change_note is required when updating an existing entry (title already exists: '<title>')"`
- [ ] When `isUpdate` is false, `change_note` is silently ignored
- [ ] When `isUpdate` is true and `change_note` is provided, the handler splits the existing body on `HISTORY_MARKER`, replaces the current body with the caller-provided `body`, and prepends a new timestamped change note to the history section
- [ ] The new change note format is `- **YYYY-MM-DD**: <change_note text>`
- [ ] `HISTORY_MARKER` is imported from `./scoring.js`

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npx tsc --noEmit`
- Expected: No TypeScript compilation errors

#### Steps

- [ ] Step 1: Add `HISTORY_MARKER` to the import from `./scoring.js` (line 6-23):
  ```typescript
  import {
    computeBM25Scores,
    decomposeQuery,
    applyConfidenceAndRecency,
    EXPANSION_THRESHOLD,
    EXPANSION_DISCOUNT,
    tokenize,
    applyLinkBoost,
    buildInboundCounts,
    extractWikilinks,
    buildLookupMaps,
    parseFrontmatter,
    buildPage,
    extractBody,
    slugify,
    HISTORY_MARKER,
    type Frontmatter,
    type ScoredResult,
  } from "./scoring.js";
  ```
- [ ] Step 2: Add the `change_note` parameter to the `lore_write` input schema (after `search_keys`, around line 391):
  ```typescript
  change_note: z
    .string()
    .min(1)
    .optional()
    .describe("Required when updating an existing entry. Describes what changed and why."),
  ```
- [ ] Step 3: Add `change_note` to the handler's destructured parameters (line 394):
  ```typescript
  async ({ title, type, body, confidence, sources, domain, tags, derived_entries, source_url, source_file, search_keys, change_note }) => {
  ```
- [ ] Step 4: After the `isUpdate` check and before `filePath` assignment (after line 397), add the validation and history construction logic:
  ```typescript
  if (isUpdate && !change_note) {
    return {
      content: [
        {
          type: "text" as const,
          text: `change_note is required when updating an existing entry (title already exists: '${title}')`,
        },
      ],
      isError: true,
    };
  }
  ```
- [ ] Step 5: In the `isUpdate` branch (around line 402-406), after retrieving `existingContent` and before building frontmatter, add history section construction. Declare a `let finalBody = body;` variable before the `if (isUpdate)` block. Inside the isUpdate branch, after extracting `created`:
  ```typescript
  // Build history section
  const existingBody = extractBody(existingContent);
  const historyIdx = existingBody.indexOf(HISTORY_MARKER);
  const newLine = `- **${today()}**: ${change_note}`;

  if (historyIdx !== -1) {
    // Existing history: prepend new note after the heading
    const historyContent = existingBody.slice(historyIdx + HISTORY_MARKER.length);
    finalBody = body + HISTORY_MARKER + newLine + "\n" + historyContent;
  } else {
    // No existing history: append new section
    finalBody = body + "\n\n## History\n\n" + newLine;
  }
  ```
- [ ] Step 6: Change the `buildPage` call (line 429) to use `finalBody` instead of `body`:
  ```typescript
  const pageContent = buildPage(frontmatter, finalBody);
  ```
- [ ] Step 7: Verify the build succeeds with `npx tsc --noEmit`
- [ ] Step 8: Commit

---

### Task 3: Remove v2 version pairs and add history sections to eval corpus generator

**Files:**
- Modify: `eval/generate/corpus.js`

**Acceptance criteria:**
- [ ] The `v2Count` / `baseCount` split is removed; all `totalEntries` slots become base entries
- [ ] Phase 3 (v2 generation) is deleted entirely
- [ ] No `isV2` or `supersedes` fields appear in entry metadata or the manifest
- [ ] 10% of entries (deterministic via PRNG) have a `## History` section appended to their body with 2-3 change notes containing old vocabulary terms
- [ ] History terms are generated via `makeUniqueTerms` and do NOT appear in the entry's current body `uniqueTerms`
- [ ] The manifest entry gains an optional `historyTerms: string[]` field for entries with history
- [ ] All randomness uses the seeded LCG (no `Math.random()`)

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/generate/corpus.js').then(m => m.generateCorpus('small', '/tmp/lore-test-corpus').then(manifest => { const withHistory = Object.values(manifest).filter(e => e.historyTerms); console.log('Total entries:', Object.keys(manifest).length); console.log('With history:', withHistory.length); console.log('Sample historyTerms:', withHistory[0]?.historyTerms); const hasV2 = Object.values(manifest).some(e => e.supersedes); console.log('Has v2 entries:', hasV2); }))"`
- Expected: `Total entries: 50`, `With history: 5`, sample historyTerms is an array of 2-3 strings, `Has v2 entries: false`

#### Steps

- [ ] Step 1: Remove the `v2Count` and `baseCount` variables (lines 188-189). Replace with `const baseCount = totalEntries;`. Delete the comment about generating `floor(totalEntries * 0.9)` base entries.
- [ ] Step 2: In the type pool construction (lines 194-213), change `baseCount` references to `totalEntries` (they are now equivalent since `baseCount = totalEntries`).
- [ ] Step 3: Update the domain and confidence assignment loops (lines 216-225) to use `totalEntries` instead of `baseCount`.
- [ ] Step 4: Update the entry metadata loop (lines 245-283) to iterate `totalEntries` instead of `baseCount`. Remove the `isV2: false` and `supersedes: null` fields from the entry object.
- [ ] Step 5: Update the wikilink phase (lines 288-323) to use `totalEntries` instead of `baseCount` for adjacency, iteration bounds, and connectivity checks.
- [ ] Step 6: Delete Phase 3 entirely (lines 329-361) -- the v2 version pair generation block.
- [ ] Step 7: Add a new phase after body generation (after the body-building loop around line 408) to append history sections to 10% of entries:
  ```javascript
  // Phase: Append ## History sections to 10% of entries
  const historyCount = Math.floor(totalEntries * 0.1);
  for (let k = 0; k < historyCount; k++) {
    const entry = entries[k];
    const noteCount = rng.int(2, 3);
    const historyTerms = makeUniqueTerms(entry.domain, noteCount);
    const historyLines = ["", "", "## History", ""];
    for (let h = 0; h < noteCount; h++) {
      const dayOffset = rng.int(0, 180);
      const date = dateFromOffset(startMs, dayOffset);
      if (h === 0) {
        historyLines.push(`- **${date}**: Changed from ${historyTerms[h]} to current approach`);
      } else {
        historyLines.push(`- **${date}**: Originally described as ${historyTerms[h]} process`);
      }
    }
    entry.body += historyLines.join("\n");
    entry.historyTerms = historyTerms;
  }
  ```
- [ ] Step 8: In the manifest-building loop (around line 456), remove the `if (entry.supersedes)` block that adds `supersedes` to the manifest. Add `historyTerms` conditionally:
  ```javascript
  if (entry.historyTerms) {
    manifestEntry.historyTerms = entry.historyTerms;
  }
  ```
- [ ] Step 9: Verify the build succeeds and a test corpus generates correctly
- [ ] Step 10: Commit

---

### Task 4: Redesign knowledge_updates question generation

**Files:**
- Modify: `eval/generate/questions.js`

**Acceptance criteria:**
- [ ] The v2-based knowledge_updates question generation is removed entirely
- [ ] The `v2Titles`, `v2TitleSet`, `supersededBy` variables and filtering logic are removed
- [ ] Two sub-types of knowledge_updates questions are generated: positive (`questionType: "positive"`) and negative (`questionType: "negative"`)
- [ ] Positive questions use a `uniqueTerms` value from an entry with `historyTerms`, with `expected_titles: [title]`
- [ ] Negative questions use a `historyTerms` value as the query, with `expected_titles: []`
- [ ] Question count split: `ceil(count / 2)` positive, remainder negative (3 positive, 2 negative for small tier's 5 questions)
- [ ] All randomness uses the seeded LCG

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node -e "import('./eval/generate/corpus.js').then(cm => cm.generateCorpus('small', '/tmp/lore-test-corpus').then(manifest => import('./eval/generate/questions.js').then(qm => { const qs = qm.generateQuestions(manifest, 'small'); const ku = qs.filter(q => q.ability === 'knowledge_updates'); console.log('KU questions:', ku.length); const pos = ku.filter(q => q.questionType === 'positive'); const neg = ku.filter(q => q.questionType === 'negative'); console.log('Positive:', pos.length, 'Negative:', neg.length); console.log('Positive expected_titles non-empty:', pos.every(q => q.expected_titles.length > 0)); console.log('Negative expected_titles empty:', neg.every(q => q.expected_titles.length === 0)); })))"`
- Expected: `KU questions: 5`, `Positive: 3`, `Negative: 2`, both boolean checks are `true`

#### Steps

- [ ] Step 1: Remove the v2/base separation variables at the top of `generateQuestions` (lines 55-67). Remove `v2Titles`, `baseTitles`, `v2TitleSet`, `supersededBy`. Replace with:
  ```javascript
  const allTitles = Object.keys(manifest);
  const titlesWithHistory = allTitles.filter(t => manifest[t].historyTerms && manifest[t].historyTerms.length > 0);
  const baseTitles = allTitles;
  ```
- [ ] Step 2: Update Ability 1 (information_extraction, line 73) to use `baseTitles` (which is now `allTitles`, so candidates come from all entries -- no v2 filtering needed).
- [ ] Step 3: Replace the entire Ability 3 (knowledge_updates) block (lines 127-153) with:
  ```javascript
  // Ability 3: knowledge_updates
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
      const candidateIdx = i < candidates.length ? i : i % candidates.length;
      const title = candidates[candidateIdx];
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
  ```
- [ ] Step 4: Verify the question generator produces the correct counts and structure
- [ ] Step 5: Commit

---

### Task 5: Update integration layer metric routing for negative knowledge_updates questions

**Files:**
- Modify: `eval/layers/integration.js`

**Acceptance criteria:**
- [ ] The metric routing condition checks `expected_titles.length === 0` instead of `ability === "abstention"`
- [ ] Negative knowledge_updates questions (empty `expected_titles`) are routed to `abstentionAccuracy`
- [ ] Existing abstention questions continue to work identically (they also have empty `expected_titles`)

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npx tsc --noEmit`
- Expected: No TypeScript compilation errors (server.ts is the only TS file, but ensures build works)

#### Steps

- [ ] Step 1: In `runIntegrationLayer` (line 225), change:
  ```javascript
  if (question.ability === "abstention") {
  ```
  to:
  ```javascript
  if (question.expected_titles.length === 0) {
  ```
- [ ] Step 2: Verify the change is correct by tracing through the logic: abstention questions always have `expected_titles: []`, and negative knowledge_updates questions also have `expected_titles: []`. Positive knowledge_updates questions have non-empty `expected_titles` and fall through to the `else` branch for recall/ndcg scoring.
- [ ] Step 3: Commit

---

### Task 6: Update aggregation, thresholds, and compare script for knowledge_updates

**Files:**
- Modify: `eval/run.js`
- Modify: `eval/compare.js`

**Acceptance criteria:**
- [ ] `aggregateIntegration` has a dedicated `knowledge_updates` code path that splits positive/negative results and computes `recall_at_5` and `history_isolation_accuracy` as separate metrics
- [ ] `checkThresholds` has a dedicated `knowledge_updates` branch that checks both `recall_at_5` and `history_isolation_accuracy` against the threshold
- [ ] `eval/compare.js` includes `"history_isolation_accuracy"` in the `KEEP_METRICS` array
- [ ] `eval/compare.js` `primaryMetric` function returns `"recall_at_5"` for `knowledge_updates`
- [ ] `metricDisplayName` in `eval/compare.js` maps `"history_isolation_accuracy"` to a readable name

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && npm run build && node eval/run.js --layer integration --tier small`
- Expected: Script completes without errors; knowledge_updates row appears in the results table with recall and NDCG values

#### Steps

- [ ] Step 1: In `eval/run.js`, `aggregateIntegration` function (line 116), add a new branch after the `if (ability === "abstention")` block and before the `else` block:
  ```javascript
  } else if (ability === "knowledge_updates") {
    const positive = results.filter(r => r.expected_titles.length > 0);
    const negative = results.filter(r => r.expected_titles.length === 0);

    let sumR1 = 0, sumR5 = 0, sumR10 = 0, sumN5 = 0, sumN10 = 0;
    for (const r of positive) {
      sumR1  += recallAtK(r.retrieved_titles, r.expected_titles, 1);
      sumR5  += recallAtK(r.retrieved_titles, r.expected_titles, 5);
      sumR10 += recallAtK(r.retrieved_titles, r.expected_titles, 10);
      sumN5  += ndcgAtK(r.retrieved_titles, r.expected_titles, 5);
      sumN10 += ndcgAtK(r.retrieved_titles, r.expected_titles, 10);
    }
    const pn = positive.length || 1;

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
  ```
- [ ] Step 2: In `eval/run.js`, `checkThresholds` function (line 288-296), add a dedicated `knowledge_updates` branch. Change:
  ```javascript
  } else {
    if (m.recall_at_5 < threshold) {
  ```
  to:
  ```javascript
  } else if (ability === "knowledge_updates") {
    if (m.recall_at_5 < threshold) {
      failures.push(
        `Knowledge Updates recall@5 ${fmt2(m.recall_at_5)} < threshold ${fmt2(threshold)}`
      );
    }
    if (m.history_isolation_accuracy < threshold) {
      failures.push(
        `Knowledge Updates history_isolation_accuracy ${fmt2(m.history_isolation_accuracy)} < threshold ${fmt2(threshold)}`
      );
    }
  } else {
    if (m.recall_at_5 < threshold) {
  ```
- [ ] Step 3: In `eval/run.js`, `writeReport` function (around line 345), add `history_isolation_accuracy` to the knowledge_updates ability's report output. In the `else` branch that writes recall/ndcg metrics, add a conditional check:
  ```javascript
  if (m.history_isolation_accuracy !== undefined) {
    abilities[ability].history_isolation_accuracy = m.history_isolation_accuracy;
  }
  ```
- [ ] Step 4: In `eval/compare.js`, add `"history_isolation_accuracy"` to the `KEEP_METRICS` array (line 32-38):
  ```javascript
  const KEEP_METRICS = [
    "recall_at_1",
    "recall_at_5",
    "recall_at_10",
    "ndcg_at_5",
    "ndcg_at_10",
    "abstention_accuracy",
    "history_isolation_accuracy",
  ];
  ```
- [ ] Step 5: In `eval/compare.js`, update the `primaryMetric` function (line 42-44) to explicitly handle `knowledge_updates`:
  ```javascript
  function primaryMetric(ability) {
    if (ability === "abstention") return "abstention_accuracy";
    if (ability === "knowledge_updates") return "recall_at_5";
    return "recall_at_5";
  }
  ```
- [ ] Step 6: In `eval/compare.js`, add `"history_isolation_accuracy"` to the `metricDisplayName` map (around line 298):
  ```javascript
  history_isolation_accuracy: "History Isolation",
  ```
- [ ] Step 7: Build and run the eval to verify the full pipeline works end-to-end
- [ ] Step 8: Commit

---

### Task 7: Update baseline and verify end-to-end

**Files:**
- Modify: `eval/baseline.json`

**Acceptance criteria:**
- [ ] `node eval/run.js` completes without errors
- [ ] The knowledge_updates row in the results table shows improved recall scores compared to the old baseline (0.50)
- [ ] The JSON report includes `history_isolation_accuracy` for the knowledge_updates ability
- [ ] `eval/baseline.json` is updated with the new eval results
- [ ] `node eval/compare.js --baseline eval/baseline.json --current <new-report>` exits 0

**Verification:**
- Run: `cd /Users/bragur/Developer/lore && node eval/run.js --tier small`
- Expected: Script completes successfully, knowledge_updates recall@5 is significantly higher than 0.50, no threshold failures

#### Steps

- [ ] Step 1: Run the full eval suite: `node eval/run.js --tier small`
- [ ] Step 2: Inspect the generated report JSON to verify: (a) knowledge_updates has `recall_at_5`, `history_isolation_accuracy`, `recall_at_1`, `recall_at_10`, `ndcg_at_5`, `ndcg_at_10`; (b) `history_isolation_accuracy` is 1.0 (history terms do not pollute search); (c) `recall_at_5` for positive questions is 1.0 or near 1.0
- [ ] Step 3: Update `eval/baseline.json` with the new ability scores from the report. The structure for `knowledge_updates` changes from the old recall-only format to include `history_isolation_accuracy`. Remove `question_count` from the baseline (it is not present for other abilities in the current baseline).
- [ ] Step 4: Run the compare script against the new baseline to verify it exits 0: `node eval/compare.js --baseline eval/baseline.json --current eval/results/<latest-report>.json`
- [ ] Step 5: Commit
