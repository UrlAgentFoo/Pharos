/**
 * The catalogue as an MCP server (Model Context Protocol), so the build
 * agents, Claude Desktop, Claude Code and other assistants search the same
 * index Pharos uses. It speaks JSON-RPC 2.0 over stdio, one message per
 * line, and offers the six catalogue tools.
 *
 *   pharos mcp --library .     (in an MCP client's server config)
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { type DataSummary, MCP_TOOLS, type McpToolName } from "@pharos/contracts";
import type { CatalogueIndex } from "./index-db.js";
import { inspect, sniff } from "./inspect.js";
import { type MatchableBook, matchBooks } from "./match.js";

export interface McpContext {
  index: CatalogueIndex;
  books: MatchableBook[];
  gpu: boolean;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const filters = {
  text: { type: "string", description: "Words to search for, e.g. 'track nuclei 3d'" },
  trust: { type: "string", enum: ["verified", "verifying", "imported"] },
  gpu: { type: "string", enum: ["required", "optional", "none"] },
  tag: { type: "string" },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};

const SCHEMAS: Record<McpToolName, object> = {
  search_books: { type: "object", properties: filters },
  search_ships: { type: "object", properties: filters },
  match_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of a data file or folder (OME-Zarr) on this computer" },
      summary: { type: "object", description: "A DataSummary, when the data isn't on this computer" },
      text: { type: "string", description: "What the user wants to do, to rank the matches" },
    },
  },
  get_manifest: {
    type: "object",
    properties: { type: { type: "string", enum: ["ship", "book"] }, id: { type: "string" }, version: { type: "string" } },
    required: ["type", "id"],
  },
  catalogue_stats: { type: "object", properties: {} },
  find_gaps: { type: "object", properties: {} },
};

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export class McpServer {
  constructor(private readonly context: () => Promise<McpContext>) {}

  /** Answers one message; null for notifications. */
  async handle(msg: Rpc): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return null; // notifications (e.g. notifications/initialized) need no answer
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "pharos-catalogue", version: "0.1.0" },
          instructions: "Search Pharos ships (container tools) and books (recipes). Use match_file to find books that can run on a data file.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: Object.entries(MCP_TOOLS).map(([name, description]) => ({ name, description, inputSchema: SCHEMAS[name as McpToolName] })) });
      case "tools/call": {
        const name = String(msg.params?.name ?? "") as McpToolName;
        if (!(name in MCP_TOOLS)) return fail(-32602, `unknown tool ${name}`);
        try {
          const result = await this.call(name, (msg.params?.arguments ?? {}) as Record<string, unknown>);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: { result } });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  private async call(name: McpToolName, args: Record<string, unknown>): Promise<unknown> {
    const ctx = await this.context();
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const search = { text: str("text"), trust: str("trust") as never, gpu: str("gpu") as never, tag: str("tag"), limit: typeof args.limit === "number" ? args.limit : undefined };
    switch (name) {
      case "search_books":
        return ctx.index.search({ ...search, type: "book" });
      case "search_ships":
        return ctx.index.search({ ...search, type: "ship" });
      case "get_manifest": {
        const found = ctx.index.manifest(str("type") as "ship" | "book", str("id") ?? "", str("version"));
        if (!found) throw new Error(`no ${str("type")} "${str("id")}" in the catalogue`);
        return found;
      }
      case "catalogue_stats":
        return ctx.index.stats();
      case "find_gaps":
        return ctx.index.gaps();
      case "match_file": {
        let summary = args.summary as DataSummary | undefined;
        const path = str("path");
        if (!summary && path) {
          const s = await stat(path).catch(() => null);
          if (!s) throw new Error(`not found: ${path}`);
          const type = sniff(basename(path), s.isDirectory());
          if (!type) throw new Error(`Pharos doesn't know what kind of data ${basename(path)} is`);
          summary = await inspect({ uri: path, ...type, name: basename(path) });
        }
        if (!summary) throw new Error("give a path or a summary");
        return { summary, matches: matchBooks(ctx.books, [summary], { text: str("text"), gpu: ctx.gpu }) };
      }
    }
  }

  /** Serves over stdin/stdout until stdin closes. Logs go to stderr, never stdout. */
  async serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      const answer = await this.handle(msg);
      if (answer) output.write(JSON.stringify(answer) + "\n");
    }
  }
}
