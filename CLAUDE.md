# Lore Plugin

Claude Code plugin providing persistent, confidence-tracked domain knowledge per project.

## Versioning

This plugin uses [Semantic Versioning](https://semver.org/):

- **PATCH** (0.1.x) — bug fixes, typo corrections, minor tweaks
- **MINOR** (0.x.0) — new skills, new MCP tools, new features, non-breaking changes
- **MAJOR** (x.0.0) — breaking changes to MCP tool schemas, skill renames, or install flow changes

**When to bump:** every PR that changes user-facing behavior (skills, MCP tools, install script, agent rules) must bump the version in `.claude-plugin/plugin.json`. Documentation-only or internal-only changes don't require a version bump.

**How to bump:** edit the `version` field in `.claude-plugin/plugin.json`. A PostToolUse hook will fire and instruct you to update `CHANGELOG.md` before proceeding — follow those instructions.
