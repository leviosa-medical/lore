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
  search_keys?: string[];
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

export const HISTORY_MARKER = "\n## History\n";

/**
 * Returns the body text with the ## History section stripped for BM25 indexing.
 * Known limitation: if the body starts exactly with "## History\n" (no preceding
 * newline), HISTORY_MARKER will not match because it begins with "\n". In practice,
 * buildPage always places body content before the history section.
 */
export function extractSearchableBody(content: string): string {
  const body = extractBody(content);
  const idx = body.indexOf(HISTORY_MARKER);
  if (idx === -1) return body;
  return body.slice(0, idx).trim();
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
  writeField("search_keys", frontmatter.search_keys);
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
  const lower = text.toLowerCase();
  // Preserve hyphenated compound terms (e.g., "invoice-processing-42") as single
  // tokens alongside the individual words. Compound tokens have very low document
  // frequency, giving them high IDF — critical for matching unique key terms that
  // BM25 would otherwise dilute into common component words.
  const compounds = lower.match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) || [];
  const words = lower.split(/\W+/).filter((w) => w.length > 2);
  return [...words, ...compounds];
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
  // Half-life decay: up to 0.5 for entries updated today, halves every 90 days
  return 0.5 / (1 + ageDays / 90);
}

export const EXPANSION_THRESHOLD = 0.2;
export const EXPANSION_DISCOUNT = 0.85;

export function applyConfidenceAndRecency(results: ScoredResult[]): ScoredResult[] {
  return results.map((r) => ({
    ...r,
    score: (r.score + confidenceBonus(r.frontmatter.confidence)) * (1 + recencyBonus(r.frontmatter.updated as string)),
  }));
}

export function decomposeQuery(query: string): string[] {
  // Only split on compound-question patterns, not casual "and" conjunctions
  const parts = query.split(/\band\s+(?:what|how|who|where|when|why|which)\b|[?;]/).map(s => s.trim()).filter(s => s.length > 15);
  if (parts.length >= 2) return parts;
  return [query];
}

export const METADATA_WEIGHT = 2.0;

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

  // Tokenize all documents with separate body and metadata passes
  const bodyTokensArr: string[][] = [];
  const metaTokensArr: string[][] = [];
  const allTokenSets: Set<string>[] = [];
  let totalLength = 0;
  for (const doc of documents) {
    const metaText = [doc.frontmatter.domain, doc.frontmatter.type, ...(doc.frontmatter.tags || [])].filter(Boolean).join(" ");
    const searchKeys = Array.isArray(doc.frontmatter.search_keys) ? doc.frontmatter.search_keys.join(" ") : "";
    const bodyText = doc.title + " " + extractSearchableBody(doc.content) + " " + searchKeys;
    const bodyTokens = tokenize(bodyText);
    const metaTokens = tokenize(metaText);
    const allTokens = [...bodyTokens, ...metaTokens];
    bodyTokensArr.push(bodyTokens);
    metaTokensArr.push(metaTokens);
    allTokenSets.push(new Set(allTokens));
    totalLength += allTokens.length;
  }
  const avgdl = totalLength / N;

  // Compute document frequency per query term
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokenSet of allTokenSets) {
      if (tokenSet.has(term)) count++;
    }
    df.set(term, count);
  }

  // Score each document
  const results: ScoredResult[] = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const bodyTokens = bodyTokensArr[i];
    const metaTokens = metaTokensArr[i];
    const dl = bodyTokens.length + metaTokens.length;

    // Weighted term frequencies: body=1.0, metadata=METADATA_WEIGHT
    const tfMap = new Map<string, number>();
    for (const token of bodyTokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }
    for (const token of metaTokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + METADATA_WEIGHT);
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

export interface GraphEdge {
  source: string; // relative path
  target: string; // relative path
}

export function buildWikilinkGraph(
  documents: Array<{ path: string; content: string; title?: string }>,
  titleMap: Map<string, string>,
  slugMap: Map<string, string>
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  // Initialize all document paths with empty sets (so isolated nodes exist)
  for (const doc of documents) {
    graph.set(doc.path, new Set<string>());
  }

  for (const doc of documents) {
    const body = extractBody(doc.content);
    const linkTexts = extractWikilinks(body);

    for (const linkText of linkTexts) {
      // Try to resolve via titleMap (case-insensitive)
      let resolvedPath = titleMap.get(linkText.toLowerCase());

      // Fall back to slugMap
      if (!resolvedPath) {
        resolvedPath = slugMap.get(slugify(linkText));
      }

      if (!resolvedPath) continue;

      // Add bidirectional edges
      graph.get(doc.path)!.add(resolvedPath);

      // Ensure the target node exists in the graph (may be an isolated node added above)
      if (!graph.has(resolvedPath)) {
        graph.set(resolvedPath, new Set<string>());
      }
      graph.get(resolvedPath)!.add(doc.path);
    }
  }

  return graph;
}

export const PPR_ALPHA = 0.85;
export const PPR_ITERATIONS = 20;
export const PPR_MIN_SCORE = 0.001;
export const MAX_EXPANSION = 5;

export const SHARED_ATTR_DISCOUNT = 0.7;
export const SHARED_ATTR_MAX = 3;

export function seededPageRank(
  graph: Map<string, Set<string>>,
  seeds: Map<string, number>,
  alpha: number = PPR_ALPHA,
  iterations: number = PPR_ITERATIONS,
  minScore: number = PPR_MIN_SCORE
): Map<string, number> {
  if (graph.size === 0 || seeds.size === 0) return new Map<string, number>();

  // Normalize seed scores to sum=1
  let seedTotal = 0;
  for (const v of seeds.values()) seedTotal += v;
  const seedVec = new Map<string, number>();
  for (const [path, v] of seeds) {
    seedVec.set(path, v / seedTotal);
  }

  // Initialize scores from seedVec
  const scores = new Map<string, number>(seedVec);

  // Collect all nodes present as keys in graph
  const allNodes = Array.from(graph.keys());

  for (let iter = 0; iter < iterations; iter++) {
    const nextScores = new Map<string, number>();

    // Teleportation term: (1 - alpha) * seed[node]
    for (const node of allNodes) {
      nextScores.set(node, (1 - alpha) * (seedVec.get(node) || 0));
    }

    // Propagation: distribute alpha * scores[node] / degree to each neighbor
    for (const node of allNodes) {
      const nodeScore = scores.get(node) || 0;
      const neighbors = graph.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      const degree = neighbors.size;
      const contribution = (alpha * nodeScore) / degree;
      for (const neighbor of neighbors) {
        nextScores.set(neighbor, (nextScores.get(neighbor) || 0) + contribution);
      }
    }

    // Update scores
    for (const [node, score] of nextScores) {
      scores.set(node, score);
    }
  }

  // Return non-seed nodes with score >= minScore
  const result = new Map<string, number>();
  for (const [path, score] of scores) {
    if (!seeds.has(path) && score >= minScore) {
      result.set(path, score);
    }
  }

  return result;
}

/**
 * Find documents that share domain+tags attributes with seed documents.
 * Returns candidates sharing at least (domain + 1 tag) or (2+ tags without domain match),
 * sorted by number of shared attributes descending, then path alphabetically as tie-breaker.
 */
export const METADATA_HINT_BOOST = 1.5;
export const METADATA_HINT_STOPLIST = ['concept', 'entry', 'note', 'guide', 'item', 'record'];

/**
 * Extracts domain and type hints from a query by matching query tokens against
 * known domain/type values in the corpus. Values in the stoplist or with
 * length <= 2 are excluded from matching.
 */
export function extractQueryMetadataHints(
  query: string,
  documents: Array<{ frontmatter: Frontmatter }>
): { domains: string[]; types: string[] } {
  // Collect all unique domain and type values from documents
  const allDomains = new Set<string>();
  const allTypes = new Set<string>();

  for (const doc of documents) {
    if (doc.frontmatter.domain) allDomains.add(doc.frontmatter.domain);
    if (doc.frontmatter.type) allTypes.add(doc.frontmatter.type);
  }

  // Filter out values with length <= 2 and values in the stoplist
  const stoplistLower = METADATA_HINT_STOPLIST.map((s) => s.toLowerCase());
  const filterValue = (value: string): boolean => {
    if (value.length <= 2) return false;
    if (stoplistLower.includes(value.toLowerCase())) return false;
    return true;
  };

  const candidateDomains = [...allDomains].filter(filterValue);
  const candidateTypes = [...allTypes].filter(filterValue);

  // Tokenize the query (lowercase, split on whitespace)
  const queryTokens = query.toLowerCase().split(/\s+/);

  // Check which domain/type values appear as tokens in the query
  const matchedDomains = candidateDomains.filter((domain) =>
    queryTokens.includes(domain.toLowerCase())
  );
  const matchedTypes = candidateTypes.filter((type) =>
    queryTokens.includes(type.toLowerCase())
  );

  return { domains: matchedDomains, types: matchedTypes };
}

/**
 * Applies a score multiplier (METADATA_HINT_BOOST) to results whose domain or
 * type matches the extracted query hints. Returns results unchanged if hints are empty.
 */
export function applyMetadataHintBoost(
  results: ScoredResult[],
  hints: { domains: string[]; types: string[] }
): ScoredResult[] {
  if (hints.domains.length === 0 && hints.types.length === 0) return results;

  const domainSet = new Set(hints.domains);
  const typeSet = new Set(hints.types);

  return results.map((r) => {
    const domainMatch = r.frontmatter.domain !== undefined && domainSet.has(r.frontmatter.domain);
    const typeMatch = r.frontmatter.type !== undefined && typeSet.has(r.frontmatter.type);
    if (domainMatch || typeMatch) {
      return { ...r, score: r.score * METADATA_HINT_BOOST };
    }
    return r;
  });
}

export function findSharedAttributeNeighbors(
  seedPaths: string[],
  documents: Array<{ path: string; frontmatter: Frontmatter }>,
  excludePaths: Set<string>,
  maxResults: number = SHARED_ATTR_MAX
): Array<{ path: string; sharedAttributes: string[] }> {
  if (seedPaths.length === 0 || documents.length === 0) return [];

  const seedPathSet = new Set(seedPaths);

  // Build seed attribute collections (domain and tags per seed)
  const seedDomains = new Set<string>();
  const seedTags = new Set<string>();

  for (const seedPath of seedPaths) {
    const seedDoc = documents.find((d) => d.path === seedPath);
    if (!seedDoc) continue;
    const fm = seedDoc.frontmatter;
    if (fm.domain) seedDomains.add(fm.domain);
    if (fm.tags) {
      for (const tag of fm.tags) seedTags.add(tag);
    }
  }

  // For each non-excluded, non-seed document, compute shared attributes
  const candidates: Array<{ path: string; sharedAttributes: string[]; count: number }> = [];

  for (const doc of documents) {
    if (seedPathSet.has(doc.path) || excludePaths.has(doc.path)) continue;

    const fm = doc.frontmatter;
    const sharedAttrs: string[] = [];

    // Check domain match
    const hasDomainMatch = fm.domain !== undefined && seedDomains.has(fm.domain);
    if (hasDomainMatch && fm.domain) {
      sharedAttrs.push(`domain:${fm.domain}`);
    }

    // Check tag overlap
    if (fm.tags) {
      for (const tag of fm.tags) {
        if (seedTags.has(tag)) {
          sharedAttrs.push(`tag:${tag}`);
        }
      }
    }

    // Count shared tags (exclude the domain entry from sharedAttrs for tag-count purposes)
    const sharedTagCount = sharedAttrs.filter((a) => a.startsWith("tag:")).length;

    // Require: (domain match AND 1+ shared tag) OR (2+ shared tags without domain match)
    const meetsThreshold =
      (hasDomainMatch && sharedTagCount >= 1) ||
      (!hasDomainMatch && sharedTagCount >= 2);

    if (meetsThreshold) {
      candidates.push({ path: doc.path, sharedAttributes: sharedAttrs, count: sharedAttrs.length });
    }
  }

  // Sort by shared count descending, then path alphabetically as deterministic tie-breaker
  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.path.localeCompare(b.path);
  });

  return candidates.slice(0, maxResults).map((c) => ({
    path: c.path,
    sharedAttributes: c.sharedAttributes,
  }));
}
