# Contributing to Lore

## Development setup

```bash
git clone https://github.com/leviosa-medical/lore.git
cd lore
npm install
npm run build
```

Test locally against any project:

```bash
claude --plugin-dir ./
```

After making changes to skills or hooks, run `/reload-plugins` inside Claude Code to pick them up without restarting.

## Build

```bash
npm run build
```

This runs TypeScript compilation followed by esbuild bundling into a single `dist/server.js` file. The MCP server runs from this bundle.

## Project structure

```
lore/
  .claude-plugin/
    plugin.json          # Plugin manifest — name, version, author
  src/
    server.ts            # MCP server — all 5 tools implemented here
  dist/
    server.js            # Built bundle (committed, since users don't run npm install)
  skills/
    init/
      SKILL.md           # /lore:init skill definition
      install.sh         # Shell script that creates lore/ in target projects
    bootstrap/
      SKILL.md           # /lore:bootstrap skill definition
    capture/
      SKILL.md           # /lore:capture skill definition
    resolve/
      SKILL.md           # /lore:resolve skill definition
  hooks/
    hooks.json           # PreToolUse write blocker, Notification retrospective prompt
  .mcp.json              # MCP server configuration
  CLAUDE.md              # Development instructions for the plugin itself
  CHANGELOG.md           # Version history (Keep a Changelog format)
  README.md              # User-facing documentation
```

### Key files

- **`src/server.ts`** — The entire MCP server. Implements `lore_query`, `lore_search`, `lore_read`, `lore_write`, and `lore_list`. Contains BM25 scoring, wikilink parsing, backlink maintenance, and the operations log. This is the only source file.
- **`hooks/hooks.json`** — Three hooks: a PreToolUse hook that blocks direct writes to lore entry files (forcing use of `lore_write`), a PostToolUse hook that enforces CHANGELOG updates on version bumps, and a Notification hook for retrospective prompts.
- **`skills/*/SKILL.md`** — Each skill is a markdown file with YAML frontmatter (`name`, `description`, `allowed-tools`) followed by the skill's instructions. These are prompts, not code — Claude follows the instructions using the allowed tools.

## Architecture

### MCP server

The server is a single TypeScript file (`src/server.ts`) using the `@modelcontextprotocol/sdk` package over stdio transport. It reads and writes markdown files in the `lore/` directory of the target project.

Key internals:
- **BM25 scoring** — Full-text relevance ranking for `lore_search` and `lore_query`. Tokenizes titles and bodies, computes term frequency and inverse document frequency.
- **Inbound link boost** — Pages with more inbound wikilinks score higher. Uses log-dampened link count to prevent runaway scores.
- **1-hop expansion** — When `lore_query` finds fewer than 3 qualifying results, it follows wikilinks from the top results to include neighbor pages.
- **Backlink maintenance** — When `lore_write` creates an entry whose `sources` array references a source page (e.g., `"source:Source - CLAUDE.md"`), it automatically updates that source page's `derived_entries` frontmatter.
- **Operations log** — Every `lore_write` appends a JSON line to `lore/operations.jsonl` for audit.

### Skills

Skills are prompt documents, not executable code. Each `SKILL.md` defines:
- What tools the skill is allowed to use (`allowed-tools` frontmatter)
- Step-by-step instructions Claude follows when the skill is invoked
- Rules and constraints

### Hooks

Hooks are shell commands that run at specific lifecycle points. They're defined in `hooks/hooks.json` and execute deterministically (unlike CLAUDE.md instructions, which are advisory).

## Making changes

### Adding or modifying an MCP tool

1. Edit `src/server.ts`
2. Run `npm run build`
3. Test with `claude --plugin-dir ./`
4. Bump the version in `.claude-plugin/plugin.json` (MINOR for new tools, PATCH for bug fixes)
5. Update `CHANGELOG.md` — the PostToolUse hook will block you if you forget

### Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: skill-name
   description: "What the skill does"
   argument-hint: "[optional arguments hint]"
   allowed-tools: [list, of, allowed, tools]
   ---
   ```
2. Write the skill instructions below the frontmatter
3. Test with `claude --plugin-dir ./` and run `/reload-plugins`
4. Bump the MINOR version and update CHANGELOG

### Modifying hooks

Edit `hooks/hooks.json`. The format follows the Claude Code hooks specification:
- `PreToolUse` hooks run before a tool executes and can block it (exit code 2)
- `PostToolUse` hooks run after a tool executes
- `Notification` hooks run on system notifications (task completion, etc.)

## Versioning

This project uses [Semantic Versioning](https://semver.org/):

- **PATCH** (0.1.x) — Bug fixes, typo corrections
- **MINOR** (0.x.0) — New skills, new MCP tools, new features, non-breaking changes
- **MAJOR** (x.0.0) — Breaking changes to MCP tool schemas, skill renames, or install flow changes

Every PR that changes user-facing behavior must bump the version in `.claude-plugin/plugin.json` and update `CHANGELOG.md`. Documentation-only or internal-only changes don't require a version bump.

The CHANGELOG follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.
