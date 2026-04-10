---
name: capture
description: "Capture domain knowledge into the lore. Use when domain knowledge surfaces in conversation — business rules, entity definitions, architectural decisions, or domain context that should persist."
argument-hint: "[knowledge statement or topic]"
allowed-tools: [Read, Glob, Grep, mcp__lore__lore_write, mcp__lore__lore_read, mcp__lore__lore_search, mcp__lore__lore_query]
---

# Lore Capture

Capture domain knowledge into the lore knowledge base.

## Process

1. **Identify the knowledge.** Either:
   - Use `$ARGUMENTS` if the user provided a knowledge statement
   - Extract from recent conversation context if invoked without arguments

2. **Classify the knowledge.** Determine where it belongs:
   - **Lore entry**: Domain facts, business rules, entity definitions, decisions with rationale, domain vocabulary — anything declarative about how the domain works
   - **CLAUDE.md rule**: Imperative instructions — "always do X", "never do Y", coding conventions
   - **Skill instruction**: Workflow logic, process steps, automation recipes

3. **If it's a lore entry**, determine:
   - **Title**: Clear, descriptive name
   - **Type**: concept, entity, rule, role, decision, or glossary
   - **Domain**: Which subdomain it belongs to (if any)
   - **Confidence**: `verified` if directly stated by the user, `inferred` if derived from code or context
   - **Source**: Where this knowledge came from (e.g., `"human:brainstorming"`, `"codebase:path/to/file"`)

4. **Check for existing entries.** Use `lore_search` to see if this knowledge already exists. If it does:
   - Show the existing entry
   - Ask if this is an update/correction or a separate entry
   - If updating: use `lore_write` to overwrite with the new content

5. **Write the entry.** Use `lore_write` with all required fields. Present the written entry to the user for confirmation.

6. **If it's NOT a lore entry**, explain where it should go instead:
   - CLAUDE.md rules → "This is an imperative instruction. Add it to CLAUDE.md or .claude/rules/"
   - Skill instruction → "This is workflow logic. Create or update a skill definition."

## Important Rules

- Every entry must trace to a source — never invent knowledge
- When the user directly states something, confidence is `verified`
- When derived from code analysis, confidence is `inferred`
- If uncertain about the type, ask the user
