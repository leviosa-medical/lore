# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-11

### Added

- **`search_keys` field** — new optional `string[]` frontmatter field on lore entries for agent-generated synonyms, alternative phrasings, and "questions this entry answers." Accepted by **`lore_write`** and included in BM25 scoring. Bridges vocabulary mismatch when users search with different words than entries contain
- **Query decomposition** — **`lore_query`** now detects compound questions (e.g., "what role handles X and what is the notice period?") and splits them into sub-queries, running BM25 independently on each and merging results. Avoids diluting relevance across unrelated terms
- **`decomposeQuery` unit test** — covers 6 cases including compound splits, casual "and" passthrough, and fragment length filtering
- **Metadata weighting unit test** — verifies that domain/type/tags matches score higher than incidental body-text matches

### Changed

- **Recency bonus** — now multiplicative instead of additive, with a stronger peak (0.50, up from 0.15) and faster decay (90-day half-life, down from 180). Applied as `(score + confidence) × (1 + recency)` so the bonus scales with relevance rather than dominating low-scoring entries. Knowledge Updates Recall@5 improved from 0.50 to 0.70 (+40%)
- **Field-specific BM25 boosting** — metadata fields (domain, type, tags) now receive 2× term frequency weight in BM25 scoring, so a query for "billing concept" strongly prefers entries where `domain=billing` and `type=concept` over entries that merely mention those words in body text. Keyword Metadata Recall@5 improved from 0.93 to 0.95
- **Wikilink expansion parameters** — qualifying threshold lowered from 0.3 to 0.2 (more mid-scoring entries expand) and discount raised from 0.7× to 0.85× parent score (expanded results rank more competitively)
- **`/lore:capture` skill** — now instructs agents to generate 5-10 search keys before calling `lore_write`
- **`/lore:bootstrap` skill** — now instructs agents to generate search keys for each derived entry

### Internal

- Extracted `applyConfidenceAndRecency` helper into `scoring.ts` to deduplicate the scoring formula between **`lore_search`** and **`lore_query`**
- Moved `EXPANSION_THRESHOLD` and `EXPANSION_DISCOUNT` from inline constants in `server.ts` to exported constants in `scoring.ts`, consistent with `METADATA_WEIGHT`
- Added explicit `search_keys` field to `Frontmatter` interface with `Array.isArray` runtime guard

## [0.5.0] - 2026-04-11

### Added

- **Eval benchmark harness** — `node eval/run.js` runs a LongMemEval-inspired retrieval quality benchmark against a deterministic synthetic corpus, measuring Recall@k and NDCG@k across six abilities (information extraction, multi-hop reasoning, knowledge updates, keyword metadata, filtered search, abstention). Produces a results table and JSON report. Supports `--tier`, `--layer`, `--threshold`, and `--max-latency-ms` flags for CI gating
- **Recency bonus** — recently updated entries now receive a small additive score boost (up to +0.15, decaying with a 180-day half-life), so newer versions of a concept rank above older ones when BM25 scores are similar
- **Metadata in BM25 search text** — domain, type, and tags are now appended to the BM25 search text, improving retrieval when queries reference metadata terms (e.g., "billing glossary") rather than body content

### Changed

- **1-hop wikilink expansion** now always expands from the top 3 results and interleaves expansion pages by score, instead of only triggering when fewer than 3 results qualify. Multi-hop Recall@5 improved from 0.51 to 0.67 (+31%) with no regressions on other abilities
- **Expansion page score factor** increased from 0.5× to 0.7× parent score, so linked entries rank more competitively against BM25 results

### Internal

- **Scoring extraction** — pure scoring functions (`computeBM25Scores`, `tokenize`, `confidenceBonus`, `recencyBonus`, `applyLinkBoost`, `extractWikilinks`, etc.) extracted from `src/server.ts` into `src/scoring.ts` for direct unit testing by the eval harness
- Removed unused `ScoredResult` type import from `src/server.ts`

## [0.4.0] - 2026-04-10

### Added

- **Zettelkasten knowledge graph** — lore entries now support `[[wikilinks]]` for linking related concepts, enabling a connected knowledge graph rather than isolated pages
- **BM25 scoring** — **`lore_search`** and **`lore_query`** now use BM25 ranking instead of naive keyword proportion, producing significantly better search relevance
- **Inbound link boost** — well-linked hub pages rank higher in search results via log-dampened link-count scoring, so central concepts surface first
- **1-hop wikilink expansion** — **`lore_query`** automatically includes linked neighbor pages when initial results are thin (fewer than 3 qualifying results), surfacing related context without manual browsing
- **Source pages** — new `source` page type preserves original documents verbatim as first-class provenance records. Source pages track which entries were derived from them via `derived_entries` frontmatter
- **Backlink maintenance** — when a derived entry references a source page in its `sources` array (e.g., `"source:Source - CLAUDE.md"`), the source page's `derived_entries` are automatically updated
- **`lore_write` schema extensions** — three new optional fields: `derived_entries`, `source_url`, `source_file` (non-breaking; only written for source-type pages)
- **PreToolUse hook** now blocks direct writes to `lore/sources/` in addition to existing type directories

### Changed

- **`lore_read` resolution chain** — now resolves by title first, slug second, direct path third (was path-first). Title-first is correct for a wikilink-centric system where users reference pages by name
- **`lore_query` internals** — fully rewritten to use BM25 + link boost + confidence bonus + 1-hop expansion pipeline, replacing the index-scan + keyword-overlap approach
- **`lore_search` internals** — replaced keyword proportion scoring with BM25 + inbound link-count boost + confidence bonus
- **`/lore:bootstrap` skill** — rewritten for atomic decomposition: creates source pages preserving original content, then decomposes into atomic wikilinked entries with per-entry user confirmation
- **`lore_list` type filter** — now accepts `"source"` as a valid type

## [0.3.1] - 2026-04-10

### Fixed

- **`/lore:init`** — now explicitly tells users to restart Claude Code before running bootstrap, since the MCP server and agent rule aren't available until after a restart
- **`/lore:bootstrap`** — preflight check calls `lore_list` to verify the MCP server is running before proceeding; stops with a clear restart message if it isn't

## [0.3.0] - 2026-04-10

### Added

- **PreToolUse hook** — blocks direct `Write`/`Edit` to lore entry files (`lore/<type>/*.md`), directing agents to use `lore_write` instead. Ensures the operations log and index stay in sync. Lives in `hooks/hooks.json` so it disappears cleanly on plugin removal.

### Fixed

- **`/lore:bootstrap` skill** — tightened instructions to explicitly require `lore_write` for entry creation, preventing silent bypass of the operations audit trail

## [0.2.1] - 2026-04-10

### Fixed

- **`/lore:init` install script** — fixed `SCRIPT_DIR` resolving to wrong directory level after move from `bin/` to `skills/init/`
- **`extraKnownMarketplaces` schema** — `source` field now uses the nested object format required by Claude Code settings validation

## [0.2.0] - 2026-04-10

### Added

- **`/lore:init` skill** — set up lore in a new project. Creates the `lore/` directory structure, agent integration rule, and configures `extraKnownMarketplaces` in the project's `.claude/settings.json` so teammates get auto-prompted to install the plugin
- **Team-wide plugin discovery** — install script now writes marketplace and plugin config to the project's `.claude/settings.json`, eliminating the need for each team member to manually add the marketplace
- **CHANGELOG.md** — tracks all user-facing changes following Keep a Changelog format
- **Version enforcement hook** — PostToolUse hook blocks when `plugin.json` version is edited until `CHANGELOG.md` is updated
- **CLAUDE.md** — documents when and how to bump the plugin version

### Changed

- **Install instructions** — replaced local filesystem paths with `/plugin marketplace add` and `/plugin install` commands for GitHub-hosted distribution
- **Moved `install.sh`** from `bin/` to `skills/init/` — the script is no longer exposed on the shell PATH; it runs through the `/lore:init` skill instead

## [0.1.0] - 2026-04-10

Initial release.

### Added

- **MCP server** with `lore_query`, `lore_search`, `lore_read`, `lore_write`, and `lore_list` tools
- **`/lore:bootstrap` skill** — one-time seeding from existing CLAUDE.md, rules, and docs
- **`/lore:capture` skill** — capture domain knowledge from conversation
- **`/lore:resolve` skill** — resolve git merge conflicts and contradictions in lore entries
- **Confidence lifecycle** — `assumed` → `inferred` → `verified`, with human confirmation required for promotion
- **Entry types** — concept, entity, rule, role, decision, glossary
- **Agent integration rule** — `.claude/rules/lore.md` instructs agents to always query lore before asking domain questions
- **Version tracking** — auto-detect stale installs on MCP server startup
