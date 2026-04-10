---
name: init
description: "Set up lore in the current project. Creates the lore/ directory structure, agent rule, and project settings."
argument-hint: ""
allowed-tools: [Bash]
---

# Lore Init

Set up the lore plugin in the current project by running the install script.

## Process

1. Run the install script bundled with this plugin:
   ```bash
   bash "${CLAUDE_SKILL_DIR}/install.sh"
   ```

2. Report what was created and suggest running `/lore:bootstrap` next to seed initial knowledge.
