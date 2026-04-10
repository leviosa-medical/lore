# Lore — Domain Knowledge Plugin for Claude Code

A Claude Code plugin that creates and maintains a self-correcting domain knowledge base per project. Business rules, entity definitions, architectural decisions, and domain context persist across sessions — so agents stop re-researching the same rules and stop making the same wrong assumptions.

## How it works

Knowledge lives in a `lore/` directory in your project repo — version-controlled, PR-reviewable, team-shared. Each entry is a markdown file with YAML frontmatter tracking confidence level, sources, and domain classification.

Agents check the lore before asking you domain questions. When they learn something new, they write it back. When they get something wrong, the retrospective hook catches it and the entry gets corrected.

**Confidence lifecycle:** `assumed` → `inferred` → `verified`. Only human confirmation promotes confidence. The agent always presents lore-sourced context as explicit assumptions you can correct.

## Install

### 1. Install the plugin

Add the marketplace and install:

```
/plugin marketplace add leviosa-medical/lore
/plugin install lore@lore
```

### 2. Set up a project

From your target project's root, run the install script (available on PATH after plugin install):

```bash
install.sh
```

This creates:
- `lore/` directory with subdirectories for each entry type
- `lore/index.md` — entry catalog
- `lore/config.yaml` — project-specific domains and routing guidance
- `lore/operations.jsonl` — append-only operation log
- `.claude/rules/lore.md` — agent integration rule

### 3. Seed initial knowledge

```
/lore:bootstrap
```

This reads your CLAUDE.md, `.claude/rules/`, and docs to extract declarative domain knowledge into lore entries. Imperative instructions stay in CLAUDE.md.

## Usage

### Automatic (during agent work)

The agent rule in `.claude/rules/lore.md` instructs agents to:
1. Query the lore before asking you domain questions
2. Present lore-sourced context as stated assumptions
3. Write new knowledge back when the lore has no answer

### Skills

| Skill | Purpose |
|---|---|
| `/lore:bootstrap` | One-time seeding from existing CLAUDE.md and docs |
| `/lore:capture` | Capture domain knowledge from conversation |
| `/lore:resolve` | Resolve git merge conflicts and contradictions in lore entries |

### MCP Tools

Agents use these directly — you don't need to call them manually:

| Tool | Purpose |
|---|---|
| `lore_query` | Answer a domain question (primary tool — returns full content for synthesis) |
| `lore_search` | Keyword search with confidence-aware ranking |
| `lore_read` | Read a specific page by title or path |
| `lore_write` | Create or update an entry |
| `lore_list` | Browse entries filtered by type, domain, confidence, or tag |

## Lore entry types

| Type | Directory | What goes here |
|---|---|---|
| `concept` | `concepts/` | Domain ideas, frameworks, methods |
| `entity` | `entities/` | Organizations, products, services |
| `rule` | `rules/` | Business rules, validation logic, regulatory constraints |
| `role` | `roles/` | User roles, permissions, responsibilities |
| `decision` | `decisions/` | Architectural/business decisions with rationale |
| `glossary` | `glossary/` | Domain vocabulary mapped to code concepts |

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
leases regardless of lease term.
```

## Design principles

- **No cloud dependencies** — entirely local: filesystem for storage, stdio for transport, git for versioning
- **Never invents knowledge** — every entry must trace to a source
- **Never auto-deletes** — corrections update in place, old content is superseded
- **Never modifies source files** — the plugin reads CLAUDE.md during bootstrap but only writes to `lore/`
