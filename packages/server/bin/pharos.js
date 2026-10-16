#!/usr/bin/env node
import { main } from "../dist/cli.js";

main().catch((err) => {
  console.error(`pharos: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
