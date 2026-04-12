// scoring.ts — Pure scoring and content functions extracted for eval harness consumption.
export function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return null;
    const fields = {};
    for (const line of match[1].split("\n")) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
        if (!kv)
            continue;
        const [, key, rawValue] = kv;
        const arrayMatch = rawValue.match(/^\[(.*)\]$/);
        if (arrayMatch) {
            const inner = arrayMatch[1].trim();
            fields[key] = inner === ""
                ? []
                : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        }
        else {
            fields[key] = rawValue.replace(/^["']|["']$/g, "");
        }
    }
    return fields;
}
export function extractBody(content) {
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
export function extractSearchableBody(content) {
    const body = extractBody(content);
    const idx = body.indexOf(HISTORY_MARKER);
    if (idx === -1)
        return body;
    return body.slice(0, idx).trim();
}
export function buildPage(frontmatter, body) {
    const lines = ["---"];
    const sanitize = (v) => v.replace(/[\n\r]/g, " ").replace(/"/g, '\\"');
    const writeField = (key, value) => {
        if (value === undefined)
            return;
        if (Array.isArray(value)) {
            lines.push(`${key}: [${value.map((v) => `"${sanitize(v)}"`).join(", ")}]`);
        }
        else {
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
export function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
export function tokenize(text) {
    const lower = text.toLowerCase();
    // Preserve hyphenated compound terms (e.g., "invoice-processing-42") as single
    // tokens alongside the individual words. Compound tokens have very low document
    // frequency, giving them high IDF — critical for matching unique key terms that
    // BM25 would otherwise dilute into common component words.
    const compounds = lower.match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) || [];
    const words = lower.split(/\W+/).filter((w) => w.length > 2);
    return [...words, ...compounds];
}
export function confidenceBonus(confidence) {
    if (confidence === "verified")
        return 0.3;
    if (confidence === "inferred")
        return 0.15;
    return 0;
}
export function recencyBonus(updated) {
    if (!updated)
        return 0;
    const ts = Date.parse(updated);
    if (isNaN(ts))
        return 0;
    const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
    // Half-life decay: up to 0.5 for entries updated today, halves every 90 days
    return 0.5 / (1 + ageDays / 90);
}
export const EXPANSION_THRESHOLD = 0.2;
export const EXPANSION_DISCOUNT = 0.85;
export function applyConfidenceAndRecency(results) {
    return results.map((r) => ({
        ...r,
        score: (r.score + confidenceBonus(r.frontmatter.confidence)) * (1 + recencyBonus(r.frontmatter.updated)),
    }));
}
export function decomposeQuery(query) {
    // Only split on compound-question patterns, not casual "and" conjunctions
    const parts = query.split(/\band\s+(?:what|how|who|where|when|why|which)\b|[?;]/).map(s => s.trim()).filter(s => s.length > 15);
    if (parts.length >= 2)
        return parts;
    return [query];
}
export const METADATA_WEIGHT = 2.0;
export function computeBM25Scores(query, documents, k1 = 1.2, b = 0.75) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || documents.length === 0)
        return [];
    const N = documents.length;
    // Tokenize all documents with separate body and metadata passes
    const bodyTokensArr = [];
    const metaTokensArr = [];
    const allTokenSets = [];
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
    const df = new Map();
    for (const term of queryTerms) {
        let count = 0;
        for (const tokenSet of allTokenSets) {
            if (tokenSet.has(term))
                count++;
        }
        df.set(term, count);
    }
    // Score each document
    const results = [];
    for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const bodyTokens = bodyTokensArr[i];
        const metaTokens = metaTokensArr[i];
        const dl = bodyTokens.length + metaTokens.length;
        // Weighted term frequencies: body=1.0, metadata=METADATA_WEIGHT
        const tfMap = new Map();
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
export function extractWikilinks(content) {
    // Strip fenced code blocks
    let stripped = content.replace(/^```[\s\S]*?^```/gm, "");
    // Strip inline code
    stripped = stripped.replace(/`[^`]+`/g, "");
    // Extract [[wikilinks]]
    const matches = [...stripped.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    return [...new Set(matches)];
}
export function buildLookupMaps(documents) {
    const titleMap = new Map();
    const slugMap = new Map();
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
export function buildInboundCounts(documents) {
    const counts = new Map();
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
export function applyLinkBoost(results, inboundCounts, weight = 0.2) {
    return results.map((r) => {
        const count = inboundCounts.get(r.title.toLowerCase()) || 0;
        return {
            ...r,
            score: r.score * (1 + weight * Math.log(1 + count)),
        };
    });
}
export function buildWikilinkGraph(documents, titleMap, slugMap) {
    const graph = new Map();
    // Initialize all document paths with empty sets (so isolated nodes exist)
    for (const doc of documents) {
        graph.set(doc.path, new Set());
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
            if (!resolvedPath)
                continue;
            // Add bidirectional edges
            graph.get(doc.path).add(resolvedPath);
            // Ensure the target node exists in the graph (may be an isolated node added above)
            if (!graph.has(resolvedPath)) {
                graph.set(resolvedPath, new Set());
            }
            graph.get(resolvedPath).add(doc.path);
        }
    }
    return graph;
}
export const PPR_ALPHA = 0.85;
export const PPR_ITERATIONS = 20;
export const PPR_MIN_SCORE = 0.001;
export const MAX_EXPANSION = 5;
export function seededPageRank(graph, seeds, alpha = PPR_ALPHA, iterations = PPR_ITERATIONS, minScore = PPR_MIN_SCORE) {
    if (graph.size === 0 || seeds.size === 0)
        return new Map();
    // Normalize seed scores to sum=1
    let seedTotal = 0;
    for (const v of seeds.values())
        seedTotal += v;
    const seedVec = new Map();
    for (const [path, v] of seeds) {
        seedVec.set(path, v / seedTotal);
    }
    // Initialize scores from seedVec
    const scores = new Map(seedVec);
    // Collect all nodes present as keys in graph
    const allNodes = Array.from(graph.keys());
    for (let iter = 0; iter < iterations; iter++) {
        const nextScores = new Map();
        // Teleportation term: (1 - alpha) * seed[node]
        for (const node of allNodes) {
            nextScores.set(node, (1 - alpha) * (seedVec.get(node) || 0));
        }
        // Propagation: distribute alpha * scores[node] / degree to each neighbor
        for (const node of allNodes) {
            const nodeScore = scores.get(node) || 0;
            const neighbors = graph.get(node);
            if (!neighbors || neighbors.size === 0)
                continue;
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
    const result = new Map();
    for (const [path, score] of scores) {
        if (!seeds.has(path) && score >= minScore) {
            result.set(path, score);
        }
    }
    return result;
}
