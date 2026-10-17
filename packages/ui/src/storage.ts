/**
 * The system status chip in the top bar, and the storage view it opens:
 * Docker and GPU (with setup help when missing), downloaded ships with
 * the books that use them, Test and Remove, and the run cache.
 */
import type { CatalogueEntry, ShipManifest, StorageReport, SystemStatus } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { confirmDialog, escapeHtml, formatSize, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";

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

type Action = { test: string } | { remove: { id: string; version: string; usedBy: string[] } } | { clear: true } | { refresh: true } | null;

/**
 * Ships: the tools books run. Every ship in the library with its
 * operations and trust, whether it's on this computer, and the computer
 * itself (Docker, GPU, disk) and the run cache.
 */
export async function storageDialog(server: LocalServer, notify: (text: string) => void): Promise<void> {
  for (;;) {
    const [status, entries] = await Promise.all([server.status(), server.ships()]);
    const [report, manifests] = await Promise.all([
      status.docker.available ? server.storage() : Promise.resolve(null),
      Promise.all(entries.map((e) => server.ship(e.id, e.version).then((r) => r.manifest))),
    ]);
    const action = await showDialog<Action>(html(status, report, entries, manifests), wire, null);
    document.getElementById("dialog")?.classList.remove("wide");
    if (!action) return;
    if ("refresh" in action) continue;
    try {
      if ("test" in action) {
        notify(`Testing ${action.test}…`);
        const r = await server.testShip(action.test);
        const failed = r.cases.filter((c) => !c.passed);
        notify(r.passed ? `${action.test} passed its tests and is now verified` : `${action.test} failed: ${failed.map((c) => `${c.name}: ${c.message}`).join("; ")}`);
      } else if ("remove" in action) {
        const { id, version, usedBy } = action.remove;
        const warn = usedBy.length ? ` ${usedBy.join(", ")} use${usedBy.length === 1 ? "s" : ""} it and would download it again.` : "";
        if (await confirmDialog("Remove ship?", `Delete the ${id} ${version} image from this computer?${warn}`, "Remove")) {
          const r = await server.removeShip(id, version, usedBy.length > 0);
          notify(`Freed ${formatSize(r.freedBytes)}`);
        }
      } else if ("clear" in action) {
        if (await confirmDialog("Clear cache?", "Forget every cached result? Your data stays; steps just run again next time.", "Clear")) {
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

function html(s: SystemStatus, report: StorageReport | null, entries: CatalogueEntry[], manifests: ShipManifest[]): string {
  const here = new Map(report?.ships.map((x) => [`${x.id}@${x.version}`, x]) ?? []);
  const docker = s.docker.available
    ? `<li>${icon("check", 15)} Docker ${escapeHtml(s.docker.version ?? "")}</li>`
    : `<li class="warn">${icon("warning", 15)} ${escapeHtml(s.docker.error ?? "No Docker")} <a href="${SETUP.docker}" target="_blank" rel="noopener">Get Docker</a></li>`;
  const gpu = s.gpu.available
    ? `<li>${icon("check", 15)} NVIDIA GPU</li>`
    : `<li class="muted">${icon("warning", 15)} ${escapeHtml(s.gpu.error ?? "No GPU")}${s.docker.available && !/Mac/.test(s.gpu.error ?? "") ? ` <a href="${SETUP.gpu}" target="_blank" rel="noopener">Set up GPU</a>` : ""}</li>`;
  const cards = entries
    .map((e, i) => {
      const m = manifests[i];
      const local = here.get(`${e.id}@${e.version}`);
      const ops = Object.entries(m.operations).map(([name, op]) => `<li><strong>${escapeHtml(name)}</strong> <small>${escapeHtml(op.summary)}</small></li>`).join("");
      return `<li class="book-card">
        <div class="book-top"><strong>${icon("ship", 14)} ${escapeHtml(e.id)}</strong><small class="trust trust-${e.trust}">${TRUST[e.trust] ?? e.trust}</small></div>
        <p>${escapeHtml(e.summary)}</p>
        <p class="book-meta"><small>${escapeHtml(e.version)}${e.gpu !== "none" ? ` · GPU ${e.gpu}` : ""}${m.license ? ` · ${escapeHtml(m.license)}` : ""} · ${
          local ? `on this computer, ${formatSize(local.sizeBytes)}${local.usedBy.length ? ` · used by ${escapeHtml(local.usedBy.join(", "))}` : ""}` : "downloads (or builds) when a step needs it"
        }</small></p>
        <ul class="ship-ops">${ops}</ul>
        <div class="job-actions"><button class="chip" data-test="${escapeHtml(e.id)}" title="Runs each operation on its test data">Test</button>${
          local ? `<button class="chip" data-remove="${escapeHtml(JSON.stringify({ id: e.id, version: e.version, usedBy: local.usedBy }))}">Remove from this computer</button>` : ""
        }</div></li>`;
    })
    .join("");
  return `<p class="eyebrow">Ships</p><h2>The tools books run</h2>
    <p class="muted small">Each ship is a container image with typed operations. Books (recipes) chain them; they run on this computer, without network access, and see only the data you give them.</p>
    <ul class="status-list">${docker}${gpu}<li>${icon("save", 15)} ${formatSize(s.disk.freeBytes)} free in ${escapeHtml(s.disk.path)}</li></ul>
    <ul class="book-list">${cards || `<li class="muted">No ships installed yet.</li>`}</ul>
    ${report ? `<h3>Cache</h3><p class="muted">Results of earlier runs, reused when the same step runs on the same data: ${formatSize(report.cache.usedBytes)} of outputs (limit ${formatSize(report.cache.limitBytes)}). Your data: ${formatSize(report.artifactsBytes)}.</p>` : ""}
    <footer>${report ? `<button data-clear>Clear cache</button>` : ""}<button data-refresh>Refresh</button><button class="primary" data-cancel>Close</button></footer>`;
}

function wire(done: (a: Action) => void, el: HTMLDialogElement) {
  el.classList.add("wide");
  el.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => b.addEventListener("click", () => done({ test: b.dataset.test! })));
  el.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", () => done({ remove: JSON.parse(b.dataset.remove!) })));
  el.querySelector("[data-clear]")?.addEventListener("click", () => done({ clear: true }));
  el.querySelector("[data-refresh]")?.addEventListener("click", () => done({ refresh: true }));
}
