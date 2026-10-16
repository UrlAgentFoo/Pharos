/**
 * The system status chip in the top bar, and the storage view it opens:
 * Docker and GPU (with setup help when missing), downloaded ships with
 * the books that use them, Test and Remove, and the run cache.
 */
import type { StorageReport, SystemStatus } from "@pharos/contracts";
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

export async function storageDialog(server: LocalServer, notify: (text: string) => void): Promise<void> {
  for (;;) {
    const [status, entries] = await Promise.all([server.status(), server.ships()]);
    const report: StorageReport | null = status.docker.available ? await server.storage() : null;
    const action = await showDialog<Action>(html(status, report, entries), wire, null);
    if (!action) return;
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

function html(s: SystemStatus, report: StorageReport | null, entries: Awaited<ReturnType<LocalServer["ships"]>>): string {
  const downloaded = new Set(report?.ships.map((x) => `${x.id}@${x.version}`) ?? []);
  const notHere = entries.filter((e) => !downloaded.has(`${e.id}@${e.version}`));
  const trust = new Map(entries.map((e) => [`${e.id}@${e.version}`, e.trust]));
  const docker = s.docker.available
    ? `<li>${icon("check", 15)} Docker ${escapeHtml(s.docker.version ?? "")}</li>`
    : `<li class="warn">${icon("warning", 15)} ${escapeHtml(s.docker.error ?? "No Docker")} <a href="${SETUP.docker}" target="_blank" rel="noopener">Get Docker</a></li>`;
  const gpu = s.gpu.available
    ? `<li>${icon("check", 15)} NVIDIA GPU</li>`
    : `<li class="muted">${icon("warning", 15)} ${escapeHtml(s.gpu.error ?? "No GPU")}${s.docker.available && !/Mac/.test(s.gpu.error ?? "") ? ` <a href="${SETUP.gpu}" target="_blank" rel="noopener">Set up GPU</a>` : ""}</li>`;
  const ships = report?.ships.length
    ? report.ships
        .map(
          (x) => `<li class="storage-row"><span><strong>${escapeHtml(x.id)}</strong> ${escapeHtml(x.version)} <small class="trust trust-${trust.get(`${x.id}@${x.version}`)}">${trust.get(`${x.id}@${x.version}`) === "verified" ? "Verified" : "Not yet tested"}</small><br/>
            <small>${formatSize(x.sizeBytes)} · ${x.usedBy.length ? `used by ${escapeHtml(x.usedBy.join(", "))}` : "no installed book uses it"}</small></span>
            <span><button class="chip" data-test="${escapeHtml(x.id)}">Test</button> <button class="chip" data-remove="${escapeHtml(JSON.stringify({ id: x.id, version: x.version, usedBy: x.usedBy }))}">Remove</button></span></li>`,
        )
        .join("")
    : `<li class="muted">No ships downloaded yet. They download when a book or a Run needs them.</li>`;
  const pending = notHere.length
    ? `<h3>In the library, not downloaded</h3><ul class="storage-list">${notHere
        .map((e) => `<li class="storage-row"><span><strong>${escapeHtml(e.id)}</strong> ${escapeHtml(e.version)}<br/><small>${escapeHtml(e.summary)}</small></span><span><button class="chip" data-test="${escapeHtml(e.id)}" title="Downloads it and runs its tests">Download and test</button></span></li>`)
        .join("")}</ul>`
    : "";
  return `<p class="eyebrow">This computer</p><h2>Ships and storage</h2>
    <ul class="status-list">${docker}${gpu}<li>${icon("save", 15)} ${formatSize(s.disk.freeBytes)} free in ${escapeHtml(s.disk.path)}</li></ul>
    <h3>Downloaded ships</h3><ul class="storage-list">${ships}</ul>
    ${pending}
    ${report ? `<h3>Cache</h3><p class="muted">Results of earlier runs, reused when the same step runs on the same data: ${formatSize(report.cache.usedBytes)} of outputs (limit ${formatSize(report.cache.limitBytes)}). Your data: ${formatSize(report.artifactsBytes)}.</p>` : ""}
    <footer>${report ? `<button data-clear>Clear cache</button>` : ""}<button data-refresh>Refresh</button><button class="primary" data-cancel>Close</button></footer>`;
}

function wire(done: (a: Action) => void, el: HTMLDialogElement) {
  el.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => b.addEventListener("click", () => done({ test: b.dataset.test! })));
  el.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", () => done({ remove: JSON.parse(b.dataset.remove!) })));
  el.querySelector("[data-clear]")?.addEventListener("click", () => done({ clear: true }));
  el.querySelector("[data-refresh]")?.addEventListener("click", () => done({ refresh: true }));
}
