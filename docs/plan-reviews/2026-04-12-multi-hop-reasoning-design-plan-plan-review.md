## Summary

The plan is a thorough and largely faithful decomposition of the spec. All major requirements, the two-phase structure, the four sub-types, the PPR expansion, shared-attribute traversal, metadata pre-filtering, baseline resets, and fallback strategy are represented. A few minor coverage gaps exist around specific edge cases and one subtle mutation in the shared-attribute matching criteria, but nothing critically misrepresents the spec's intent.

## Spec Compliance Checklist

### Problem Statement & Overall Structure
- [x] Requirement: Two-phase improvement delivered in one PR -- covered by plan's overall structure (Tasks 1-4 = Phase 1, Tasks 5-9 = Phase 2)
- [x] Requirement: Phase 1 expands multi-hop eval from 8 to 20 questions in small tier across four sub-types -- covered by Task 2
- [x] Requirement: Phase 2 replaces fixed top-3x3 expansion with PPR, adds shared-attribute traversal, adds metadata pre-filtering -- covered by Tasks 5-8

### Success Criteria
- [x] Requirement: Phase 1 baseline multi_hop recall@5 expected to drop to ~0.45-0.50 -- referenced implicitly in Task 4 (baseline reset captures whatever the new scores are)
- [x] Requirement: Phase 2 target multi-hop recall@5 >= 0.60 -- covered by Task 9 acceptance criteria
- [x] Requirement: All four sub-types have test coverage -- covered by Task 2 (5 questions per sub-type)
- [x] Requirement: No other ability regresses beyond 0.05 tolerance -- covered by Task 9 acceptance criteria
- [x] Requirement: Fallback if Phase 2 recall@5 < 0.60 after tuning: ship Phase 1 only, split Phase 2 into follow-up -- covered by Task 9 Step 3

### User Stories
- [x] User story: Forward 1-hop -- covered by Task 2 Step 3 (forward_1hop sub-type)
- [x] User story: Reverse 1-hop -- covered by Task 2 Step 4 (reverse_1hop sub-type)
- [x] User story: 2-hop chains -- covered by Task 2 Step 5 (two_hop_chain sub-type)
- [x] User story: Shared-attribute -- covered by Task 2 Step 6 (shared_attribute sub-type)
- [x] User story: Per-sub-type recall breakdowns in eval report -- covered by Task 3

### Phase 1: Corpus Changes
- [x] Requirement: `findTwoHopChains(entries, adjacency, maxChains)` function -- covered by Task 1 Step 1
- [x] Requirement: Function returns `{a, b, c}` index triples where A->B->C and A does not directly link C -- covered by Task 1 Step 1
- [x] Requirement: `maxChains` default 100 -- covered by Task 1 Step 1
- [x] Requirement: `buildSharedAttributeGroups(entries, adjacency)` function -- covered by Task 1 Step 2
- [x] Requirement: Groups by "domain:type" key to arrays of titles -- covered by Task 1 Step 2
- [x] Requirement: Filtered to groups where at least 2 members have no direct wikilink between them -- covered by Task 1 Step 2
- [x] Requirement: Manifest has `__twoHopChains` and `__sharedAttributeGroups` top-level fields -- covered by Task 1 Step 4
- [x] Requirement: Placed after BFS connectivity check and before Phase 3 (body text) -- covered by Task 1 Step 3

### Phase 1: Question Generator Changes
- [x] Requirement: TIER_COUNTS updated: small=20, medium=32, large=60 multi-hop questions -- covered by Task 2 Step 1
- [x] Requirement: Each question has `subType` field -- covered by Task 2 acceptance criteria
- [x] Requirement: Small tier 5 per sub-type -- covered by Task 2 acceptance criteria
- [x] Requirement: Forward 1-hop: 3/5 natural-language queries, 2/5 synthetic -- covered by Task 2 Step 3
- [x] Requirement: Reverse 1-hop: high-inbound target entry, expects target + reverse neighbors -- covered by Task 2 Step 4
- [x] Requirement: Reverse 1-hop grades: target=1.0, reverse neighbors=0.5 -- covered by Task 2 Step 4
- [x] Requirement: 2-hop chain: uses `manifest.__twoHopChains`, expects [A, B, C] with grades A=1.0, B=0.7, C=0.5 -- covered by Task 2 Step 5
- [x] Requirement: Shared-attribute: uses `manifest.__sharedAttributeGroups`, query "domain type entries", all members grade=1.0 -- covered by Task 2 Step 6
- [x] Requirement: If fewer than 5 chains, reallocate slots to forward 1-hop -- covered by Task 2 Step 5

### Phase 1: Eval Reporting Changes
- [x] Requirement: Sub-type breakdown in `aggregateIntegration` for multi_hop -- covered by Task 3 Step 2
- [x] Requirement: JSON report includes `abilities.multi_hop.sub_types` -- covered by Task 3 Step 3
- [x] Requirement: CI comparison (`eval/compare.js`) does NOT check sub-types -- covered by Task 3 acceptance criteria
- [x] Requirement: `printTable` shows sub-type breakdown when `--verbose` flag is passed -- covered by Task 3 Step 4

### Phase 1: Baseline Reset
- [x] Requirement: Run eval after Phase 1, commit new baseline.json -- covered by Task 4

### Phase 2 Change 1: Seeded-Walk Graph Expansion
- [x] Requirement: `buildWikilinkGraph` function in scoring.ts -- covered by Task 5 Step 2
- [x] Requirement: Bidirectional adjacency list (A->B adds both A->B and B->A) -- covered by Task 5 Step 2
- [x] Requirement: `GraphEdge` interface with source/target string fields -- covered by Task 5 Step 1
- [x] Requirement: `seededPageRank` function with alpha, iterations, minScore params -- covered by Task 5 Step 4
- [x] Requirement: PPR formula: `score[node] = (1-alpha) * seed[node] + alpha * sum(score[neighbor]/degree[neighbor])` -- covered by Task 5 Step 4
- [x] Requirement: Constants PPR_ALPHA=0.85, PPR_ITERATIONS=20, PPR_MIN_SCORE=0.001, MAX_EXPANSION=5 -- covered by Task 5 Step 3
- [x] Requirement: Integration replaces Step 5 (lines 711-780) of lore_query -- covered by Task 6 Step 2
- [x] Requirement: Seeds are qualifying results (score/maxScore >= EXPANSION_THRESHOLD), weighted by BM25 scores -- covered by Task 6 Step 2
- [x] Requirement: Top MAX_EXPANSION (5) non-seed nodes, excluding all paths already in BM25 results -- covered by Task 6 Step 2
- [x] Requirement: Score = pprScore * maxBM25Score * EXPANSION_DISCOUNT -- covered by Task 6 Step 2

### Phase 2 Change 2: Shared-Attribute Traversal
- [x] Requirement: `findSharedAttributeNeighbors` function in scoring.ts -- covered by Task 7 Step 2
- [x] Requirement: Takes seedPaths, documents with frontmatter, maxResults (default 3) -- covered by Task 7 Step 2
- [x] Requirement: Constants SHARED_ATTR_DISCOUNT=0.7, SHARED_ATTR_MAX=3 -- covered by Task 7 Step 1
- [x] Requirement: Called after PPR expansion -- covered by Task 7 Step 3
- [x] Requirement: Score = SHARED_ATTR_DISCOUNT * parentScore -- covered by Task 7 Step 3
- [ ] Requirement: Matching criteria "domain + at least 1 tag (or 2+ tags if no domain match)" -- MUTATION in Task 7 Step 2 (see Issues)
- [x] Requirement: Exclude documents already in results or PPR expansion -- covered by Task 7 Step 2 (via `excludePaths` param)
- [x] Requirement: Prioritized by number of shared attributes -- covered by Task 7 Step 2

### Phase 2 Change 3: Metadata-Driven Pre-Filtering
- [x] Requirement: `extractQueryMetadataHints` function in scoring.ts -- covered by Task 8 Step 2
- [x] Requirement: Returns `{ domains: string[], types: string[] }` -- covered by Task 8 Step 2
- [x] Requirement: METADATA_HINT_BOOST=1.5 constant -- covered by Task 8 Step 1
- [x] Requirement: METADATA_HINT_STOPLIST = ['concept', 'entry', 'note', 'guide', 'item', 'record'] -- covered by Task 8 Step 1
- [x] Requirement: Values with length <= 2 excluded -- covered by Task 8 Step 2
- [x] Requirement: 1.5x multiplier on BM25 score for matching documents -- covered by Task 8 Step 3
- [x] Requirement: Applied after BM25 scoring but before link boost and confidence/recency -- covered by Task 8 Step 4
- [x] Requirement: Soft boost, not hard filter -- implied in Task 8 approach (multiplier, not exclusion)

### Implementation Order
- [x] Requirement: Phase 1a corpus, 1b questions, 1c reporting, 1d baseline -- covered by Tasks 1-4
- [x] Requirement: Phase 2a graph+PPR, 2b shared-attr, 2c metadata hints, 2d eval+tune -- covered by Tasks 5-9
- [x] Requirement: After each Phase 2 sub-step, run eval and compare -- covered by verification sections in Tasks 6-9

### Edge Cases
- [x] Edge case: Disconnected graph components -- PPR only expands within component, shared-attr catches cross-component -- covered by Task 5 Step 7 unit test (disconnected component test), Task 7 (shared-attribute traversal)
- [x] Edge case: Empty wikilink graph -- falls back to BM25-only -- covered by Task 5 Step 7 (empty graph test returns empty map)
- [ ] Edge case: Self-loops in graph (document linking to itself) -- MISSING explicit handling or test in plan
- [x] Edge case: Large corpus (500+ entries) -- performance within budget -- addressed implicitly by algorithm choice (PPR with fixed iterations)
- [x] Edge case: Query with no metadata hints -- no boost applied -- covered by Task 8 Step 5 (Test 4: "no match here" returns empty)
- [x] Edge case: Shared-attribute expansion finds too many candidates -- capped at SHARED_ATTR_MAX=3 -- covered by Task 7 Step 2 (maxResults parameter)
- [ ] Edge case: Shared-attribute tie-breaking by BM25 score -- spec says "prioritized by attribute overlap count, then by BM25 score of the candidate if tied" -- plan says "sort by path alphabetically for determinism" (MUTATION)
- [x] Edge case: 2-hop chain questions with no chains in corpus -- skip and reallocate to forward_1hop -- covered by Task 2 Step 5
- [x] Edge case: Phase 1 shared-attribute questions scoring poorly -- expected, baseline reflects this -- acknowledged in Task 4

### No-Gos
- [x] No-Go: Do not add external dependencies to package.json -- respected (no new deps in plan)
- [x] No-Go: Do not regress any existing ability beyond 0.05 tolerance -- covered by Task 9 acceptance criteria and verification
- [x] No-Go: Do not change MCP tool output formats -- respected (plan does not modify output format)
- [x] No-Go: Do not modify lore_search, lore_read, or lore_list behavior -- respected (plan only touches lore_query)
- [x] No-Go: Do not split into multiple PRs -- one PR, one baseline reset -- covered by plan structure (single plan, one final baseline)

### Rabbit Holes
- [x] Rabbit Hole: Do not implement convergence detection or adaptive iteration counts -- plan uses fixed 20 iterations (Task 5)
- [x] Rabbit Hole: Do not maintain separate forward/reverse adjacency lists -- plan builds single bidirectional adjacency map (Task 5 Step 2)
- [x] Rabbit Hole: Do not build Jaccard/cosine similarity for attributes -- plan uses simple set intersection (Task 7 Step 2)
- [x] Rabbit Hole: Do not restructure the entire lore_query handler -- plan replaces only the expansion step (Task 6 Step 2)

### Out of Scope
- [x] Out of Scope: No vector/embedding search -- respected
- [x] Out of Scope: No global PageRank precomputation -- respected (PPR is query-specific)
- [x] Out of Scope: No persisted graph cache -- respected
- [x] Out of Scope: No changes to lore_search -- respected
- [x] Out of Scope: No eval sub-type regression detection in CI -- respected (Task 3: compare.js NOT modified)
- [x] Out of Scope: No CI threshold updates -- respected (not in plan)

### Service Layer / Architecture Constraints
- [x] Requirement: All new functions pure and exported from src/scoring.ts -- covered by Tasks 5, 7, 8
- [x] Requirement: lore_query handler orchestrates in sequence, no new MCP tools -- covered by Tasks 6, 7, 8
- [x] Requirement: Phase 1 confined to eval files, Phase 2 confined to src/scoring.ts and src/server.ts -- covered by plan file lists

### Data Model
- [x] Requirement: No data model changes, no new frontmatter fields, no migration -- respected (plan adds no schema changes)

## Score: 88/100

### Category Scores
| Category | Weight | Score |
|----------|--------|-------|
| Coverage | 40% | 90 |
| Mutation Resistance | 30% | 83 |
| Invention Control | 20% | 95 |
| Recommendations Quality | 10% | 85 |

## Verdict: FAITHFUL

## Strengths
- Extremely thorough decomposition of both Phase 1 and Phase 2 with clear task boundaries matching the spec's implementation order
- Every constant value from the spec is faithfully carried forward (PPR_ALPHA, PPR_ITERATIONS, PPR_MIN_SCORE, MAX_EXPANSION, SHARED_ATTR_DISCOUNT, SHARED_ATTR_MAX, METADATA_HINT_BOOST, METADATA_HINT_STOPLIST)
- Unit test tasks explicitly cover key edge cases from the spec (empty graph, disconnected components, stoplist filtering)
- Verification sections in every task provide concrete commands to prove correctness
- The fallback strategy (revert Phase 2 if recall < 0.60) is explicitly covered in Task 9 Step 3
- The plan correctly keeps `eval/compare.js` unmodified and treats sub-types as informational only
- The `applyMetadataHintBoost` helper function (Task 8 Step 3) is a reasonable invention -- it factors the boost logic cleanly without changing behavior. The spec describes this as inline application but the plan's extraction into a pure function improves testability

## Issues

### Minor: Self-loop edge case not explicitly addressed
**Failure mode:** Coverage Gap
**Spec reference:** Edge case "Self-loops in graph: A document linking to itself via [[Own Title]] creates a self-loop. PPR handles self-loops naturally -- the score cycles back to the node. No special handling needed."
**Plan reference:** Task 5 Step 2 says "Skip self-loops (where resolvedPath === doc.path)"
**Description:** The spec says self-loops are handled naturally by PPR and require no special handling. The plan explicitly skips self-loops during graph construction. While this is arguably a reasonable implementation choice that does not change observable behavior (self-loops in PPR just waste a fraction of score propagation to the node itself), it is a subtle deviation from the spec's stated approach of letting PPR handle them naturally. The practical impact is negligible.
**Suggestion:** Either remove the self-loop skip to match the spec exactly, or add a brief comment in the task noting that this is a deliberate optimization over the spec's "no special handling" guidance, since the outcome is equivalent.

### Minor: Shared-attribute tie-breaking uses path sort instead of BM25 score
**Failure mode:** Mutation
**Spec reference:** Edge case "Shared-attribute expansion finds too many candidates: Capped at SHARED_ATTR_MAX=3 results. Prioritized by attribute overlap count, then by BM25 score of the candidate if tied."
**Plan reference:** Task 7 Step 2: "Sort by shared count descending, then by path alphabetically for determinism."
**Description:** The spec prescribes BM25 score as the secondary sort key when shared-attribute counts are tied. The plan substitutes alphabetical path sorting for determinism. While determinism is a valid concern, the spec's intent is that higher-scoring (more relevant) candidates should be preferred when attribute overlap is equal. Path-alphabetical ordering is arbitrary and could surface less relevant results.
**Suggestion:** Change Task 7 Step 2 to sort by shared-attribute count descending, then by BM25 score descending (passing BM25 scores or the scored results to the function), then by path alphabetically as a final tiebreaker for full determinism.

### Minor: Shared-attribute matching criteria has subtle rewording
**Failure mode:** Mutation
**Spec reference:** "Find other documents sharing at least domain + 1 tag (or 2+ tags if no domain match)."
**Plan reference:** Task 7 Step 2: "Require at minimum: (domain match AND 1+ shared tag) OR (2+ shared tags without domain match)."
**Description:** These are semantically equivalent on close reading. The plan faithfully preserves the spec's matching criteria. However, the spec says "sharing at least domain + 1 tag" which could be read as "domain is a necessary shared attribute plus at least one tag" while the plan's formulation makes the OR condition explicit. This is actually clearer than the spec and not a true mutation. Noting for completeness -- no action needed.
**Suggestion:** No change needed. The plan's phrasing is more precise.

### Minor: `buildWikilinkGraph` spec says to skip self-loops but also says PPR handles them naturally
**Failure mode:** Coverage Gap
**Spec reference:** The spec's `buildWikilinkGraph` description says it "constructs a bidirectional adjacency list by extracting wikilinks from each document and resolving them via titleMap/slugMap" with no mention of filtering self-loops. The edge case section separately says "PPR handles self-loops naturally."
**Plan reference:** Task 5 Step 2 adds "Skip self-loops (where resolvedPath === doc.path)" to the graph construction.
**Description:** This is the same issue as the self-loop item above, noted here for completeness with respect to the function specification. The spec's buildWikilinkGraph description does not mention self-loop filtering, and the edge case section explicitly says no special handling is needed.
**Suggestion:** Same as above -- either remove the self-loop skip or document the deviation.

### Minor: `applyMetadataHintBoost` as a separate function is an invention
**Failure mode:** Invention
**Spec reference:** Spec describes applying the 1.5x multiplier inline in the lore_query handler: "documents matching the hinted domain/type get a 1.5x multiplier on their BM25 score after scoring."
**Plan reference:** Task 8 Step 3 introduces `applyMetadataHintBoost` as a new exported function from scoring.ts.
**Description:** The spec does not mention a separate `applyMetadataHintBoost` function. The plan introduces it as a pure function in scoring.ts for testability. This is a reasonable infrastructure invention -- the behavior matches the spec exactly, and extracting it into a testable pure function is good engineering practice. The spec's service layer section only lists `extractQueryMetadataHints` as a scoring.ts function, not `applyMetadataHintBoost`.
**Suggestion:** Acceptable as-is. The function is a natural decomposition of the spec's requirement and does not introduce new behavior. If strict spec compliance is desired, the boost could be applied inline in server.ts instead.

## Recommendations

1. **Clarify chain title format in Task 1 Step 4.** The plan converts index triples to title triples (`{ a: entries[c.a].title, ... }`), which changes the property names from indices to titles. Task 2 Step 5 then accesses `chain.a` as a title string. This mapping is internally consistent but could be confusing since the spec's code example shows `{ a, b, c }` as indices. A brief comment in the task noting this conversion would help implementers.

2. **Add explicit test for natural-language query templates in Task 2.** The plan verifies question counts and sub-type distribution but does not verify that the natural-language templates are actually used for forward_1hop questions. Consider adding an assertion in the verification step that checks at least one forward_1hop question's query string starts with "What relates to" or contains "entries connected to".

3. **Preserve Phase 1 baseline separately for Task 9 comparison.** Task 9 Step 2 compares against `eval/baseline.json` which is the Phase 1 baseline, but Task 9 Step 4 overwrites it with the Phase 2 baseline. The plan should note that a copy of the Phase 1 baseline should be saved before overwriting (Task 9 Step 3 references `<phase1-baseline-copy>.json` in verification, which implies this, but it should be an explicit step).

4. **Consider adding a unit test for `buildWikilinkGraph` with self-loops** to validate the chosen behavior (skip vs. include), whichever approach is taken after resolving the self-loop issue above.
