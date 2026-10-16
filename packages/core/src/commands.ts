/**
 * The command registry: one typed description per image operation.
 *
 * Menus, the command palette, keyboard shortcuts, parameter dialogs, the
 * timeline (undo history), batch processing and the AI
 * assistant all read from here, so adding an operation means adding one entry.
 */
import type { Image } from "./image.js";
import type { Kernels } from "./kernels.js";
import { mapPlanes } from "./image.js";
import { flipHorizontal, flipVertical, gaussianBlur, invert, rotate90 } from "./ops.js";
import { close, dilate, erode, fillHoles, open, outline, skeletonize } from "./binary.js";
import { THRESHOLD_METHODS, type ThresholdMethod, autoThreshold, thresholdToMask } from "./threshold.js";

export type ParamSpec =
  | { type: "number"; label: string; default: number; min?: number; max?: number; step?: number; unit?: string; description?: string }
  | { type: "choice"; label: string; default: string; options: { value: string; label: string }[]; description?: string }
  | { type: "boolean"; label: string; default: boolean; description?: string };

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

export interface CommandContext {
  kernels: Kernels;
}

export interface Command {
  /** Stable id, used in saved timelines, batch jobs and AI tool names. */
  id: string;
  /** Menu label, ImageJ-style ("Gaussian Blur…" when it asks for parameters). */
  title: string;
  /** Menu path, e.g. ["Process", "Filters"]. */
  menu: string[];
  /** Icon name; the UI maps names to drawings. */
  icon: string;
  /** One sentence for the command palette and the AI assistant. */
  description: string;
  keywords?: string[];
  /** e.g. "Mod+Shift+I", where Mod is Cmd on macOS and Ctrl elsewhere. */
  shortcut?: string;
  params: Record<string, ParamSpec>;
  /** Short parameter summary for compact displays, e.g. "σ 2". */
  summary?(p: Params): string;
  run(input: Image, p: Params, ctx: CommandContext): Image;
}

/** Throws unless every plane is an 8-bit mask (0 and 255 only), as Process › Binary needs. */
function requireMask(img: Image, title: string) {
  const ok = img.dtype === "uint8" && img.planes.every((p) => p.every((v) => v === 0 || v === 255));
  if (!ok) throw new RangeError(`${title} needs a mask (black and white image): run Convert to Mask first`);
}

const binaryParams: Record<string, ParamSpec> = {
  iterations: { type: "number", label: "Iterations", default: 1, min: 1, max: 100, step: 1, description: "How many times to repeat the operation." },
  count: { type: "number", label: "Count", default: 1, min: 1, max: 8, step: 1, description: "How many of the 8 neighbours must differ before a pixel changes (higher is gentler)." },
};

type MaskFn = (mask: Uint8Array, width: number, height: number, count?: number, iterations?: number) => Uint8Array;

/** A Process › Binary command; `iterated` ones take Iterations and Count (Process › Binary › Options in ImageJ). */
function binaryCommand(id: string, title: string, fn: MaskFn, description: string, iterated: boolean, keywords: string[] = []): Command {
  return {
    id,
    title: iterated ? `${title}…` : title,
    menu: ["Process", "Binary"],
    icon: "binary",
    description,
    keywords: ["binary", "mask", "morphology", ...keywords],
    params: iterated ? binaryParams : {},
    summary: iterated ? (p) => (p.iterations === 1 && p.count === 1 ? "" : `×${p.iterations}, count ${p.count}`) : undefined,
    run: (img, p) => {
      requireMask(img, title);
      const { width, height } = img.shape;
      return mapPlanes(img, (plane) => fn(plane as Uint8Array, width, height, (p.count as number) ?? 1, (p.iterations as number) ?? 1));
    },
  };
}

export const COMMANDS: readonly Command[] = [
  {
    id: "invert",
    title: "Invert",
    menu: ["Edit"],
    icon: "invert",
    description: "Inverts pixel values (8-bit: 255 - v; 16-bit and float: across the data range), like a photographic negative.",
    keywords: ["negative", "reverse"],
    shortcut: "Mod+Shift+I",
    params: {},
    run: (img) => invert(img),
  },
  {
    id: "gaussian-blur",
    title: "Gaussian Blur…",
    menu: ["Process", "Filters"],
    icon: "blur",
    description: "Smooths the image with a Gaussian kernel. Larger sigma blurs more; useful to reduce noise before thresholding.",
    keywords: ["smooth", "denoise", "filter", "sigma", "gauss"],
    params: {
      sigma: { type: "number", label: "Sigma (radius)", default: 2, min: 0.1, max: 200, step: 0.1, unit: "px", description: "Standard deviation of the Gaussian, in pixels." },
    },
    summary: (p) => `σ ${p.sigma}`,
    run: (img, p, ctx) => gaussianBlur(ctx.kernels, img, { sigmaX: p.sigma as number }),
  },
  {
    id: "flip-horizontal",
    title: "Flip Horizontally",
    menu: ["Image", "Transform"],
    icon: "flip-h",
    description: "Mirrors the image left to right.",
    keywords: ["mirror"],
    params: {},
    run: (img) => flipHorizontal(img),
  },
  {
    id: "flip-vertical",
    title: "Flip Vertically",
    menu: ["Image", "Transform"],
    icon: "flip-v",
    description: "Mirrors the image top to bottom.",
    keywords: ["mirror", "upside down"],
    params: {},
    run: (img) => flipVertical(img),
  },
  {
    id: "rotate-right",
    title: "Rotate 90° Right",
    menu: ["Image", "Transform"],
    icon: "rotate-right",
    description: "Rotates the image 90 degrees clockwise.",
    keywords: ["turn", "clockwise"],
    params: {},
    run: (img) => rotate90(img, "right"),
  },
  {
    id: "rotate-left",
    title: "Rotate 90° Left",
    menu: ["Image", "Transform"],
    icon: "rotate-left",
    description: "Rotates the image 90 degrees counter-clockwise.",
    keywords: ["turn", "anticlockwise", "counterclockwise"],
    params: {},
    run: (img) => rotate90(img, "left"),
  },
  {
    id: "convert-to-mask",
    title: "Convert to Mask…",
    menu: ["Process", "Binary"],
    icon: "threshold",
    description:
      "Thresholds the image into a black and white mask: white where values fall in the threshold range. The range comes from an automatic method (Otsu, Li, Triangle…) computed for each slice, or is set by hand.",
    keywords: ["threshold", "binary", "segment", "binarize", "otsu", "auto threshold", "foreground"],
    params: {
      method: {
        type: "choice",
        label: "Method",
        default: "Default",
        options: [...THRESHOLD_METHODS.map((m) => ({ value: m, label: m })), { value: "Manual", label: "Manual (lower and upper below)" }],
        description: "Automatic thresholding method, or Manual to use the lower and upper values.",
      },
      dark: { type: "boolean", label: "Dark background", default: true, description: "Objects are brighter than the background (fluorescence). Off for dark objects on a bright background." },
      lower: { type: "number", label: "Lower", default: 0, description: "Lowest value counted as foreground (Manual only)." },
      upper: { type: "number", label: "Upper", default: 255, description: "Highest value counted as foreground (Manual only)." },
    },
    summary: (p) => (p.method === "Manual" ? `${p.lower}–${p.upper}` : `${p.method}${p.dark ? " dark" : ""}`),
    run: (img, p) =>
      mapPlanes(img, (plane) => {
        const [lo, hi] = p.method === "Manual" ? [p.lower as number, p.upper as number] : autoThreshold(plane, p.method as ThresholdMethod, p.dark as boolean);
        return thresholdToMask(plane, lo, hi);
      }),
  },
  binaryCommand("erode", "Erode", erode, "Shrinks white objects by removing pixels from their edges.", true, ["shrink"]),
  binaryCommand("dilate", "Dilate", dilate, "Grows white objects by adding pixels to their edges.", true, ["grow", "expand"]),
  binaryCommand("open", "Open", open, "Erodes then dilates: removes small specks and thin connections, keeps object size.", true, ["despeckle", "separate"]),
  binaryCommand("close", "Close", close, "Dilates then erodes: fills small gaps and holes, keeps object size.", true, ["gaps", "join"]),
  binaryCommand("fill-holes", "Fill Holes", fillHoles, "Fills background regions completely enclosed by white objects (e.g. hollow nuclei).", false, ["holes", "solid"]),
  binaryCommand("outline", "Outline", outline, "Keeps only a one-pixel outline of each white object.", false, ["edge", "border", "contour"]),
  binaryCommand("skeletonize", "Skeletonize", skeletonize, "Thins white objects to one-pixel-wide lines (for lengths and branching).", false, ["skeleton", "thin", "neurites", "branches"]),
  {
    id: "set-scale",
    title: "Set Scale…",
    menu: ["Analyze"],
    icon: "ruler",
    description:
      "Sets the physical size of a pixel, so areas, lengths and positions are measured in µm (or another unit). Draw a line over a scale bar or object of known length first to fill in its length in pixels.",
    keywords: ["calibrate", "calibration", "microns", "um", "pixel size", "units", "spatial"],
    params: {
      distance: { type: "number", label: "Distance in pixels", default: 0, min: 0, description: "Length of the reference in pixels; 0 removes the scale." },
      known: { type: "number", label: "Known distance", default: 1, min: 0, description: "The same length in physical units." },
      unit: { type: "choice", label: "Unit", default: "µm", options: ["nm", "µm", "mm", "cm", "m", "inch"].map((u) => ({ value: u, label: u })) },
    },
    summary: (p) => (p.distance && p.known ? `${p.distance} px = ${p.known} ${p.unit}` : "none"),
    run: (img, p) => {
      const d = p.distance as number;
      const k = p.known as number;
      if (!d || !k) return { ...img, calibration: { ...img.calibration, pixelWidth: 1, pixelHeight: 1, pixelDepth: 1, unit: "pixel" } };
      const size = k / d;
      // as ImageJ's ScaleDialog: an unset (1.0) slice spacing takes the pixel width
      const depth = img.calibration.pixelDepth === 1 ? size : img.calibration.pixelDepth;
      return { ...img, calibration: { ...img.calibration, pixelWidth: size, pixelHeight: size, pixelDepth: depth, unit: p.unit as string } };
    },
  },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command {
  const c = byId.get(id);
  if (!c) throw new RangeError(`unknown command "${id}"`);
  return c;
}

export function findCommand(id: string): Command | undefined {
  return byId.get(id);
}

export function defaultParams(cmd: Command): Params {
  return Object.fromEntries(Object.entries(cmd.params).map(([k, s]) => [k, s.default]));
}

/**
 * Validates untrusted parameters (from a dialog, a saved timeline, a batch
 * job or the AI) against the command's spec. Missing values take defaults;
 * numbers given as strings are accepted. Throws a RangeError on bad input.
 */
export function parseParams(cmd: Command, raw: unknown): Params {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Params = {};
  for (const [key, spec] of Object.entries(cmd.params)) {
    const v = input[key] ?? spec.default;
    if (spec.type === "number") {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new RangeError(`${cmd.title}: ${spec.label} must be a number`);
      if (spec.min !== undefined && n < spec.min) throw new RangeError(`${cmd.title}: ${spec.label} must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new RangeError(`${cmd.title}: ${spec.label} must be at most ${spec.max}`);
      out[key] = n;
    } else if (spec.type === "choice") {
      if (!spec.options.some((o) => o.value === v)) throw new RangeError(`${cmd.title}: ${spec.label} must be one of ${spec.options.map((o) => o.value).join(", ")}`);
      out[key] = v as string;
    } else {
      if (typeof v !== "boolean") throw new RangeError(`${cmd.title}: ${spec.label} must be true or false`);
      out[key] = v;
    }
  }
  return out;
}

/** JSON Schema for a command's parameters (for AI tools and plugin APIs). */
export function paramsJsonSchema(cmd: Command): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(cmd.params)) {
    const description = [spec.label, spec.description, spec.type === "number" && spec.unit ? `(${spec.unit})` : ""].filter(Boolean).join(". ");
    if (spec.type === "number") properties[key] = { type: "number", description };
    else if (spec.type === "choice") properties[key] = { type: "string", enum: spec.options.map((o) => o.value), description };
    else properties[key] = { type: "boolean", description };
  }
  return { type: "object", properties, required: Object.keys(cmd.params), additionalProperties: false };
}

/** Runs a list of recorded steps on an image (used by batch processing). */
export function runSteps(img: Image, steps: readonly { command: string; params?: unknown }[], ctx: CommandContext): Image {
  return steps.reduce((acc, s) => {
    const cmd = getCommand(s.command);
    return { ...cmd.run(acc, parseParams(cmd, s.params), ctx), name: acc.name };
  }, img);
}
