# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-10

### Added

- **`/lore:init` skill** — set up lore in a new project. Creates the `lore/` directory structure, agent integration rule, and configures `extraKnownMarketplaces` in the project's `.claude/settings.json` so teammates get auto-prompted to install the plugin
- **Team-wide plugin discovery** — `install.sh` now writes marketplace and plugin config to the project's `.claude/settings.json`, eliminating the need for each team member to manually add the marketplace

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
