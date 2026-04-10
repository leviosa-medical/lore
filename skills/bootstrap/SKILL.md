---
name: bootstrap
description: "One-time lore seeding from existing CLAUDE.md files, .claude/rules/, and skill definitions. Decomposes source material into atomic, wikilinked knowledge graph entries. Use when setting up lore for the first time in a project."
argument-hint: ""
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, mcp__lore__lore_write, mcp__lore__lore_list, mcp__lore__lore_read, mcp__lore__lore_search]
---

# Lore Bootstrap (v2 — Zettelkasten)

Seed the lore knowledge base by decomposing existing project artifacts into atomic, wikilinked knowledge graph entries. This is a one-time operation for initial lore setup.

## Process

1. **Preflight check.** Call `lore_list` to verify the MCP server is running. If it fails, stop immediately and tell the user: "The lore MCP server isn't available. Please restart Claude Code and try again."

2. **Read source material.** Discover and read all knowledge sources:
   - `CLAUDE.md` files (root and any nested)
   - `.claude/rules/*.md` files
   - `skills/*/SKILL.md` files
   - Any other documentation files in the project root (README.md, docs/, etc.)

3. **Create source pages.** For each source document, create a `source`-type page that preserves the full original content:
   - Use `lore_write` with `type: "source"`
   - Title format: `"Source - <Document Name>"` (e.g., "Source - CLAUDE.md", "Source - API Docs")
   - Body format:
     ```markdown
     # Source - [Document Title]

     **Original file:** `path/to/original.md` (deprecated after ingestion)
     **Ingested:** YYYY-MM-DD

     ## Summary

     One-paragraph summary of what this source contains.

     ## Original Content

     <full raw content preserved verbatim>

     ## Derived Entries

     (will be populated automatically via backlink maintenance)
     ```
   - Set `source_file` to the original file path
   - Set `source_url` if the document has a known URL
   - Set `confidence: verified` (the original content is authoritative)
   - Set `sources` to `["human:bootstrap"]`
   - If a source document exceeds 50KB, split into multiple source pages with sequential suffixes (e.g., "Source - API Docs (Part 1)") and note the split in each page's summary.

4. **Decompose into atomic entries.** Read each source page and extract individual pieces of knowledge. Each becomes its own page with one concept per page (multiple related claims allowed). For each entry:
   - Classify type: `concept`, `entity`, `rule`, `role`, `decision`, or `glossary`
   - Write a focused body covering exactly one concept
   - Add `[[wikilinks]]` to related entries (both existing and ones you're about to create)
   - Set `sources` array to include `"source:Source - <Document Title>"` to trigger backlink maintenance
   - Use your judgment for domain groupings (e.g., "billing", "tenants", "scheduling")
   - Entry types:
     - `concept` — Domain ideas, frameworks, methods
     - `entity` — Organizations, products, services
     - `rule` — Business rules, validation logic, regulatory constraints
     - `role` — User roles, permissions, responsibilities
     - `decision` — Architectural/business decisions with rationale
     - `glossary` — Domain vocabulary mapped to code concepts

5. **Handle title collisions.** Before writing each entry, check if a page with the proposed title already exists via `lore_search`. If a collision is found:
   - Show the user both the existing entry and the proposed new entry
   - Ask: keep existing, overwrite, or rename the new entry
   - Do not silently overwrite

6. **Present for confirmation.** Show the user the decomposition graph: source documents broken into atomic entries with proposed wikilinks. For each source, show:
   - Source page title
   - List of derived entries (title, type, domain)
   - Key wikilinks between entries
   - The user can accept all, reject all, or accept/reject individual entries. Rejected entries are skipped (not written).

7. **Write confirmed entries.** Write each confirmed entry via `lore_write`:
   - **ALWAYS use the `lore_write` MCP tool** — never use Write or Edit to create files in `lore/` directly. `lore_write` maintains the operations log, index, and backlink maintenance.
   - Set `confidence: verified` for user-confirmed entries
   - Set `confidence: inferred` for entries the user didn't explicitly review
   - Backlink maintenance will automatically update each source page's `derived_entries` frontmatter

8. **Suggest CLAUDE.md cleanup.** CLAUDE.md loads every session, consuming context tokens. Lore loads on-demand via MCP. Present a cleanup plan:
   - **Remove** declarative lines that are now in lore (domain terms, architecture descriptions, entity tables, "the system works like X" explanations). Don't replace them with references or pointers — Claude already knows lore exists via the MCP tool names visible at session start.
   - **Keep** all imperative instructions ("always do X", "never do Y", "run tests with X", conventions).
   - **Distill imperatives from removed context.** If a removed section contained an implicit imperative buried in explanation (e.g., "do not rename proxy.ts"), extract it as a terse bullet and keep it.
   - **Add one routing imperative** if no `.claude/rules/` file or CLAUDE.md line already mentions lore: `"Query lore before making assumptions about domain terminology or business rules."`
   - Explain the rationale: "CLAUDE.md is always-on context. Lore is on-demand. Removing declarative knowledge from CLAUDE.md saves tokens every session while keeping it accessible via lore queries."
   - **Never modify CLAUDE.md directly** — present the suggestions and let the user decide.

9. **Create config.yaml.** Write `lore/config.yaml` with discovered domains and the standard routing guidance:
   ```yaml
   domains:
     - <discovered-domain-1>
     - <discovered-domain-2>
   routing:
     lore: "Declaratives: 'the system works like X because Y', domain context"
     claude_md: "Imperatives: 'always do X', 'never do Y', conventions"
     skills: "Workflow logic, process instructions"
   ```

## Important Rules

- **Never modify CLAUDE.md, .claude/rules/, or any file outside lore/** — only suggest changes
- Every lore entry must have a traceable source (via `sources` field linking back to source pages)
- If no declarative knowledge is found, say so — don't invent entries
- If the lore directory doesn't exist, tell the user to run `/lore:init` first
- One concept per page — if a section covers multiple concepts, split into multiple entries
- Use `[[wikilinks]]` liberally to connect related entries across the graph
- Source pages are immutable archives — never modify their Original Content section after creation
