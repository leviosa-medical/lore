// scoring.ts — Pure scoring and content functions extracted for eval harness consumption.

export interface Frontmatter {
  title?: string;
  type?: string;
  domain?: string;
  confidence?: string;
  created?: string;
  updated?: string;
  sources?: string[];
  confirmed_by?: string[];
  tags?: string[];
  derived_entries?: string[];
  source_url?: string;
  source_file?: string;
  [key: string]: string | string[] | undefined;
}

export interface ScoredResult {
  path: string;
  title: string;
  score: number;
  content: string;
  frontmatter: Frontmatter;
}

export function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const arrayMatch = rawValue.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      const inner = arrayMatch[1].trim();
      fields[key] = inner === ""
        ? []
        : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      fields[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
  return fields;
}

export function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)/);
  return match ? match[1].trim() : content.trim();
}

export function buildPage(
  frontmatter: Frontmatter,
  body: string
): string {
  const lines: string[] = ["---"];
  const sanitize = (v: string) => v.replace(/[\n\r]/g, " ").replace(/"/g, '\\"');
  const writeField = (key: string, value: string | string[] | undefined) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => `"${sanitize(v)}"`).join(", ")}]`);
    } else {
      lines.push(`${key}: ${sanitize(value)}`);
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
  if (frontmatter.type === "source") {
    writeField("derived_entries", frontmatter.derived_entries);
    writeField("source_url", frontmatter.source_url);
    writeField("source_file", frontmatter.source_file);
  }

  lines.push("---", "", body, "");
  return lines.join("\n");
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}

export function confidenceBonus(confidence: string | undefined): number {
  if (confidence === "verified") return 0.3;
  if (confidence === "inferred") return 0.15;
  return 0;
}

export function recencyBonus(updated: string | undefined): number {
  if (!updated) return 0;
  const ts = Date.parse(updated);
  if (isNaN(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
  // Half-life decay: up to 0.15 for entries updated today, halves every 180 days
  return 0.15 / (1 + ageDays / 180);
}

export function computeBM25Scores(
  query: string,
  documents: Array<{
    path: string;
    title: string;
    content: string;
    frontmatter: Frontmatter;
  }>,
  k1 = 1.2,
  b = 0.75
): ScoredResult[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const N = documents.length;

  // Tokenize all documents and compute corpus stats
  const docTokens: string[][] = [];
  const docTokenSets: Set<string>[] = [];
  let totalLength = 0;
  for (const doc of documents) {
    const meta = [doc.frontmatter.domain, doc.frontmatter.type, ...(doc.frontmatter.tags || [])].filter(Boolean).join(" ");
    const searchText = doc.title + " " + extractBody(doc.content) + " " + meta;
    const tokens = tokenize(searchText);
    docTokens.push(tokens);
    docTokenSets.push(new Set(tokens));
    totalLength += tokens.length;
  }
  const avgdl = totalLength / N;

  // Compute document frequency per query term
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokenSet of docTokenSets) {
      if (tokenSet.has(term)) count++;
    }
    df.set(term, count);
  }

  // Score each document
  const results: ScoredResult[] = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const tokens = docTokens[i];
    const dl = tokens.length;

    // Count term frequencies
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const termDf = df.get(term) || 0;
      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
      const tf = tfMap.get(term) || 0;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl)));
    }

    if (score > 0) {
      results.push({
        path: doc.path,
        title: doc.title,
        score,
        content: doc.content,
        frontmatter: doc.frontmatter,
      });
    }
  }

  return results;
}

export function extractWikilinks(content: string): string[] {
  // Strip fenced code blocks
  let stripped = content.replace(/^```[\s\S]*?^```/gm, "");
  // Strip inline code
  stripped = stripped.replace(/`[^`]+`/g, "");
  // Extract [[wikilinks]]
  const matches = [...stripped.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  return [...new Set(matches)];
}

export function buildLookupMaps(
  documents: Array<{ path: string; title: string }>
): { titleMap: Map<string, string>; slugMap: Map<string, string> } {
  const titleMap = new Map<string, string>();
  const slugMap = new Map<string, string>();

  // Sort documents by path alphabetically so first encountered wins tiebreaker
  const sorted = [...documents].sort((a, b) => a.path.localeCompare(b.path));

  for (const doc of sorted) {
    const titleKey = doc.title.toLowerCase();
    if (!titleMap.has(titleKey)) {
      titleMap.set(titleKey, doc.path);
    }
    const slug = slugify(doc.title);
    if (!slugMap.has(slug)) {
      slugMap.set(slug, doc.path);
    }
  }

  return { titleMap, slugMap };
}

export function buildInboundCounts(
  documents: Array<{ title: string; content: string }>
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const doc of documents) {
    const body = extractBody(doc.content);
    const links = extractWikilinks(body);
    // Count distinct source pages per target (deduplicate links within a single document)
    const uniqueTargets = new Set(links.map((l) => l.toLowerCase()));
    for (const target of uniqueTargets) {
      counts.set(target, (counts.get(target) || 0) + 1);
    }
  }

  return counts;
}

export function applyLinkBoost(
  results: ScoredResult[],
  inboundCounts: Map<string, number>,
  weight = 0.2
): ScoredResult[] {
  return results.map((r) => {
    const count = inboundCounts.get(r.title.toLowerCase()) || 0;
    return {
      ...r,
      score: r.score * (1 + weight * Math.log(1 + count)),
    };
  });
}
