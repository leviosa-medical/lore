# Lore Plugin

Claude Code plugin providing persistent, confidence-tracked domain knowledge per project.

## Versioning

This plugin uses [Semantic Versioning](https://semver.org/):

- **PATCH** (0.1.x) — bug fixes, typo corrections, minor tweaks
- **MINOR** (0.x.0) — new skills, new MCP tools, new features, non-breaking changes
- **MAJOR** (x.0.0) — breaking changes to MCP tool schemas, skill renames, or install flow changes

**When to bump:** every PR that changes user-facing behavior (skills, MCP tools, install script, agent rules) must bump the version in `.claude-plugin/plugin.json`. Documentation-only or internal-only changes don't require a version bump.

**How to bump:** edit the `version` field in `.claude-plugin/plugin.json`. A PostToolUse hook will fire and instruct you to update `CHANGELOG.md` before proceeding — follow those instructions.

## Eval Benchmark

A self-contained retrieval quality benchmark lives in `eval/`. Run with `node eval/run.js` (builds automatically). See `docs/specs/eval-benchmark-design.md` for the full spec.

**Quick reference:**
- `node eval/run.js` — full run (unit + integration, small corpus)
- `node eval/run.js --layer unit` — unit tests only (fast, no server)
- `node eval/run.js --tier medium` — larger corpus (200 entries)
- `node eval/run.js --threshold 0.8` — fail if Recall@5 drops below 0.8

**When to run:** after changing scoring parameters (k1, b, link boost weight, confidence bonuses, expansion logic) in `src/scoring.ts` or `src/server.ts`. The per-ability breakdown pinpoints which retrieval capability regressed.
