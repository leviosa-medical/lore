# Lore — Domain Knowledge Plugin for Claude Code

A Claude Code plugin that creates and maintains a self-correcting domain knowledge base per project. Business rules, entity definitions, architectural decisions, and domain context persist across sessions — so agents stop re-researching the same rules and stop making the same wrong assumptions.

## How it works

Knowledge lives in a `lore/` directory in your project repo — version-controlled, PR-reviewable, team-shared. Each entry is an atomic markdown file with YAML frontmatter tracking confidence level, sources, and domain classification. Entries connect to each other through `[[wikilinks]]`, forming a knowledge graph that agents can traverse.

Agents check the lore before asking you domain questions. When they learn something new, they write it back. When they get something wrong, a retrospective hook catches it and the entry gets corrected.

### Confidence lifecycle

Every entry carries a confidence level that reflects how it was validated:

```
assumed  →  inferred  →  verified
```

- **`assumed`** — Unverified agent inference. Treat with caution.
- **`inferred`** — Derived from code analysis or research. Likely correct but not human-confirmed.
- **`verified`** — Human-confirmed. The ground truth.

Only human confirmation promotes confidence. Agents always present lore-sourced context as explicit assumptions you can correct.

### Knowledge graph

Entries link to each other using `[[wikilinks]]`. When you query the lore, the search engine uses these links to surface related context:

- **BM25 ranking** scores results by keyword relevance, not naive string matching.
- **Inbound link boost** promotes well-connected hub pages — central concepts surface first.
- **1-hop expansion** automatically includes linked neighbor pages when initial results are thin (fewer than 3 qualifying results).
- **Confidence bonus** ranks verified entries above inferred and assumed ones.

### Source provenance

Original documents (CLAUDE.md, internal docs, READMEs) are preserved as `source`-type pages during bootstrap. Every derived entry traces back to its source page via the `sources` field, and source pages track their derivatives via `derived_entries`. This creates a full provenance chain — you can always trace any claim back to where it came from.

## Quick start

### 1. Install the plugin

```
/plugin marketplace add leviosa-medical/lore
/plugin install lore@lore
```

### 2. Set up a project

From your target project's root:

```
/lore:init
```

This creates:
- `lore/` directory with subdirectories for each entry type
- `lore/index.md` — entry catalog with wikilinks
- `lore/config.yaml` — project-specific domains and routing guidance
- `lore/operations.jsonl` — append-only operation log
- `.claude/rules/lore.md` — agent integration rule (makes agents query lore automatically)
- `.claude/settings.json` — marketplace and plugin config (so teammates get auto-prompted to install)

> **Important:** Restart Claude Code after running `/lore:init`. The MCP server and agent rule aren't available until after a restart.

### 3. Seed initial knowledge

```
/lore:bootstrap
```

This reads your CLAUDE.md, `.claude/rules/`, skill definitions, and docs to extract declarative domain knowledge into atomic, wikilinked lore entries. Imperative instructions ("always do X", "never do Y") stay in CLAUDE.md. After seeding, the skill suggests which declarative lines can be removed from CLAUDE.md to save context tokens.

## Usage

### Automatic (during agent work)

Once installed, the agent rule in `.claude/rules/lore.md` instructs agents to:

1. **Query first** — call `lore_query` before asking you domain questions, even if the answer seems obvious from files already in context
2. **State assumptions** — present lore-sourced context as explicit assumptions: _"Based on the lore, I'm assuming X. Flag if wrong."_
3. **Write back** — when the lore has no answer, research it and write it back with appropriate confidence

You don't need to invoke any tools manually — the agent does this on its own.

### Skills

| Skill | Purpose |
|---|---|
| `/lore:init` | Set up lore in the current project |
| `/lore:bootstrap` | One-time seeding from CLAUDE.md, rules, skill definitions, and docs into atomic wikilinked entries |
| `/lore:capture` | Capture domain knowledge that surfaces during conversation |
| `/lore:resolve` | Resolve git merge conflicts and semantic contradictions in lore entries |

#### `/lore:init`

Creates the `lore/` directory structure, the agent integration rule, and configures project settings so teammates are auto-prompted to install the plugin. Run once per project.

#### `/lore:bootstrap`

Reads existing project knowledge sources and decomposes them into atomic entries:

1. Creates `source`-type pages preserving original documents verbatim
2. Decomposes each source into individual entries with `[[wikilinks]]`
3. Presents the decomposition graph for your confirmation before writing
4. Suggests CLAUDE.md cleanup — removing declarative lines now covered by lore

#### `/lore:capture`

Use when domain knowledge surfaces in conversation — a business rule mentioned in a meeting, a decision made in a PR review, a term defined in a Slack thread. Accepts a knowledge statement as an argument or extracts from recent conversation context. Classifies whether the knowledge belongs in lore, CLAUDE.md, or a skill definition.

#### `/lore:resolve`

Handles two types of conflicts:

- **Git merge conflicts** — scans `lore/` for conflict markers. Auto-resolves structural conflicts (formatting, whitespace). Asks you about semantic conflicts (different content claims).
- **Semantic contradictions** — finds entries with the same entity/concept name that make conflicting claims. Presents both sides for your resolution.

### MCP tools

Agents use these directly — you don't need to call them manually:

| Tool | Purpose |
|---|---|
| `lore_query` | Primary tool — answer a domain question using BM25 + link boost + 1-hop expansion |
| `lore_search` | Keyword search with confidence-aware ranking |
| `lore_read` | Read a specific page by title, slug, or path |
| `lore_write` | Create or update an entry (maintains operations log, index, and backlinks) |
| `lore_list` | Browse entries filtered by type, domain, confidence, or tag |

## Entry types

| Type | Directory | What goes here |
|---|---|---|
| `concept` | `concepts/` | Domain ideas, frameworks, methods |
| `entity` | `entities/` | Organizations, products, services |
| `rule` | `rules/` | Business rules, validation logic, regulatory constraints |
| `role` | `roles/` | User roles, permissions, responsibilities |
| `decision` | `decisions/` | Architectural/business decisions with rationale |
| `glossary` | `glossary/` | Domain vocabulary mapped to code concepts |
| `source` | `sources/` | Preserved original documents (created during bootstrap) |

## Entry format

```markdown
---
title: Lease Termination Notice Period
type: rule
domain: leasing
confidence: verified
created: 2026-04-10
updated: 2026-04-10
sources: ["human:brainstorming"]
tags: ["notice-period", "termination"]
---

Tenants must provide 60 days written notice before
terminating a lease. This applies to all residential
leases regardless of [[Lease Term Types|lease term]].

See also: [[Early Termination Fee]], [[Notice Requirements]]
```

Entries use `[[wikilinks]]` to connect to related pages. Links can use pipe syntax for display text: `[[Page Title|display text]]`.

### Source page format

Source pages have additional frontmatter fields for provenance tracking:

```markdown
---
title: "Source - CLAUDE.md"
type: source
confidence: verified
sources: ["human:bootstrap"]
derived_entries: ["Lease Termination Notice Period", "Early Termination Fee"]
source_file: "CLAUDE.md"
---
```

## Safety and hooks

The plugin includes hooks that enforce data integrity:

- **Write protection** — A PreToolUse hook blocks direct `Write`/`Edit` operations on lore entry files. All writes go through `lore_write`, which maintains the operations log, index, and backlink graph. This prevents agents from accidentally bypassing the audit trail.
- **Retrospective prompt** — A Notification hook fires on task completion, asking: _"Were any domain assumptions wrong in this session?"_ If you confirm issues, the agent updates the lore.
- **Version enforcement** — A PostToolUse hook fires when `plugin.json` version is updated, blocking further work until `CHANGELOG.md` is updated. (Development only.)

## Team setup

When `/lore:init` runs, it writes marketplace and plugin configuration to `.claude/settings.json`. When teammates open the project in Claude Code, they're automatically prompted to install the Lore plugin. The `lore/` directory is version-controlled, so knowledge is shared through normal git workflows — branches, PRs, code review.

### Resolving conflicts after merges

When multiple teammates add lore entries on different branches, merge conflicts can occur. Run `/lore:resolve` after a merge to:

1. Fix git conflict markers in lore files
2. Detect semantic contradictions introduced by the merge
3. Get your confirmation before resolving ambiguous conflicts

## Troubleshooting

### MCP server not available after `/lore:init`

Restart Claude Code. The MCP server and agent rule aren't loaded until after a restart.

### `/lore:bootstrap` fails with "MCP server isn't available"

Same fix — restart Claude Code first. The bootstrap skill runs a preflight check and will tell you if the server isn't running.

### Agent writes to `lore/` directly instead of using `lore_write`

The PreToolUse hook should block this. If it's not working, check that hooks are loaded: the hook configuration lives in `hooks/hooks.json` in the plugin directory.

### Entries not appearing in search results

Check that the entry has valid YAML frontmatter with a `title` field. The search indexes by title and body content. Entries without titles won't be found by `lore_read`'s title resolution.

### Stale plugin version

The MCP server logs a warning on startup if the installed version doesn't match the plugin version. Run `/lore:init` again to update.

## Design principles

- **No cloud dependencies** — entirely local: filesystem for storage, stdio for transport, git for versioning
- **Never invents knowledge** — every entry must trace to a source
- **Never auto-deletes** — corrections update in place, old content is superseded
- **Never modifies source files** — the plugin reads CLAUDE.md during bootstrap but only writes to `lore/`
- **Atomic notes** — one concept per page, connected by wikilinks instead of monolithic documents
- **PR-reviewable** — knowledge changes go through the same review process as code

## License

[MIT](LICENSE)
