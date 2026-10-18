/**
 * `pharos mcp [--library <dir>…] [--data <dir>]`: the catalogue's MCP
 * server on stdio, for Claude Desktop, Claude Code and the build agents.
 * It reads the same library and trust records as the app.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Library } from "@pharos/books";
import { McpServer } from "@pharos/catalogue";
import { connect, detectStatus } from "@pharos/orchestrator";
import { CatalogueHolder } from "./catalogue.js";
import { TrustStore } from "./orchestration.js";
import { defaultDataDir } from "./server.js";

export const MCP_HELP = `  pharos mcp [--library <dir>…] [--data <dir>]
                                         serve the catalogue to MCP clients over stdio`;

export async function runMcp(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { library: { type: "string", short: "l", multiple: true }, data: { type: "string", short: "d" } } });
  const dataDir = values.data ? resolve(values.data) : defaultDataDir();
  const dirs = [...(values.library ?? []).map((d) => resolve(d)), dataDir];
  const trust = await TrustStore.load(dataDir);
  const gpu = (await detectStatus(dataDir, connect())).gpu.available;
  // reload on each call: MCP sessions are long, and authors edit manifests during them
  const holder = new CatalogueHolder(() => Library.load(dirs, trust.get), trust, () => gpu);
  await new McpServer(() => holder.get()).serveStdio();
  holder.close();
}
