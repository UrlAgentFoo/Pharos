/**
 * The system status chip in the top bar, and the storage view it opens:
 * Docker and GPU (with setup help when missing), every ship with the books
 * that use it, See more (with its tests) and Remove, and the run cache.
 */
import type { CatalogueEntry, ShipManifest, StorageReport, SystemStatus } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { confirmDialog, escapeHtml, formatSize, showDialog } from "./dialogs.js";
import { nameTitle, paramLabel } from "./format.js";
import { icon } from "./icons.js";
import { formatTitle } from "./workspace-panel.js";

const SETUP = {
  docker: "https://docs.docker.com/get-started/get-docker/",
  gpu: "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html",
};

/** The top-bar chip's text and tone. */
export function statusChip(s: SystemStatus | null): { text: string; tone: "ok" | "warn" | "off"; title: string } {
  if (!s) return { text: "Checking…", tone: "off", title: "Checking Docker and the GPU" };
  if (!s.docker.available) return { text: "No Docker", tone: "warn", title: s.docker.error ?? "Docker isn't available" };
  return {
    text: `Docker${s.gpu.available ? " · GPU" : ""} · ${formatSize(s.disk.freeBytes)} free`,
    tone: "ok",
    title: `Docker ${s.docker.version}. ${s.gpu.available ? "NVIDIA GPU available." : (s.gpu.error ?? "No GPU.")}`,
  };
}

type Local = StorageReport["ships"][number];

/** Ships are picked by their place in the list. */
type Action = { more: number } | { remove: number } | { clear: true } | null;

/**
 * Ships: the tools books run. Every ship in the library with its
 * operations and trust, whether it's on this computer, and the computer
 * itself (Docker, GPU, disk) and the run cache.
 */
export async function storageDialog(server: LocalServer, notify: (text: string) => void): Promise<void> {
  for (;;) {
    const [status, entries, books] = await Promise.all([server.status(), server.ships(), server.books().catch(() => [])]);
    const [report, manifests] = await Promise.all([
      status.docker.available ? server.storage() : Promise.resolve(null),
      Promise.all(entries.map((e) => server.ship(e.id, e.version).then((r) => r.manifest))),
    ]);
    const bookTitle = (id: string) => books.find((b) => b.id === id)?.title ?? id;
    const local = (e: CatalogueEntry) => report?.ships.find((x) => x.id === e.id && x.version === e.version);
    const action = await showDialog<Action>(html(status, report, entries, manifests, local, bookTitle), wire, null);
    document.getElementById("dialog")?.classList.remove("wide");
    if (!action) return;
    try {
      if ("more" in action) {
        const e = entries[action.more];
        if (await shipDetails(e, manifests[action.more], local(e), bookTitle)) {
          notify(`Testing ${e.title}…`);
          const r = await server.testShip(e.id, e.version);
          const failed = r.cases.filter((c) => !c.passed);
          notify(r.passed ? `${e.title} passed its tests and is now verified` : `${e.title} failed: ${failed.map((c) => `${c.name}: ${c.message}`).join("; ")}`);
        }
      } else if ("remove" in action) {
        const e = entries[action.remove];
        const here = local(e);
        const users = here?.usedBy.map(bookTitle) ?? [];
        const again = users.length ? ` ${users.join(", ")} use${users.length === 1 ? "s" : ""} it and will download it again when next needed.` : "";
        const freed = here ? ` and frees ${formatSize(here.sizeBytes)}` : "";
        if (await confirmDialog(`Remove ${e.title}?`, `This deletes it from this computer${freed}.${again} Your data and cached results are kept.`, "Remove ship", true)) {
          const r = await server.removeShip(e.id, e.version, users.length > 0);
          notify(`Removed ${e.title} · freed ${formatSize(r.freedBytes)}`);
        }
      } else if ("clear" in action) {
        const used = report ? ` (${formatSize(report.cache.usedBytes)})` : "";
        if (await confirmDialog("Clear the cache?", `This forgets every cached result${used}. Your data stays; steps just run again in full next time.`, "Clear cache", true)) {
          await server.clearCache();
          notify("Cache cleared");
        }
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }
}

const TRUST: Record<string, string> = { verified: "Verified", verifying: "Verifying", imported: "Not yet tested" };

const gpuText = (gpu: CatalogueEntry["gpu"]) => (gpu === "required" ? "Needs a GPU" : gpu === "optional" ? "Uses a GPU if there is one" : "");

/** Where a ship is: on this computer with its size, or what it will download. */
const whereHtml = (e: CatalogueEntry, local: Local | undefined) =>
  local
    ? `${icon("check", 13)} On this computer · ${formatSize(local.sizeBytes)}`
    : `${icon("save", 13)} Downloads${e.imageSizeBytes ? ` (${formatSize(e.imageSizeBytes)})` : ""} when a step needs it`;

/**
 * A ship's card, the same shape as a book's (see `.lib-card`): name and
 * trust, what it does, its operations (scrolling inside the card when
 * there are many), and at the foot whether it's on this computer, which
 * books use it, See more and Remove.
 */
function shipCard(i: number, e: CatalogueEntry, m: ShipManifest, local: Local | undefined, bookTitle: (id: string) => string): string {
  const ops = Object.entries(m.operations);
  const facts = [`Version ${e.version}`, gpuText(e.gpu), m.license ?? ""].filter(Boolean).join(" · ");
  return `<li class="lib-card">
    <header class="lib-card-head"><span class="lib-card-icon">${icon("ship", 16)}</span><div class="lib-card-name"><h3>${escapeHtml(e.title)}</h3><span class="lib-badge ${e.trust === "verified" ? "ok" : ""}">${e.trust === "verified" ? icon("check", 13) : ""}${TRUST[e.trust] ?? e.trust}</span></div></header>
    <p class="lib-card-desc" title="${escapeHtml(e.summary)}">${escapeHtml(e.summary)}</p>
    <div class="lib-card-body">
      <p class="eyebrow">${ops.length} operation${ops.length === 1 ? "" : "s"}</p>
      <ul class="lib-card-ops">${ops.map(([name, op]) => `<li><strong>${escapeHtml(nameTitle(name))}</strong><span title="${escapeHtml(op.summary)}">${escapeHtml(op.summary)}</span></li>`).join("")}</ul>
    </div>
    <div class="lib-card-foot">
      <p class="lib-card-where ${local ? "on" : ""}">${whereHtml(e, local)}</p>
      ${local?.usedBy.length ? `<p class="lib-card-meta">Used by ${escapeHtml(local.usedBy.map(bookTitle).join(", "))}</p>` : ""}
      <p class="lib-card-meta">${escapeHtml(facts)}</p>
      <div class="lib-card-links"><button class="link-btn" data-more="${i}" aria-label="See more about ${escapeHtml(e.title)}">See more</button>${
        local ? `<button class="link-btn danger" data-remove="${i}" aria-label="Remove ${escapeHtml(e.title)}">Remove</button>` : ""
      }</div>
    </div>
  </li>`;
}

/**
 * A ship in full: what it is and how it runs, and what each operation
 * takes, gives and lets you set. Resolves true to run its tests.
 */
function shipDetails(e: CatalogueEntry, m: ShipManifest, local: Local | undefined, bookTitle: (id: string) => string) {
  const ops = Object.entries(m.operations).map(([name, op]) => {
    const takes = op.inputs?.length
      ? `Takes ${op.inputs.map((i) => `${i.formats.map(formatTitle).join(" or ")}${i.optional ? " (optional)" : ""}`).join(" and ")}`
      : "Starts from its settings";
    const gives = `gives ${op.outputs.map((o) => formatTitle(o.format)).join(", ")}`;
    const settings = op.parameters?.length ? `Settings: ${op.parameters.map(paramLabel).join(", ")}` : "";
    return `<li><strong>${escapeHtml(nameTitle(name))}</strong><span>${escapeHtml(op.summary)}</span><small>${escapeHtml([`${takes}, ${gives}`, settings].filter(Boolean).join(" · "))}</small></li>`;
  });
  const req = m.requires;
  const runs = [
    req?.network === "download" ? "Downloads while it runs" : "Runs without network access",
    m.mode === "warm" ? "stays running between operations, so they start at once" : "",
    req?.memory_gb ? `needs ${req.memory_gb} GB of memory` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [`Version ${e.version}`, TRUST[e.trust] ?? e.trust, gpuText(e.gpu), m.license ?? ""].filter(Boolean).join(" · ");
  // a ship's homepage is its author's text: link only plain web addresses
  const homepage = m.homepage && /^https?:\/\//.test(m.homepage) ? `<a href="${escapeHtml(m.homepage)}" target="_blank" rel="noopener">Homepage</a>` : "";
  return showDialog<boolean>(
    `<p class="eyebrow">Ship</p><h2>${escapeHtml(e.title)}</h2>
     <div class="lib-more">
       <p>${escapeHtml(e.summary)}</p>
       <p class="lib-card-where ${local ? "on" : ""}">${whereHtml(e, local)}</p>
       ${local?.usedBy.length ? `<p class="muted small">Used by ${escapeHtml(local.usedBy.map(bookTitle).join(", "))}</p>` : ""}
       <p class="muted small">${escapeHtml(facts)}</p>
       <p class="muted small">${escapeHtml(runs)}</p>
       ${e.verifyError ? `<p class="error small">Its last test failed: ${escapeHtml(e.verifyError)}</p>` : ""}
       <h3>Operations</h3>
       <ul class="lib-more-list">${ops.join("")}</ul>
       ${m.citation ? `<h3>Cite</h3><p class="small">${escapeHtml(m.citation)}</p>` : ""}
       ${homepage ? `<p class="small">${homepage}</p>` : ""}
     </div>
     <footer><button data-test>Run its tests</button><button class="primary" data-cancel>Back</button></footer>`,
    (done, el) => el.querySelector("[data-test]")!.addEventListener("click", () => done(true)),
    false,
  );
}

function html(
  s: SystemStatus,
  report: StorageReport | null,
  entries: CatalogueEntry[],
  manifests: ShipManifest[],
  local: (e: CatalogueEntry) => Local | undefined,
  bookTitle: (id: string) => string,
): string {
  const docker = s.docker.available
    ? `<li>${icon("check", 15)} Docker ${escapeHtml(s.docker.version ?? "")}</li>`
    : `<li class="warn">${icon("warning", 15)} ${escapeHtml(s.docker.error ?? "No Docker")} <a href="${SETUP.docker}" target="_blank" rel="noopener">Get Docker</a></li>`;
  const gpu = s.gpu.available
    ? `<li>${icon("check", 15)} NVIDIA GPU</li>`
    : `<li class="muted">${icon("warning", 15)} ${escapeHtml(s.gpu.error ?? "No GPU")}${s.docker.available && !/Mac/.test(s.gpu.error ?? "") ? ` <a href="${SETUP.gpu}" target="_blank" rel="noopener">Set up GPU</a>` : ""}</li>`;
  const cards = entries.map((e, i) => shipCard(i, e, manifests[i], local(e), bookTitle)).join("");
  return `<p class="eyebrow">Library</p><h2>Ships</h2>
    <p class="muted small">The tools books run: each is a container image with typed operations. They run on this computer, without network access, and see only the data you give them.</p>
    <ul class="status-list">${docker}${gpu}<li>${icon("save", 15)} ${formatSize(s.disk.freeBytes)} free in ${escapeHtml(s.disk.path)}</li></ul>
    <ul class="lib-cards">${cards || `<li class="lib-empty">No ships in the library yet. Create one with <code>pharos ship new</code>.</li>`}</ul>
    ${report ? `<h3>Cache</h3><p class="muted">Results of earlier runs, reused when the same step runs on the same data: ${formatSize(report.cache.usedBytes)} of outputs (limit ${formatSize(report.cache.limitBytes)}). Your data: ${formatSize(report.artifactsBytes)}.</p>` : ""}
    <footer>${report ? `<button class="quiet-danger" data-clear>Clear cache</button>` : ""}<button class="primary" data-cancel>Close</button></footer>`;
}

function wire(done: (a: Action) => void, el: HTMLDialogElement) {
  el.classList.add("wide");
  el.querySelectorAll<HTMLButtonElement>("[data-more]").forEach((b) => b.addEventListener("click", () => done({ more: Number(b.dataset.more) })));
  el.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", () => done({ remove: Number(b.dataset.remove) })));
  el.querySelector("[data-clear]")?.addEventListener("click", () => done({ clear: true }));
}
