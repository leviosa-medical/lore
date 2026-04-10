---
name: bootstrap
description: "One-time lore seeding from existing CLAUDE.md files, .claude/rules/, and skill definitions. Use when setting up lore for the first time in a project."
argument-hint: ""
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, mcp__lore__lore_write, mcp__lore__lore_list, mcp__lore__lore_read]
---

# Lore Bootstrap

Seed the lore knowledge base from existing project artifacts. This is a one-time operation for initial lore setup.

## Process

1. **Discover existing knowledge sources.** Read:
   - `CLAUDE.md` files (root and any nested)
   - `.claude/rules/*.md` files
   - `skills/*/SKILL.md` files
   - Any other documentation files in the project root (README.md, docs/, etc.)

2. **Classify each instruction.** For every distinct piece of knowledge found, classify it as one of:
   - **Imperative** (stays in CLAUDE.md): "always do X", "never do Y", coding conventions, tool preferences, workflow instructions
   - **Declarative** (candidate for lore): "the system works like X because Y", business rules, domain context, entity definitions, architectural decisions with rationale

3. **Group declarative knowledge by domain.** Use your judgment to infer domain groupings (e.g., "billing", "tenants", "scheduling"). Don't use a fixed heuristic — classify based on the content. For each group, determine the appropriate lore type:
   - `concept` — Domain ideas, frameworks, methods
   - `entity` — Organizations, products, services
   - `rule` — Business rules, validation logic, regulatory constraints
   - `role` — User roles, permissions, responsibilities
   - `decision` — Architectural/business decisions with rationale
   - `glossary` — Domain vocabulary mapped to code concepts

4. **Present grouped knowledge to the user.** Show each group with:
   - Inferred domain name
   - Proposed lore entries (title, type, summary)
   - Ask: confirm, correct, or skip each group

5. **Write confirmed entries.** For each confirmed entry:
   - **ALWAYS use the `lore_write` MCP tool** — never use Write or Edit to create files in `lore/` directly. `lore_write` maintains the operations log and index; bypassing it leaves the audit trail empty.
   - Set `confidence: verified` for user-confirmed entries
   - Set source to `"bootstrap:CLAUDE.md"` or appropriate source path
   - For entries the user didn't review, use `confidence: inferred`

6. **Suggest CLAUDE.md cleanup.** Present a summary of what declarative knowledge was moved to lore. Suggest specific lines that could be removed from CLAUDE.md. **Never modify CLAUDE.md directly** — present the suggestions and let the user decide.

7. **Create config.yaml.** Write `lore/config.yaml` with discovered domains and the standard routing guidance:
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
- Every lore entry must have a traceable source
- If no declarative knowledge is found, say so — don't invent entries
- If the lore directory doesn't exist, tell the user to run `/lore:init` first
