import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Lore root: env var, CLI arg, or fallback to ./lore in current working directory
const LORE_PATH =
  process.env.LORE_PATH ||
  process.argv[2] ||
  path.resolve(process.cwd(), "lore");

const PLUGIN_VERSION = "0.1.0";

const VALID_TYPES = [
  "concept",
  "entity",
  "rule",
  "role",
  "decision",
  "glossary",
] as const;
type LoreType = (typeof VALID_TYPES)[number];

const VALID_CONFIDENCE = ["verified", "inferred", "assumed"] as const;
// VALID_CONFIDENCE used as z.enum() input in lore_write

const TYPE_DIRS: Record<LoreType, string> = {
  concept: "concepts",
  entity: "entities",
  rule: "rules",
  role: "roles",
  decision: "decisions",
  glossary: "glossary",
};

// --- Helpers ---

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md") && entry.name !== "index.md") {
      results.push(full);
    }
  }
  return results;
}

interface Frontmatter {
  title?: string;
  type?: string;
  domain?: string;
  confidence?: string;
  created?: string;
  updated?: string;
  sources?: string[];
  confirmed_by?: string[];
  tags?: string[];
  [key: string]: string | string[] | undefined;
}

function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const arrayMatch = rawValue.match(/^\[(.+)\]$/);
    if (arrayMatch) {
      fields[key] = arrayMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      fields[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
  return fields;
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

function buildPage(
  frontmatter: Frontmatter,
  body: string
): string {
  const lines: string[] = ["---"];
  const writeField = (key: string, value: string | string[] | undefined) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${v}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  };

  writeField("title", frontmatter.title);
  writeField("type", frontmatter.type);
  writeField("domain", frontmatter.domain);
  writeField("confidence", frontmatter.confidence);
  writeField("created", frontmatter.created);
  writeField("updated", frontmatter.updated);
  writeField("sources", frontmatter.sources);
  writeField("confirmed_by", frontmatter.confirmed_by);
  writeField("tags", frontmatter.tags);

  lines.push("---", "", body, "");
  return lines.join("\n");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function appendOperation(record: Record<string, unknown>): Promise<void> {
  const logPath = path.join(LORE_PATH, "operations.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  await fs.appendFile(logPath, line, "utf-8");
}

/** Find an existing page by title (case-insensitive). Returns [filePath, content] or null. */
async function findPageByTitle(
  title: string
): Promise<[string, string] | null> {
  const allFiles = await findMarkdownFiles(LORE_PATH);
  const titleLower = title.toLowerCase();
  for (const f of allFiles) {
    const content = await readFile(f);
    if (!content) continue;
    const fm = parseFrontmatter(content);
    if (
      fm &&
      typeof fm.title === "string" &&
      fm.title.toLowerCase() === titleLower
    ) {
      return [f, content];
    }
  }
  return null;
}

/** Confidence bonus for ranking: verified > inferred > assumed. */
function confidenceBonus(confidence: string | undefined): number {
  if (confidence === "verified") return 0.3;
  if (confidence === "inferred") return 0.15;
  return 0;
}

// --- Server ---

const server = new McpServer({
  name: "lore",
  version: "0.1.0",
});

/**
 * lore_read — Read a specific lore page by title or path.
 */
server.registerTool(
  "lore_read",
  {
    description:
      "Read a lore page by title or relative path (e.g. 'Lease Termination Rules' or 'rules/lease-termination.md'). Returns full page content including frontmatter.",
    inputSchema: {
      page: z.string().describe("Page title or relative path within lore/"),
    },
  },
  async ({ page }) => {
    // Try exact relative path first
    let filePath = path.join(LORE_PATH, page);
    if (!page.endsWith(".md")) filePath += ".md";

    let content = await readFile(filePath);

    // If not found by path, search by title
    if (!content) {
      const found = await findPageByTitle(page);
      if (found) {
        [filePath, content] = found;
      }
    }

    if (!content) {
      return {
        content: [{ type: "text" as const, text: `Page not found: ${page}` }],
        isError: true,
      };
    }

    const rel = path.relative(LORE_PATH, filePath);
    return {
      content: [{ type: "text" as const, text: `# ${rel}\n\n${content}` }],
    };
  }
);

/**
 * lore_search — Keyword search across all lore pages with confidence-aware ranking.
 */
server.registerTool(
  "lore_search",
  {
    description:
      "Search lore pages by keyword with confidence-aware ranking. Verified entries rank higher on equal relevance. Use for browsing/filtering; use lore_query for answering domain questions.",
    inputSchema: {
      query: z.string().describe("Search term or phrase"),
      domain: z.string().optional().describe("Filter by domain"),
      confidence: z.string().optional().describe("Filter by confidence level"),
      max_results: z
        .number()
        .optional()
        .describe("Maximum results to return (default 10)"),
    },
  },
  async ({ query, domain, confidence, max_results }) => {
    const limit = max_results ?? 10;
    const allFiles = await findMarkdownFiles(LORE_PATH);
    const keywords = query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

    const results: {
      title: string;
      path: string;
      confidence: string;
      excerpt: string;
      score: number;
      updated: string;
    }[] = [];

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const pageTitle = (fm.title as string) || path.basename(f, ".md");
      const pageDomain = fm.domain as string | undefined;
      const pageConfidence = (fm.confidence as string) || "assumed";
      const pageUpdated = (fm.updated as string) || "";

      // Apply filters
      if (domain && pageDomain !== domain) continue;
      if (confidence && pageConfidence !== confidence) continue;

      // Score: keyword match proportion in title + body
      const searchText = (pageTitle + " " + extractBody(content)).toLowerCase();
      const matchCount = keywords.filter((kw) =>
        searchText.includes(kw)
      ).length;
      if (matchCount === 0) continue;

      const keywordScore = matchCount / keywords.length;
      const score = keywordScore + confidenceBonus(pageConfidence);

      // Extract excerpt around first match
      const lower = content.toLowerCase();
      const firstKw = keywords.find((kw) => lower.includes(kw)) || "";
      const idx = lower.indexOf(firstKw);
      const start = Math.max(0, idx - 100);
      const end = Math.min(content.length, idx + firstKw.length + 100);
      const excerpt =
        (start > 0 ? "..." : "") +
        content.slice(start, end).replace(/\n/g, " ") +
        (end < content.length ? "..." : "");

      results.push({
        title: pageTitle,
        path: path.relative(LORE_PATH, f),
        confidence: pageConfidence,
        excerpt,
        score,
        updated: pageUpdated,
      });
    }

    // Sort by score desc, then by updated desc
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.updated.localeCompare(a.updated);
    });

    const top = results.slice(0, limit);

    if (top.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No results found for: "${query}"`,
          },
        ],
      };
    }

    const text = top
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}** (${r.path}) [${r.confidence}]\n   ${r.excerpt}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${top.length} result(s) for "${query}":\n\n${text}`,
        },
      ],
    };
  }
);

/**
 * lore_write — Create or update a lore entry.
 */
server.registerTool(
  "lore_write",
  {
    description:
      "Create or update a lore entry. Validates required fields, updates index.md, and appends to operations.jsonl. An existing entry matched by title (case-insensitive) is overwritten at its current path.",
    inputSchema: {
      title: z.string().describe("Page title"),
      type: z
        .enum(VALID_TYPES)
        .describe("Entry type: concept, entity, rule, role, decision, or glossary"),
      body: z.string().describe("Markdown content (no frontmatter)"),
      confidence: z
        .enum(VALID_CONFIDENCE)
        .describe("Confidence level: verified, inferred, or assumed"),
      sources: z
        .array(z.string())
        .min(1)
        .describe(
          'What informed this entry (e.g. "human:brainstorming", "codebase:src/models/lease.ts")'
        ),
      domain: z.string().optional().describe("Subdomain (e.g. billing, tenants)"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
    },
  },
  async ({ title, type, body, confidence, sources, domain, tags }) => {
    // Check if page already exists by title
    const existing = await findPageByTitle(title);
    const isUpdate = existing !== null;

    let filePath: string;
    let created: string;

    if (isUpdate) {
      const [existingPath, existingContent] = existing;
      filePath = existingPath;
      const existingFm = parseFrontmatter(existingContent);
      created = (existingFm?.created as string) || today();
    } else {
      const dir = path.join(LORE_PATH, TYPE_DIRS[type]);
      await fs.mkdir(dir, { recursive: true });
      filePath = path.join(dir, `${slugify(title)}.md`);
      created = today();
    }

    const frontmatter: Frontmatter = {
      title,
      type,
      domain,
      confidence,
      created,
      updated: today(),
      sources,
      tags,
    };

    const pageContent = buildPage(frontmatter, body);
    await fs.writeFile(filePath, pageContent, "utf-8");

    const rel = path.relative(LORE_PATH, filePath);

    // Update index.md if new page
    if (!isUpdate) {
      const indexPath = path.join(LORE_PATH, "index.md");
      const indexContent = await readFile(indexPath);
      if (indexContent) {
        // Find the section for this type and append
        const sectionHeader = `## ${type.charAt(0).toUpperCase() + type.slice(1)}`;
        const entry = `- [[${title}]] (${rel})`;

        if (indexContent.includes(sectionHeader)) {
          // Append after the section header (find next section or end)
          const headerIdx = indexContent.indexOf(sectionHeader);
          const afterHeader = headerIdx + sectionHeader.length;
          // Find the next ## or end of file
          const nextSection = indexContent.indexOf("\n## ", afterHeader);
          const insertAt = nextSection === -1 ? indexContent.length : nextSection;
          const updated =
            indexContent.slice(0, insertAt).trimEnd() +
            "\n" +
            entry +
            "\n" +
            (nextSection === -1 ? "" : "\n" + indexContent.slice(insertAt + 1));
          await fs.writeFile(indexPath, updated, "utf-8");
        } else {
          // Section doesn't exist, append at end
          await fs.appendFile(
            indexPath,
            `\n${sectionHeader}\n\n${entry}\n`,
            "utf-8"
          );
        }
      }
    }

    // Append operation
    await appendOperation({
      op: isUpdate ? "update" : "write",
      page: rel,
      confidence,
      source: sources[0],
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `${isUpdate ? "Updated" : "Created"}: ${rel}`,
        },
      ],
    };
  }
);

/**
 * lore_list — Browse lore contents filtered by type, domain, confidence, or tag.
 */
server.registerTool(
  "lore_list",
  {
    description:
      "Browse lore entries filtered by type, domain, confidence, or tag. Returns title, type, domain, and confidence for each match.",
    inputSchema: {
      type: z.string().optional().describe("Filter by type (concept, entity, rule, role, decision, glossary)"),
      domain: z.string().optional().describe("Filter by domain"),
      confidence: z.string().optional().describe("Filter by confidence (verified, inferred, assumed)"),
      tag: z.string().optional().describe("Filter by tag"),
    },
  },
  async ({ type, domain, confidence, tag }) => {
    const allFiles = await findMarkdownFiles(LORE_PATH);
    const pages: {
      title: string;
      path: string;
      type?: string;
      domain?: string;
      confidence?: string;
    }[] = [];

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const pageType = fm.type as string | undefined;
      const pageDomain = fm.domain as string | undefined;
      const pageConfidence = fm.confidence as string | undefined;
      const pageTags = fm.tags as string[] | undefined;
      const title = (fm.title as string) || path.basename(f, ".md");

      if (type && pageType !== type) continue;
      if (domain && pageDomain !== domain) continue;
      if (confidence && pageConfidence !== confidence) continue;
      if (tag && (!pageTags || !pageTags.includes(tag))) continue;

      pages.push({
        title,
        path: path.relative(LORE_PATH, f),
        type: pageType,
        domain: pageDomain,
        confidence: pageConfidence,
      });
    }

    pages.sort((a, b) => a.title.localeCompare(b.title));

    if (pages.length === 0) {
      const filters = [
        type && `type=${type}`,
        domain && `domain=${domain}`,
        confidence && `confidence=${confidence}`,
        tag && `tag=${tag}`,
      ]
        .filter(Boolean)
        .join(", ");

      let text = `No entries found${filters ? ` matching ${filters}` : ""}.`;
      if (pages.length === 0 && !type && !domain && !confidence && !tag) {
        text += "\n\nThe lore is empty. Run /lore:bootstrap to seed from existing artifacts, or /lore:capture to add entries manually.";
      }
      return { content: [{ type: "text" as const, text }] };
    }

    const text = pages
      .map((p) => {
        const meta = [p.type, p.domain, p.confidence].filter(Boolean).join(", ");
        return `- **${p.title}** (${p.path})${meta ? ` [${meta}]` : ""}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${pages.length} entry/entries:\n\n${text}`,
        },
      ],
    };
  }
);

/**
 * lore_query — Natural language question routed through index + full-text search.
 * Returns relevant page contents for the agent to synthesize.
 */
server.registerTool(
  "lore_query",
  {
    description:
      "Query the lore knowledge base with a natural language question. Reads the index, finds relevant pages by keyword scoring, and returns their full content for the agent to synthesize. This is the primary tool for answering domain questions.",
    inputSchema: {
      question: z.string().describe("The domain question to look up"),
    },
  },
  async ({ question }) => {
    // Step 1: Read the index
    const indexPath = path.join(LORE_PATH, "index.md");
    const indexContent = await readFile(indexPath);

    if (!indexContent) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No lore index found. Run the install script to set up the lore directory, then /lore:bootstrap to seed initial entries.",
          },
        ],
        isError: true,
      };
    }

    const keywords = question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);

    // Step 2: Score index entries by keyword overlap
    const wikilinks = [...indexContent.matchAll(/\[\[([^\]]+)\]\]/g)].map(
      (m) => m[1]
    );

    const scored = wikilinks.map((title) => {
      const titleLower = title.toLowerCase();
      const score = keywords.filter((kw) => titleLower.includes(kw)).length;
      return { title, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const relevant = scored.filter((s) => s.score > 0).slice(0, 5);

    // Step 3: Full-text search for broader matches
    const allFiles = await findMarkdownFiles(LORE_PATH);
    const textMatches: {
      title: string;
      filePath: string;
      score: number;
      confidence: string;
    }[] = [];

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      const title = (fm?.title as string) || path.basename(f, ".md");

      // Skip if already in relevant from index
      if (relevant.some((r) => r.title === title)) continue;

      // Count keyword hits in content
      const searchText = (title + " " + content).toLowerCase();
      let matchCount = 0;
      for (const kw of keywords) {
        if (searchText.includes(kw)) matchCount++;
      }

      if (matchCount > 0) {
        const confidence = (fm?.confidence as string) || "assumed";
        const score = matchCount / keywords.length + confidenceBonus(confidence);
        textMatches.push({ title, filePath: f, score, confidence });
      }
    }

    textMatches.sort((a, b) => b.score - a.score);
    const additionalPages = textMatches.slice(0, 3);

    // Step 4: Read and concatenate relevant pages
    const pageTitles = [
      ...relevant.map((r) => r.title),
      ...additionalPages.map((r) => r.title),
    ];

    if (pageTitles.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No relevant lore entries found for: "${question}"\n\nThe lore may not cover this topic yet. Consider using /lore:capture to add this knowledge, or research the answer and write it back with lore_write.`,
          },
        ],
      };
    }

    const pageContents: string[] = [];
    let totalLength = 0;
    const MAX_TOTAL = 20_000;

    for (const title of pageTitles) {
      let content: string | null = null;
      let foundPath = "";

      for (const f of allFiles) {
        const c = await readFile(f);
        if (!c) continue;
        const fm = parseFrontmatter(c);
        if (fm && typeof fm.title === "string" && fm.title === title) {
          content = c;
          foundPath = path.relative(LORE_PATH, f);
          break;
        }
      }

      if (content) {
        if (totalLength + content.length > MAX_TOTAL) {
          const remaining = MAX_TOTAL - totalLength;
          if (remaining > 500) {
            pageContents.push(
              `\n---\n## ${title} (${foundPath}) [truncated]\n\n${content.slice(0, remaining)}...`
            );
          }
          break;
        }
        pageContents.push(`\n---\n## ${title} (${foundPath})\n\n${content}`);
        totalLength += content.length;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${pageTitles.length} relevant lore entry/entries for "${question}":\n${pageContents.join("\n")}`,
        },
      ],
    };
  }
);

// --- Start ---

async function main() {
  if (!(await fileExists(LORE_PATH))) {
    process.stderr.write(
      `Lore path not found: ${LORE_PATH}\nRun the install script first: bash <plugin-root>/bin/install.sh\n`
    );
    process.exit(1);
  }

  const indexExists = await fileExists(path.join(LORE_PATH, "index.md"));
  process.stderr.write(
    `lore MCP server v${PLUGIN_VERSION} starting. Lore: ${LORE_PATH} (index: ${indexExists ? "found" : "missing"})\n`
  );

  // Check installed version
  const versionFile = path.join(LORE_PATH, ".lore-version");
  const installedVersion = (await readFile(versionFile))?.trim();
  if (installedVersion && installedVersion !== PLUGIN_VERSION) {
    process.stderr.write(
      `WARNING: Lore installed at v${installedVersion} but plugin is v${PLUGIN_VERSION}. Run install.sh to upgrade.\n`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("lore MCP server connected.\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
