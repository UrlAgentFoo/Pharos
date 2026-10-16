#!/usr/bin/env node
// node:sqlite (the catalogue index) still prints an "experimental" warning; it isn't
// news to Pharos users, so drop that one. The CLI is imported after this filter is in place.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) =>
  String(warning?.message ?? warning).includes("SQLite is an experimental feature") ? undefined : emitWarning.call(process, warning, ...rest);

const { main } = await import("../dist/cli.js");
main().catch((err) => {
  console.error(`pharos: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
