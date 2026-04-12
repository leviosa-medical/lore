import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  computeBM25Scores,
  decomposeQuery,
  applyConfidenceAndRecency,
  EXPANSION_THRESHOLD,
  EXPANSION_DISCOUNT,
  tokenize,
  applyLinkBoost,
  buildInboundCounts,
  extractWikilinks,
  buildLookupMaps,
  buildWikilinkGraph,
  seededPageRank,
  MAX_EXPANSION,
  findSharedAttributeNeighbors,
  SHARED_ATTR_DISCOUNT,
  SHARED_ATTR_MAX,
  extractQueryMetadataHints,
  applyMetadataHintBoost,
  parseFrontmatter,
  buildPage,
  extractBody,
  slugify,
  HISTORY_MARKER,
  type Frontmatter,
  type ScoredResult,
} from "./scoring.js";

// Lore root: env var, CLI arg, or fallback to ./lore in current working directory
const LORE_PATH =
  process.env.LORE_PATH ||
  process.argv[2] ||
  path.resolve(process.cwd(), "lore");

const PLUGIN_VERSION = "0.6.0";

const VALID_TYPES = [
  "concept",
  "entity",
  "rule",
  "role",
  "decision",
  "glossary",
  "source",
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
  source: "sources",
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

// --- Wikilink Resolution (uses LORE_PATH, stays in server) ---

/** Check that a resolved path is confined within LORE_PATH. */
function isConfinedToLore(resolvedPath: string): boolean {
  const normalized = path.resolve(resolvedPath);
  const loreRoot = path.resolve(LORE_PATH);
  return normalized === loreRoot || normalized.startsWith(loreRoot + path.sep);
}

/** Resolve a wikilink text to a relative file path. Title match → slug match → direct path. */
async function resolveWikilink(
  linkText: string,
  titleMap: Map<string, string>,
  slugMap: Map<string, string>
): Promise<string | null> {
  // 1. Title match (case-insensitive)
  const titlePath = titleMap.get(linkText.toLowerCase());
  if (titlePath) return titlePath;

  // 2. Slug match
  const slug = slugify(linkText);
  const slugPath = slugMap.get(slug);
  if (slugPath) return slugPath;

  // 3. Direct path match (contains / or ends with .md)
  if (linkText.includes("/") || linkText.endsWith(".md")) {
    const directPath = path.join(LORE_PATH, linkText);
    if (!isConfinedToLore(directPath)) return null;
    if (await fileExists(directPath)) {
      return path.relative(LORE_PATH, directPath);
    }
  }

  return null;
}

// --- Server ---

const server = new McpServer({
  name: "lore",
  version: "0.6.0",
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
    // Build lookup maps for wikilink-style resolution
    const allFiles = await findMarkdownFiles(LORE_PATH);
    const documents: Array<{ path: string; title: string }> = [];
    const contentCache = new Map<string, string>();

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      const relPath = path.relative(LORE_PATH, f);
      documents.push({
        path: relPath,
        title: (fm?.title as string) || path.basename(f, ".md"),
      });
      contentCache.set(relPath, content);
    }

    const { titleMap, slugMap } = buildLookupMaps(documents);

    // Resolution chain: title → slug → direct path
    const resolved = await resolveWikilink(page, titleMap, slugMap);
    let filePath: string | null = null;
    let content: string | null = null;

    if (resolved) {
      content = contentCache.get(resolved) || null;
      if (content) filePath = path.join(LORE_PATH, resolved);
    }

    // Fallback: try as explicit relative path (backwards compat)
    if (!content) {
      let tryPath = path.join(LORE_PATH, page);
      if (!page.endsWith(".md")) tryPath += ".md";
      if (isConfinedToLore(tryPath)) {
        content = await readFile(tryPath);
        if (content) filePath = tryPath;
      }
    }

    if (!content || !filePath) {
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
    const keywords = tokenize(query);

    // Load all documents, applying filters
    const documents: Array<{
      path: string;
      title: string;
      content: string;
      frontmatter: Frontmatter;
      updated: string;
    }> = [];

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const pageDomain = fm.domain as string | undefined;
      const pageConfidence = (fm.confidence as string) || "assumed";

      if (domain && pageDomain !== domain) continue;
      if (confidence && pageConfidence !== confidence) continue;

      documents.push({
        path: path.relative(LORE_PATH, f),
        title: (fm.title as string) || path.basename(f, ".md"),
        content,
        frontmatter: fm,
        updated: (fm.updated as string) || "",
      });
    }

    // BM25 scoring
    let scored = computeBM25Scores(query, documents);

    // Inbound link boost
    const inboundCounts = buildInboundCounts(
      documents.map((d) => ({ title: d.title, content: d.content }))
    );
    scored = applyLinkBoost(scored, inboundCounts);

    // Confidence + recency bonus (multiplicative recency, after BM25 + link boost)
    const results = applyConfidenceAndRecency(scored);

    // Sort by score desc, then by updated desc
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aUpdated = (a.frontmatter.updated as string) || "";
      const bUpdated = (b.frontmatter.updated as string) || "";
      return bUpdated.localeCompare(aUpdated);
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
      .map((r, i) => {
        // Extract excerpt around first keyword match
        const lower = r.content.toLowerCase();
        const firstKw = keywords.find((kw) => lower.includes(kw)) || "";
        const idx = lower.indexOf(firstKw);
        const start = Math.max(0, idx - 100);
        const end = Math.min(r.content.length, idx + firstKw.length + 100);
        const excerpt =
          (start > 0 ? "..." : "") +
          r.content.slice(start, end).replace(/\n/g, " ") +
          (end < r.content.length ? "..." : "");

        const conf = r.frontmatter.confidence || "assumed";
        return `${i + 1}. **${r.title}** (${r.path}) [${conf}]\n   ${excerpt}`;
      })
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
        .describe("Entry type: concept, entity, rule, role, decision, glossary, or source"),
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
      derived_entries: z
        .array(z.string())
        .optional()
        .describe("Source pages only. Titles of entries derived from this source"),
      source_url: z
        .string()
        .optional()
        .describe("Source pages only. Original URL of the ingested document"),
      source_file: z
        .string()
        .optional()
        .describe("Source pages only. Original file path of the ingested document"),
      search_keys: z
        .array(z.string())
        .optional()
        .describe("Auto-generated search terms: synonyms, alternative phrasings, and questions this entry answers. Generated by the calling agent, not manually authored."),
      change_note: z
        .string()
        .min(1)
        .optional()
        .describe("Required when updating an existing entry. Describes what changed and why."),
    },
  },
  async ({ title, type, body, confidence, sources, domain, tags, derived_entries, source_url, source_file, search_keys, change_note }) => {
    // Check if page already exists by title
    const existing = await findPageByTitle(title);
    const isUpdate = existing !== null;

    if (isUpdate && !change_note) {
      return {
        content: [
          {
            type: "text" as const,
            text: `change_note is required when updating an existing entry (title already exists: '${title}')`,
          },
        ],
        isError: true,
      };
    }

    let filePath: string;
    let created: string;
    let finalBody = body;

    if (isUpdate) {
      const [existingPath, existingContent] = existing;
      filePath = existingPath;
      const existingFm = parseFrontmatter(existingContent);
      created = (existingFm?.created as string) || today();

      // Build history section
      const existingBody = extractBody(existingContent);
      const historyIdx = existingBody.indexOf(HISTORY_MARKER);
      const newLine = `- **${today()}**: ${change_note}`;

      if (historyIdx !== -1) {
        // Existing history: prepend new note after the heading
        const historyContent = existingBody.slice(historyIdx + HISTORY_MARKER.length).trimStart();
        finalBody = body + HISTORY_MARKER + newLine + "\n" + historyContent;
      } else {
        // No existing history: append new section
        finalBody = body + "\n\n## History\n\n" + newLine;
      }
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
      derived_entries: type === "source" ? derived_entries : undefined,
      source_url: type === "source" ? source_url : undefined,
      source_file: type === "source" ? source_file : undefined,
      search_keys,
    };

    const pageContent = buildPage(frontmatter, finalBody);
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

    // Backlink maintenance: update source pages' derived_entries
    const sourceRefPattern = /^source:(.+)$/;
    for (const src of sources) {
      const match = src.match(sourceRefPattern);
      if (!match) continue;

      const sourceTitle = match[1];
      const sourcePage = await findPageByTitle(sourceTitle);
      if (!sourcePage) continue; // Source page doesn't exist yet, skip silently

      const [sourceFilePath, sourceContent] = sourcePage;
      const sourceFm = parseFrontmatter(sourceContent);
      if (!sourceFm || sourceFm.type !== "source") continue;

      const existing_derived = (sourceFm.derived_entries as string[]) || [];
      if (existing_derived.includes(title)) continue; // Already tracked

      sourceFm.derived_entries = [...existing_derived, title];
      sourceFm.updated = today();
      const sourceBody = extractBody(sourceContent);
      const updatedSourceContent = buildPage(sourceFm, sourceBody);
      await fs.writeFile(sourceFilePath, updatedSourceContent, "utf-8");
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
      type: z.string().optional().describe("Filter by type (concept, entity, rule, role, decision, glossary, source)"),
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
    // Step 1: Load all documents
    const allFiles = await findMarkdownFiles(LORE_PATH);
    if (allFiles.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No lore entries found. Run the install script to set up the lore directory, then /lore:bootstrap to seed initial entries.",
          },
        ],
        isError: true,
      };
    }

    const documents: Array<{
      path: string;
      title: string;
      content: string;
      frontmatter: Frontmatter;
    }> = [];

    for (const f of allFiles) {
      const content = await readFile(f);
      if (!content) continue;
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      documents.push({
        path: path.relative(LORE_PATH, f),
        title: (fm.title as string) || path.basename(f, ".md"),
        content,
        frontmatter: fm,
      });
    }

    // Step 2: BM25 scoring (with query decomposition for compound questions)
    const subQueries = decomposeQuery(question);
    let scored: ScoredResult[];
    if (subQueries.length > 1) {
      const mergedMap = new Map<string, ScoredResult>();
      for (const sq of subQueries) {
        const subResults = computeBM25Scores(sq, documents);
        for (const r of subResults) {
          const existing = mergedMap.get(r.path);
          if (!existing || r.score > existing.score) {
            mergedMap.set(r.path, r);
          }
        }
      }
      scored = [...mergedMap.values()];
    } else {
      scored = computeBM25Scores(question, documents);
    }

    // Step 2.5: Metadata hint boost (applied after BM25, before link boost)
    const metadataHints = extractQueryMetadataHints(question, documents);
    scored = applyMetadataHintBoost(scored, metadataHints);

    // Step 3: Inbound link boost
    const inboundCounts = buildInboundCounts(
      documents.map((d) => ({ title: d.title, content: d.content }))
    );
    scored = applyLinkBoost(scored, inboundCounts);

    // Step 4: Confidence + recency bonus (multiplicative recency)
    const results = applyConfidenceAndRecency(scored);

    // Sort by score desc
    results.sort((a, b) => b.score - a.score);

    // Step 5: PPR-based wikilink expansion
    const maxScore = results.length > 0 ? results[0].score : 0;
    const qualifyingResults = maxScore > 0
      ? results.filter((r) => r.score / maxScore >= EXPANSION_THRESHOLD)
      : [];

    // Build lookup maps and wikilink graph
    const { titleMap, slugMap } = buildLookupMaps(
      documents.map((d) => ({ path: d.path, title: d.title }))
    );
    const wikilinkGraph = buildWikilinkGraph(
      documents.map((d) => ({ path: d.path, content: d.content })),
      titleMap,
      slugMap
    );

    // Seed PPR with qualifying results weighted by BM25 score
    const seeds = new Map<string, number>();
    for (const r of qualifyingResults) {
      seeds.set(r.path, r.score);
    }

    // Run PPR to discover related nodes via forward, reverse, and 2-hop links
    const pprScores = seededPageRank(wikilinkGraph, seeds);

    // Collect paths already present in BM25 results (to avoid score overwrites)
    const existingPaths = new Set(results.map((r) => r.path));

    // Build expansion candidates: top MAX_EXPANSION non-seed, non-existing nodes by PPR score
    const expansionCandidates = Array.from(pprScores.entries())
      .filter(([p]) => !existingPaths.has(p) && !seeds.has(p))
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_EXPANSION);

    // Look up each expansion candidate in the documents array and assign discounted score.
    // Use a flat score of maxScore * EXPANSION_DISCOUNT so expansion candidates are ranked
    // near (but below) the top BM25 results. PPR score is used only for ranking among
    // expansion candidates (handled by the sort above), not to scale their final score.
    // This ensures graph-expanded entries are visible in top-5 results, matching Phase 1 behavior.
    const expansionResults: typeof results = [];
    for (const [candidatePath] of expansionCandidates) {
      const doc = documents.find((d) => d.path === candidatePath);
      if (!doc) continue;
      expansionResults.push({
        ...doc,
        score: maxScore * EXPANSION_DISCOUNT,
      });
    }

    // Step 5b: Shared-attribute expansion
    // Find documents sharing domain+tags with qualifying BM25 results (not already in results)
    const afterPPRPaths = new Set([...results.map((r) => r.path), ...expansionResults.map((r) => r.path)]);
    const sharedAttrNeighbors = findSharedAttributeNeighbors(
      qualifyingResults.map((r) => r.path),
      documents.map((d) => ({ path: d.path, frontmatter: d.frontmatter })),
      afterPPRPaths,
      SHARED_ATTR_MAX
    );

    // Assign score = SHARED_ATTR_DISCOUNT * top qualifying result's score
    const parentScore = qualifyingResults.length > 0 ? qualifyingResults[0].score : 0;
    const sharedAttrResults: typeof results = [];
    for (const neighbor of sharedAttrNeighbors) {
      const doc = documents.find((d) => d.path === neighbor.path);
      if (!doc) continue;
      sharedAttrResults.push({
        ...doc,
        score: SHARED_ATTR_DISCOUNT * parentScore,
      });
    }

    // Merge BM25 results, PPR expansion results, and shared-attribute results sorted by score descending
    let finalResults = [...results, ...expansionResults, ...sharedAttrResults];
    finalResults.sort((a, b) => b.score - a.score);

    // Step 6: Collect top results for output
    const topResults = finalResults.slice(0, 10);

    if (topResults.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No relevant lore entries found for: "${question}"\n\nThe lore may not cover this topic yet. Consider using /lore:capture to add this knowledge, or research the answer and write it back with lore_write.`,
          },
        ],
      };
    }

    // Step 7: Read and concatenate page contents
    const pageContents: string[] = [];
    let totalLength = 0;
    const MAX_TOTAL = 20_000;

    for (const result of topResults) {
      const content = result.content;
      if (totalLength + content.length > MAX_TOTAL) {
        const remaining = MAX_TOTAL - totalLength;
        if (remaining > 500) {
          pageContents.push(
            `\n---\n## ${result.title} (${result.path}) [truncated]\n\n${content.slice(0, remaining)}...`
          );
        }
        break;
      }
      pageContents.push(
        `\n---\n## ${result.title} (${result.path})\n\n${content}`
      );
      totalLength += content.length;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${topResults.length} relevant lore entry/entries for "${question}":\n${pageContents.join("\n")}`,
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
