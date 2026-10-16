/**
 * Turns an operation's command template into the container's argument
 * list. No shell is involved: the template is split into words first and
 * each `{placeholder}` is replaced inside its word, so a parameter value
 * can never become a second argument or a shell command.
 *
 * Placeholders: `{param}` is a parameter's value; `{in.name}` is the path
 * of input `name` inside the container (`/in/<name>/<file name>`).
 */
import type { Params } from "@pharos/contracts";

/** Splits a template into words, honouring single and double quotes. */
export function splitWords(template: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const c of template) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in command: ${template}`);
  if (started) words.push(word);
  return words;
}

export function buildArgv(template: string, params: Params, inputs: Record<string, string>): string[] {
  return splitWords(template).map((w) =>
    w.replace(/\{(in\.)?([a-z][a-z0-9_]*)\}/g, (_m, isInput: string | undefined, name: string) => {
      if (isInput) {
        if (!(name in inputs)) throw new Error(`the command uses {in.${name}}, but no input "${name}" was given`);
        return inputs[name];
      }
      if (!(name in params)) throw new Error(`the command uses {${name}}, but no parameter "${name}" has a value`);
      return String(params[name]);
    }),
  );
}
