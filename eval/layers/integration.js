// Integration test layer: spawns the Lore MCP server and calls tools via
// StdioClientTransport, measuring per-question latency and computing retrieval
// metrics against ground-truth expected titles.

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  recallAtK,
  ndcgAtK,
  abstentionAccuracy,
} from "../scoring/metrics.js";

// Resolve the project root directory (two levels up from eval/layers/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");

// Map each ability to the appropriate MCP tool name.
const TOOL_BY_ABILITY = {
  information_extraction: "lore_search",
  knowledge_updates: "lore_search",
  keyword_metadata: "lore_search",
  filtered_search: "lore_search",
  abstention: "lore_search",
  multi_hop: "lore_query",
};

/**
 * Create and connect an MCP client that spawns the Lore server as a child
 * process.  Rejects if the server does not connect within 10 seconds.
 *
 * @param {string} lorePath - Absolute path to the lore corpus directory
 * @returns {Promise<Client>}
 */
async function createClient(lorePath) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: { ...process.env, LORE_PATH: lorePath },
    cwd: PROJECT_ROOT,
  });

  const client = new Client({ name: "eval-harness", version: "1.0.0" });

  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("MCP server connection timed out after 10 seconds")),
      10_000
    )
  );

  await Promise.race([connectPromise, timeoutPromise]);
  return client;
}

/**
 * Extract the plain text from a tool call result's content array.
 *
 * @param {{ content: Array<{type: string, text?: string}> }} result
 * @returns {string}
 */
function extractText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Parse bold titles from lore_search output.
 * Format: `**Title** (path/to/file.md)`
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseSearchTitles(text) {
  if (text.includes("No results found for:")) return [];
  const titles = [];
  const re = /\*\*(.+?)\*\*\s+\(/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    titles.push(match[1]);
  }
  return titles;
}

/**
 * Parse section-header titles from lore_query output.
 * Format: `## Title (path/to/file.md)`
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseQueryTitles(text) {
  if (text.includes("No relevant lore entries found for:")) return [];
  const titles = [];
  const re = /^## (.+?) \(/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    titles.push(match[1]);
  }
  return titles;
}

/**
 * Build the tool arguments for a given question.
 *
 * @param {object} question
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
function buildArgs(question, toolName) {
  if (toolName === "lore_query") {
    return { question: question.query };
  }
  const args = { query: question.query };
  if (question.filterParams) {
    Object.assign(args, question.filterParams);
  }
  return args;
}

/**
 * Run the integration test layer.
 *
 * Spawns the Lore MCP server once, iterates through all questions, calls the
 * appropriate tool for each, parses the returned titles, and computes retrieval
 * metrics.  The server is shut down cleanly afterwards via client.close().
 *
 * If the server crashes mid-run, all remaining (unevaluated) questions are
 * marked with status "server_error" and zero scores.
 *
 * @param {Array<{
 *   id: string,
 *   ability: string,
 *   query: string,
 *   expected_titles: string[],
 *   k: number,
 *   grades?: Map<string, number>,
 *   filterParams?: Record<string, string>,
 * }>} questions
 * @param {string} lorePath - Absolute path to the lore corpus directory
 * @returns {Promise<Array<{
 *   id: string,
 *   ability: string,
 *   query: string,
 *   expected_titles: string[],
 *   retrieved_titles: string[],
 *   recall: number,
 *   ndcg: number,
 *   abstentionAcc: number,
 *   latencyMs: number,
 *   status: string,
 * }>>}
 */
export async function runIntegrationLayer(questions, lorePath) {
  const client = await createClient(lorePath);
  const results = [];

  try {
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      const toolName = TOOL_BY_ABILITY[question.ability] ?? "lore_search";
      const args = buildArgs(question, toolName);

      let retrieved = [];
      let latencyMs = 0;
      let status = "ok";

      try {
        const startTime = performance.now();
        const result = await client.callTool({ name: toolName, arguments: args });
        const endTime = performance.now();
        latencyMs = endTime - startTime;

        const text = extractText(result);
        retrieved =
          toolName === "lore_query"
            ? parseQueryTitles(text)
            : parseSearchTitles(text);
      } catch (err) {
        // Transport or server error: mark this and all remaining questions as
        // server_error with zero scores.
        const errorResult = {
          id: question.id,
          ability: question.ability,
          query: question.query,
          expected_titles: question.expected_titles,
          retrieved_titles: [],
          recall: 0,
          ndcg: 0,
          abstentionAcc: 0,
          latencyMs: 0,
          status: "server_error",
        };
        results.push(errorResult);

        for (let j = i + 1; j < questions.length; j++) {
          const q = questions[j];
          results.push({
            id: q.id,
            ability: q.ability,
            query: q.query,
            expected_titles: q.expected_titles,
            retrieved_titles: [],
            recall: 0,
            ndcg: 0,
            abstentionAcc: 0,
            latencyMs: 0,
            status: "server_error",
          });
        }
        return results;
      }

      // Compute metrics based on ability
      let recall = 0;
      let ndcg = 0;
      let abstentionAcc = 0;

      if (question.expected_titles.length === 0) {
        abstentionAcc = abstentionAccuracy(retrieved);
      } else {
        recall = recallAtK(retrieved, question.expected_titles, question.k);
        ndcg = ndcgAtK(
          retrieved,
          question.expected_titles,
          question.k,
          question.grades
        );
      }

      const result = {
        id: question.id,
        ability: question.ability,
        query: question.query,
        expected_titles: question.expected_titles,
        retrieved_titles: retrieved,
        recall,
        ndcg,
        abstentionAcc,
        latencyMs,
        status,
      };
      if (question.subType !== undefined) {
        result.subType = question.subType;
      }
      results.push(result);
    }
  } finally {
    await client.close().catch(() => {
      // Suppress close errors — the server may have already exited
    });
  }

  return results;
}
