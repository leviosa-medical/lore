## Summary

The plan is a faithful, near-mechanical decomposition of the spec across all three layers (scoring, server, eval). Every major requirement is addressed with correct task ordering and precise code-level steps. A handful of minor gaps exist around explicit verification of edge cases and one subtle omission in the history section date handling in the corpus generator, but no critical or major issues were found.

## Spec Compliance Checklist

### Named Constant (Spec: Named Constant)
- [x] Requirement: `HISTORY_MARKER` exported as `"\n## History\n"` from `src/scoring.ts` -- covered by Task 1 Step 1
- [x] Requirement: All code that detects or splits on the history heading must use this constant -- covered by Task 1 (scoring), Task 2 (server imports it)

### Data Model (Spec: Data Model Changes)
- [x] Requirement: No new files or frontmatter fields -- respected; plan modifies only existing files
- [x] Requirement: `## History` section format with bold ISO 8601 date prefix bullets -- covered by Task 2 Step 5
- [x] Requirement: Newest entries prepended at top (reverse chronological) -- covered by Task 2 Step 5 (prepend new line after heading, before existing bullets)

### Service Layer: lore_write schema (Spec: Service Layer)
- [x] Requirement: Optional `change_note` parameter with `.min(1)` and `.optional()` -- covered by Task 2 Step 2
- [x] Requirement: `.describe("Required when updating an existing entry. Describes what changed and why.")` -- covered by Task 2 Step 2
- [x] Requirement: If `isUpdate` true and `change_note` falsy, return `isError: true` with specified message -- covered by Task 2 Step 4
- [x] Requirement: If `isUpdate` false, ignore `change_note` silently -- covered by Task 2 acceptance criteria (bullet 3)
- [x] Requirement: If `isUpdate` true and `change_note` provided, split existing body on `HISTORY_MARKER`, replace current body, prepend new note -- covered by Task 2 Step 5
- [x] Requirement: Use existing `today()` helper for date -- covered by Task 2 Step 5 (uses `today()`)
- [x] Requirement: Change note line format `- **${today()}**: ${change_note}` -- covered by Task 2 Step 5
- [x] Requirement: If history block exists, prepend new line after heading before existing bullets -- covered by Task 2 Step 5
- [x] Requirement: If no history block, append `\n\n## History\n\n${newLine}` -- covered by Task 2 Step 5
- [x] Requirement: Pass combined body to `buildPage` -- covered by Task 2 Step 6

### Service Layer: extractSearchableBody (Spec: New function)
- [x] Requirement: Exported function in `src/scoring.ts` -- covered by Task 1 Step 2
- [x] Requirement: Calls `extractBody`, then splits on `HISTORY_MARKER` via `indexOf` -- covered by Task 1 Step 2
- [x] Requirement: Returns `body.slice(0, idx).trim()` when marker found -- covered by Task 1 Step 2
- [x] Requirement: Returns full body when no marker present -- covered by Task 1 Step 2
- [x] Requirement: Code comment documenting the `## History\n` edge case (no preceding newline) -- covered by Task 1 Step 2

### BM25 Indexing Change (Spec: BM25 indexing change)
- [x] Requirement: Replace `extractBody(doc.content)` with `extractSearchableBody(doc.content)` in `computeBM25Scores` -- covered by Task 1 Step 3

### View Layer (Spec: View Layer)
- [x] Requirement: No UI changes; `lore_read` and `lore_query` return full content including history -- respected; plan does not modify these

### Eval: Corpus Generator (Spec: Eval Redesign - Corpus)
- [x] Requirement: Remove v2 version-pair system entirely (`v2Count`, `baseCount` split, Phase 3, `isV2`/`supersedes`) -- covered by Task 3 Steps 1-6
- [x] Requirement: All `totalEntries` slots become base entries -- covered by Task 3 Step 1
- [x] Requirement: 10% of entries get `## History` section (deterministic via PRNG) -- covered by Task 3 Step 7
- [x] Requirement: `Math.floor(totalEntries * 0.1)` entries selected deterministically -- covered by Task 3 Step 7
- [x] Requirement: 2-3 unique compound terms from same domain vocabulary via `makeUniqueTerms` -- covered by Task 3 Step 7
- [x] Requirement: History terms do NOT appear in entry's current body terms -- covered by Task 3 acceptance criteria (bullet 5)
- [x] Requirement: Timestamped bullets in history section -- covered by Task 3 Step 7
- [x] Requirement: Record `historyTerms: string[]` in manifest -- covered by Task 3 Step 8
- [x] Requirement: `supersedes` field removed from manifest -- covered by Task 3 Step 8

### Eval: Question Generator (Spec: Eval Redesign - Questions)
- [x] Requirement: Replace knowledge_updates question generation entirely -- covered by Task 4 Steps 1-3
- [x] Requirement: Positive questions (`questionType: "positive"`) use `uniqueTerms` with `expected_titles: [title]` -- covered by Task 4 Step 3
- [x] Requirement: Negative questions (`questionType: "negative"`) use `historyTerms` with `expected_titles: []` -- covered by Task 4 Step 3
- [x] Requirement: `ceil(count / 2)` positive, remainder negative (3 positive, 2 negative for small tier) -- covered by Task 4 Step 3
- [x] Requirement: All randomness uses seeded LCG -- covered by Task 4 acceptance criteria

### Eval: Integration Layer (Spec: Eval Redesign - Integration)
- [x] Requirement: Change metric routing from `ability === "abstention"` to `expected_titles.length === 0` -- covered by Task 5 Step 1
- [x] Requirement: Negative knowledge_updates routed to `abstentionAccuracy` -- covered by Task 5 acceptance criteria
- [x] Requirement: Existing abstention questions continue working -- covered by Task 5 Step 2

### Eval: Aggregation (Spec: Eval Redesign - Aggregation)
- [x] Requirement: Dedicated `knowledge_updates` code path in `aggregateIntegration` -- covered by Task 6 Step 1
- [x] Requirement: Split positive/negative by `expected_titles` length -- covered by Task 6 Step 1
- [x] Requirement: Compute `recall_at_5` from positive results -- covered by Task 6 Step 1
- [x] Requirement: Compute `history_isolation_accuracy` from negative results -- covered by Task 6 Step 1
- [x] Requirement: Full metrics object with recall_at_1/5/10, ndcg_at_5/10, history_isolation_accuracy, question_count, latency stats -- covered by Task 6 Step 1

### Eval: Threshold Check (Spec: Eval Redesign - Threshold)
- [x] Requirement: Dedicated `knowledge_updates` branch checking both `recall_at_5` and `history_isolation_accuracy` against threshold -- covered by Task 6 Step 2
- [x] Requirement: Failure messages match spec format -- covered by Task 6 Step 2

### Eval: Compare Script (Spec: Eval Redesign - Compare)
- [x] Requirement: `"history_isolation_accuracy"` added to `KEEP_METRICS` -- covered by Task 6 Step 4
- [x] Requirement: `primaryMetric` returns `"recall_at_5"` for `knowledge_updates` -- covered by Task 6 Step 5

### Eval: Results Table (Spec: Eval Redesign - Results Table)
- [x] Requirement: `knowledge_updates` row falls through to existing `else` branch for recall/NDCG columns -- covered implicitly; plan does not modify `printTable` for knowledge_updates, so it falls through

### Eval: Baseline (Spec: Eval Redesign - Baseline)
- [x] Requirement: Baseline schema includes `recall_at_1`, `recall_at_5`, `recall_at_10`, `ndcg_at_5`, `ndcg_at_10`, `history_isolation_accuracy` -- covered by Task 7 Step 3
- [x] Requirement: Re-run eval and commit updated baseline post-implementation -- covered by Task 7 Steps 1-5

### Edge Cases (Spec: Edge Cases & Error Handling)
- [x] Edge case: Missing `change_note` on update returns `isError: true` with specified message -- covered by Task 2 Step 4
- [x] Edge case: `change_note` provided on new entry is silently ignored -- covered by Task 2 acceptance criteria
- [x] Edge case: Entry body already contains `## History` -- prepend new note, no duplicate headings -- covered by Task 2 Step 5
- [x] Edge case: Similar heading (`## Historical Context`) does not match `HISTORY_MARKER` -- implicitly covered by using exact `HISTORY_MARKER` constant
- [x] Edge case: Body starts exactly with `## History\n` (no preceding newline) -- accepted limitation, documented in code comment -- covered by Task 1 Step 2
- [x] Edge case: Empty `change_note` string rejected by `.min(1)` -- covered by Task 2 Step 2
- [x] Edge case: Negative eval question returns results (history pollution) scored as abstentionAccuracy = 0.0 -- covered by Task 5 routing and Task 6 aggregation

### No-Gos (Spec: No-Gos)
- [x] No-Go: Do not modify `extractBody` behavior -- respected; plan does not touch `extractBody`
- [x] No-Go: Do not index history content in BM25 -- respected; Task 1 uses `extractSearchableBody`
- [x] No-Go: Do not break existing entries with no `## History` section -- respected; `extractSearchableBody` returns full body when no marker present (Task 1)
- [x] No-Go: Do not use `Math.random()` in eval changes -- respected; Task 3 and Task 4 acceptance criteria enforce seeded LCG

### Rabbit Holes (Spec: Rabbit Holes)
- [x] Rabbit Hole: No regex for parsing history sections -- plan uses `indexOf(HISTORY_MARKER)` throughout
- [x] Rabbit Hole: No generic "strip sections by heading" utility -- plan hardcodes via constant
- [x] Rabbit Hole: No versioning or diffing of history entries -- plan treats history as append-only text
- [x] Rabbit Hole: No splitting knowledge_updates into two separate abilities -- plan keeps one ability with mixed questions and sub-metrics

### Out of Scope (Spec: Out of Scope)
- [x] Out of Scope: Plan does not introduce per-version file model
- [x] Out of Scope: Plan does not add LLM-generated change notes
- [x] Out of Scope: Plan does not rewrite wikilinks on update
- [x] Out of Scope: Plan does not handle title changes
- [x] Out of Scope: Plan does not add history-specific querying
- [x] Out of Scope: Plan does not change `lore_read` display of history

### Performance (Spec: Performance Considerations)
- [x] Requirement: `extractSearchableBody` called once per doc per scoring pass -- implicit in Task 1 Step 3 (replaces `extractBody` at the same call site)

## Score: 92/100

### Category Scores
| Category | Weight | Score |
|----------|--------|-------|
| Coverage | 40% | 94 |
| Mutation Resistance | 30% | 93 |
| Invention Control | 20% | 92 |
| Recommendations Quality | 10% | 85 |

## Verdict: FAITHFUL

## Strengths

- The plan is an exceptionally close decomposition of the spec. Nearly every code snippet from the spec appears verbatim in the plan tasks, preserving exact function signatures, error messages, and constant values.
- Task ordering is correct: scoring changes first (Task 1), then server changes that import from scoring (Task 2), then eval corpus (Task 3), questions (Task 4), integration (Task 5), aggregation (Task 6), and baseline (Task 7). This respects dependency order.
- Verification commands are appropriate for each task -- TypeScript compilation checks for Tasks 1 and 2, and runtime corpus/question generation checks for Tasks 3 and 4.
- All four Rabbit Holes are respected: no regex parsing, no generic section stripping, no version diffing, no ability splitting.
- All four No-Gos are explicitly preserved in the plan's acceptance criteria.
- The plan correctly imports `HISTORY_MARKER` from the scoring module rather than redefining it, honoring the spec's "use this constant everywhere" directive.

## Issues

### Minor: History section date format in corpus generator differs from spec example

**Failure mode:** Mutation
**Spec reference:** The corpus generator spec says "timestamped bullets" and shows the format `- **2025-02-10**: Changed from old-term-1 to current approach`. The spec also says history terms should be generated using `makeUniqueTerms` and dates constructed from domain vocabulary.
**Plan reference:** Task 3 Step 7 uses `dateFromOffset(startMs, dayOffset)` to generate dates, which is a reasonable implementation choice, but the `rng.int(0, 180)` range is not specified in the spec. The spec does not prescribe a date range.
**Description:** The plan invents a specific date range (0-180 day offset) for history entry timestamps. This is a minor infrastructure decision not specified in the spec, but it is reasonable and does not alter behavior since dates in the history section are display-only text.
**Suggestion:** No change needed. This is an acceptable implementation detail. Optionally, add a brief comment noting the date range is an implementation choice.

### Minor: Corpus generator picks first N entries for history rather than a distributed selection

**Failure mode:** Mutation
**Spec reference:** The spec says "Pick `Math.floor(totalEntries * 0.1)` entries deterministically" -- implying deterministic selection, but not necessarily the first N.
**Plan reference:** Task 3 Step 7 iterates `for (let k = 0; k < historyCount; k++)` starting from `entries[0]`, always selecting the first 10% of entries.
**Description:** The plan selects the first N entries for history sections rather than using the PRNG to select a distributed subset. While deterministic, this concentrates history entries at the start of the array. The spec says "deterministic via PRNG" in the acceptance criteria. This is a very minor deviation since corpus ordering is already randomized by the PRNG, but using the PRNG for selection would be more faithful to the spec's language.
**Suggestion:** Consider using the PRNG to shuffle or sample the entry indices for history selection rather than always taking the first N. This would be more consistent with the spec's "deterministic via PRNG" language.

### Minor: metricDisplayName addition is plan-only detail

**Failure mode:** Invention
**Spec reference:** The spec does not mention a `metricDisplayName` map or its contents.
**Plan reference:** Task 6 Step 6 adds `history_isolation_accuracy: "History Isolation"` to a `metricDisplayName` map in `eval/compare.js`.
**Description:** The plan adds a display name mapping for the new metric. This is an infrastructure/polish detail necessary for the compare script to display results nicely. It is not spec-authorized but is a reasonable extension.
**Suggestion:** No change needed. This is acceptable infrastructure work to support the spec-mandated `KEEP_METRICS` addition.

### Minor: writeReport function addition not in spec

**Failure mode:** Invention
**Spec reference:** The spec does not mention changes to a `writeReport` function.
**Plan reference:** Task 6 Step 3 adds `history_isolation_accuracy` to the `writeReport` function's output for the knowledge_updates ability.
**Description:** The plan adds logic to ensure `history_isolation_accuracy` appears in the JSON report output. This is necessary infrastructure -- without it, the metric would be computed but not written to the report file, making the compare script and baseline checks non-functional. This is an implicit requirement of the spec's baseline schema.
**Suggestion:** No change needed. This is a necessary consequence of the spec's requirement that the baseline schema includes `history_isolation_accuracy`.

### Minor: Missing explicit test for `## Historical Context` non-matching edge case

**Failure mode:** Coverage Gap
**Spec reference:** "Entry body contains a similar heading (e.g., `## Historical Context`): `HISTORY_MARKER` requires `\n## History\n` exactly. `## Historical Context` does not match."
**Plan reference:** Not explicitly tested in any verification step.
**Description:** While the plan's use of `HISTORY_MARKER` via `indexOf` inherently handles this edge case correctly, there is no explicit verification step that confirms similar-but-different headings are not matched. The spec calls this out as a specific edge case.
**Suggestion:** Consider adding a brief verification note in Task 1 or Task 2 that confirms `## Historical Context` does not trigger the history splitting logic, either as a manual check or a comment in acceptance criteria.

## Recommendations

- The plan's verification commands for Tasks 3 and 4 are long one-liners that are difficult to read and error-prone to type. Consider breaking them into small verification scripts or at minimum documenting them as multi-line commands in the steps.
- Task 7's acceptance criteria mention that `history_isolation_accuracy` should be 1.0, which is a strong expectation. If the corpus generator's history terms happen to overlap with terms in other entries (not the same entry, but a different one), abstention accuracy could be less than 1.0. The plan should note this possibility and accept near-1.0 scores.
- The plan could benefit from a brief "smoke test" step after Task 2 that manually tests the `lore_write` update flow (write an entry, then update it with a change_note, then read it back) to verify the history section is correctly constructed before moving to eval changes. This would catch server-layer bugs before the eval redesign work begins.
