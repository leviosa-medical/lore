#!/usr/bin/env bash
set -euo pipefail

# install.sh — Set up the lore/ directory structure in the target project
# and add the agent integration rule.
#
# Usage: bash <path-to-lore-plugin>/bin/install.sh [project-root]
#   project-root defaults to current working directory

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_VERSION=$(grep '"version"' "$SCRIPT_DIR/.claude-plugin/plugin.json" | sed 's/.*: *"\(.*\)".*/\1/')

PROJECT_ROOT="${1:-$(pwd)}"
LORE_DIR="$PROJECT_ROOT/lore"
RULE_DIR="$PROJECT_ROOT/.claude/rules"
RULE_FILE="$RULE_DIR/lore.md"
VERSION_FILE="$LORE_DIR/.lore-version"

echo "Lore plugin installer (v$PLUGIN_VERSION)"
echo "Project root: $PROJECT_ROOT"
echo ""

# --- Check for existing version ---

if [ -f "$VERSION_FILE" ]; then
  INSTALLED_VERSION=$(cat "$VERSION_FILE")
  if [ "$INSTALLED_VERSION" = "$PLUGIN_VERSION" ]; then
    echo "Already at v$PLUGIN_VERSION — updating rule file only."
  else
    echo "Upgrading: v$INSTALLED_VERSION -> v$PLUGIN_VERSION"
  fi
fi

# --- Create lore directory structure ---

if [ -d "$LORE_DIR" ]; then
  echo "lore/ directory already exists — skipping directory creation."
  echo "Existing lore content will not be modified."
else
  echo "Creating lore/ directory structure..."

  mkdir -p "$LORE_DIR/concepts"
  mkdir -p "$LORE_DIR/entities"
  mkdir -p "$LORE_DIR/rules"
  mkdir -p "$LORE_DIR/roles"
  mkdir -p "$LORE_DIR/decisions"
  mkdir -p "$LORE_DIR/glossary"

  # Create index.md with type section headers
  cat > "$LORE_DIR/index.md" << 'INDEXEOF'
# Lore Index

## Concept

## Entity

## Rule

## Role

## Decision

## Glossary
INDEXEOF

  # Create empty operations log
  touch "$LORE_DIR/operations.jsonl"

  # Create config.yaml with placeholder
  cat > "$LORE_DIR/config.yaml" << 'CONFIGEOF'
domains: []
routing:
  lore: "Declaratives: 'the system works like X because Y', domain context"
  claude_md: "Imperatives: 'always do X', 'never do Y', conventions"
  skills: "Workflow logic, process instructions"
CONFIGEOF

  echo "Created: lore/ with subdirectories, index.md, operations.jsonl, config.yaml"
fi

# --- Add marketplace and plugin to project settings ---

SETTINGS_DIR="$PROJECT_ROOT/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

mkdir -p "$SETTINGS_DIR"

node -e "
  const fs = require('fs');
  const f = '$SETTINGS_FILE';
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  s.extraKnownMarketplaces ??= {};
  s.extraKnownMarketplaces.lore ??= { source: 'github', repo: 'leviosa-medical/lore' };
  s.enabledPlugins ??= {};
  s.enabledPlugins['lore@lore'] ??= true;
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"

echo "Updated: .claude/settings.json (marketplace + plugin enabled)"

# --- Add agent integration rule ---

mkdir -p "$RULE_DIR"

cat > "$RULE_FILE" << 'RULEEOF'
# Lore — Domain Knowledge Integration

When answering ANY question about domain concepts, business rules, stakeholder intent, product vision, or how the system works — ALWAYS call `lore_query` first, even if you think you already know the answer from CLAUDE.md or other context. CLAUDE.md contains coding conventions and imperatives; the lore contains richer domain knowledge that CLAUDE.md does not capture.

This is not optional. Do not skip lore queries because the answer seems obvious from files already in context.

After querying lore, present lore-sourced context as explicit assumptions:
"Based on the lore, I'm working with these assumptions: [list]. Flag if any are wrong."

If the lore has no answer, research it (ask the human or read the codebase), then write it back using `lore_write` with:
- `confidence: inferred` for codebase-derived knowledge
- `confidence: verified` for human-provided knowledge
RULEEOF

echo "Created: .claude/rules/lore.md (agent integration rule)"

# --- Stamp version ---

echo "$PLUGIN_VERSION" > "$VERSION_FILE"

echo ""
echo "Done. Lore v$PLUGIN_VERSION installed."
echo ""
echo "Next steps:"
echo "  1. Run /lore:bootstrap to seed from existing CLAUDE.md and docs"
echo "  2. The lore/ directory is ready for version control"
