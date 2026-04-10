---
name: resolve
description: "Resolve conflicts in lore entries — git merge conflicts and contradicting claims across pages. Use after merge conflicts in lore/ or when domain inconsistencies are suspected."
argument-hint: ""
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, mcp__lore__lore_read, mcp__lore__lore_write, mcp__lore__lore_list, mcp__lore__lore_search]
---

# Lore Resolve

Scan for and resolve conflicts in the lore knowledge base.

## Process

### Phase 1: Git Merge Conflicts

1. **Scan for conflict markers.** Search all files in `lore/` for git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).

2. **For each conflicted file:**
   - Read the full file content
   - Parse both sides of each conflict
   - If the conflict is structural (frontmatter formatting, whitespace): auto-resolve using the page schema — prefer the version with valid frontmatter
   - If the conflict is semantic (different content claims): present both versions to the user and ask which is correct
   - Write the resolved version using `lore_write`

### Phase 2: Contradicting Claims

3. **Scan for obvious contradictions.** Look for entries that:
   - Share the same entity/concept name but make different claims
   - Have overlapping domains with conflicting rules
   - Use `lore_list` to group entries by domain, then read pairs that might conflict

4. **For each potential contradiction:**
   - Present both entries side by side
   - Highlight the specific claims that appear to conflict
   - Ask the user to confirm which is correct (or if both are valid in different contexts)
   - Update the incorrect entry with corrected content at `confidence: verified`

### Phase 3: Cleanup

5. **Report results.** Summarize:
   - Number of git conflicts resolved
   - Number of contradictions found and resolved
   - Any entries that need human review

## Important Rules

- **Never auto-resolve semantic conflicts** — only structural ones (formatting, whitespace)
- Don't attempt to detect subtle semantic contradictions across the full lore — focus on same-entity/same-domain conflicts
- Updated entries should have source `"resolve:conflict-resolution"` to track provenance
- Never delete entries — update in place with corrected content
