/**
 * Commands for ship and book authors. They work on folders directly, so
 * they run without a server:
 *
 *   pharos check [dir…]            validate and type-check every ship and book
 *   pharos ship new <id> [--dir d] start a ship from a template
 *   pharos book new <id> [--dir d] [--ship s]
 */
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Library, newBook, newShip } from "@pharos/books";

export const AUTHOR_HELP = `Authoring:
  pharos check [dir…]                    check the ships and books under each dir (default .)
  pharos ship new <id> [--dir <dir>]     create <dir>/ships/<id> from a template (default dir .)
  pharos book new <id> [--dir <dir>] [--ship <ship>]
                                         create <dir>/books/<id> from a template`;

/** Runs an authoring command; returns the process exit code, or null if argv isn't one. */
export async function runAuthorCommand(argv: string[], log = console.log): Promise<number | null> {
  const [cmd, sub] = argv;
  if (cmd === "check") return check(argv.slice(1), log);
  if ((cmd === "ship" || cmd === "book") && sub === "new") {
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: { dir: { type: "string", default: "." }, ship: { type: "string" } },
    });
    const id = positionals[0];
    if (!id) throw new Error(`usage: pharos ${cmd} new <id>`);
    const dir = cmd === "ship" ? await newShip(resolve(values.dir), id) : await newBook(resolve(values.dir), id, values.ship);
    log(`Created ${shown(dir)}. Edit it, then run \`pharos check\`.`);
    return 0;
  }
  return null;
}

async function check(dirs: string[], log: (s: string) => void): Promise<number> {
  const roots = (dirs.length ? dirs : ["."]).map((d) => resolve(d));
  const lib = await Library.load(roots);
  const issues = lib.issues();
  let errors = 0;
  for (const issue of issues) {
    log(`${issue.type} ${issue.id} (${shown(issue.dir)})`);
    for (const p of issue.problems) {
      if (p.severity === "error") errors++;
      const where = p.file ? `${shown(p.file)}${p.line ? `:${p.line}` : ""}` : p.path;
      log(`  ${p.severity === "error" ? "error  " : "warning"} ${where}  ${p.message}${p.file && p.path !== "/" ? `  (${p.path})` : ""}`);
    }
  }
  const ships = lib.shipManifests().length;
  const books = lib.bookManifests().length;
  log(`${ships} ship${ships === 1 ? "" : "s"} and ${books} book${books === 1 ? "" : "s"} OK; ${errors} error${errors === 1 ? "" : "s"}, ${issues.flatMap((i) => i.problems).length - errors} warning(s).`);
  return errors ? 1 : 0;
}

/** A path relative to where the command runs, unless that means climbing out of it. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return !rel ? "." : rel.startsWith("..") ? path : rel;
}
