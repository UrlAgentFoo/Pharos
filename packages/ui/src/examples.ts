/**
 * Example cards: a picture of the data, what it is, its name and the
 * question it comes with. On the start screen "View examples" puts them in
 * the drop area's place, at its height, as one row that scrolls sideways
 * (the arrows, a trackpad, or Tab) and fades at the sides with more cards,
 * until "See more", beside "Hide examples", lays them all out in a grid.
 * The Example data… dialog shows the grid.
 */
import type { Example } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";

export const exampleCards = (examples: Example[]) =>
  examples
    .map(
      (e) => `<button class="example" data-example="${escapeHtml(e.id)}" title="${escapeHtml(e.description)}">
        <span class="example-pic">${e.image ? `<img data-pic="${escapeHtml(e.id)}" alt="" />` : icon("flask", 22)}</span>
        <span class="example-text"><small class="eyebrow">${escapeHtml(e.kind)}</small><strong>${escapeHtml(e.title)}</strong>
        <em>“${escapeHtml(e.prompt)}”</em></span></button>`,
    )
    .join("");

/** Each picture as an object URL, fetched once: the token travels in a header, which `<img src>` can't send. */
const pictures = new Map<string, Promise<string | null>>();

/** Fills in the pictures of the cards under `root`. */
export function showPictures(s: LocalServer, root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>("img[data-pic]:not([src])").forEach((img) => {
    const id = img.dataset.pic!;
    if (!pictures.has(id)) pictures.set(id, s.exampleImage(id).then((b) => URL.createObjectURL(b), () => null));
    void pictures.get(id)!.then((url) => {
      if (!url) return;
      img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
      img.src = url;
    });
  });
}

const GAP = 12; // the list's gap, in px
const FADE = 48; // each faded edge of the row (`--fade` in the stylesheet), in px

const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** Wires the start screen's "View examples", "See more" and arrows; `onOpen` runs each time the examples show. */
export function wireExampleGallery(onOpen: () => void) {
  const toggle = document.getElementById("examples-toggle") as HTMLButtonElement;
  const stage = document.getElementById("welcome-stage")!;
  const section = document.getElementById("examples")!;
  const list = document.getElementById("example-list")!;
  const more = document.getElementById("examples-more") as HTMLButtonElement;
  const [prev, next] = [...section.querySelectorAll<HTMLButtonElement>("[data-scroll]")];
  toggle.innerHTML = `${icon("flask", 15)}<span>View examples</span><span class="caret" aria-hidden="true">▾</span>`;
  more.innerHTML = `${icon("overview", 15)}<span>See more</span>`;
  prev.innerHTML = icon("chevron-left", 16);
  next.innerHTML = icon("chevron-right", 16);

  const update = () => {
    const grid = list.classList.contains("grid");
    const [end, left] = [list.scrollWidth - list.clientWidth, list.scrollLeft];
    // only while the examples show, and only when there are more than fit
    more.hidden = !stage.classList.contains("examples-on") || (!grid && end <= 1);
    prev.hidden = next.hidden = grid || end <= 1;
    prev.disabled = left <= 1;
    next.disabled = left >= end - 1;
    // each side fades while cards wait beyond it
    list.classList.toggle("more-before", !grid && !prev.disabled);
    list.classList.toggle("more-after", !grid && !next.disabled);
  };
  const showGrid = (grid: boolean) => {
    list.classList.toggle("grid", grid);
    more.setAttribute("aria-expanded", String(grid));
    more.querySelector("span")!.textContent = grid ? "See less" : "See more";
    list.scrollLeft = 0;
    update();
  };
  toggle.addEventListener("click", () => {
    const on = stage.classList.toggle("examples-on");
    toggle.setAttribute("aria-expanded", String(on));
    toggle.querySelector("span")!.textContent = on ? "Hide examples" : "View examples";
    if (!on) return showGrid(false); // the drop area comes back at the row's height, not the grid's
    onOpen();
    update();
  });
  more.addEventListener("click", () => {
    showGrid(!list.classList.contains("grid"));
    if (list.classList.contains("grid")) section.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  });
  for (const b of [prev, next])
    b.addEventListener("click", () => {
      // a page of the whole cards between the faded edges; the snap points line the next one up
      const card = (list.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
      const page = Math.max(1, Math.floor((list.clientWidth - 2 * FADE + GAP) / (card + GAP))) * (card + GAP);
      list.scrollBy({ left: Number(b.dataset.scroll) * page, behavior: scrollBehavior() });
    });
  // the browser leaves a half-hidden card where it is when Tab reaches it
  list.addEventListener("focusin", (e) => {
    if (!list.classList.contains("grid")) (e.target as HTMLElement).closest(".example")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
  });
  list.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", () => stage.classList.contains("examples-on") && update());
}
