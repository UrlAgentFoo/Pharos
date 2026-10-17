/**
 * Example cards: a picture of the data, what it is, its name and the
 * question it comes with. On the start screen they stand in a ring around
 * the drop area, seen a little from above, which turns slowly (hovering or
 * focusing a card stops it; the arrows turn it a card at a time; a card Tab
 * reaches comes round to the front). "See all examples" lays every card out
 * in a grid under the drop area, with "Hide examples" at its foot. Where the
 * screen is too small for a ring, the grid shows instead. The Example data…
 * dialog shows the grid.
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

/** The most cards in the ring; "See all examples" shows the rest. */
const RING_MAX = 14;
/** The ring's perspective, in px: `perspective` on .welcome-stage.ring-on in the stylesheet. */
const PERSPECTIVE = 1200;
/** How near the front of the ring comes, in px (the back goes much further off). */
const NEAR = 200;
/** One turn of the ring, in seconds, while nothing holds it. */
const TURN_SECONDS = 90;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Wires the start screen's ring of examples and its grid; `onShow` runs once there are cards to show (their pictures load then). */
export function wireExampleGallery(onShow: () => void) {
  const stage = document.getElementById("welcome-stage")!;
  const list = document.getElementById("example-list")!;
  const more = document.getElementById("examples-more") as HTMLButtonElement;
  const hide = document.getElementById("examples-toggle") as HTMLButtonElement;
  const turns = [...stage.querySelectorAll<HTMLButtonElement>("[data-turn]")];
  more.innerHTML = `${icon("overview", 15)}<span>See all examples</span>`;
  hide.innerHTML = `${icon("collapse", 15)}<span>Hide examples</span>`;
  turns[0].innerHTML = icon("chevron-left", 16);
  turns[1].innerHTML = icon("chevron-right", 16);

  let angle = Math.PI / 2; // where the first card is: at the front
  let target = angle;
  let held = false; // a pointer or focus on a card stops the turning
  let last = 0;
  let frame = 0;

  const cards = () => [...list.querySelectorAll<HTMLElement>(".example")];
  const ringCards = () => cards().slice(0, RING_MAX);
  const grid = () => stage.classList.contains("grid-on");
  const welcome = document.getElementById("welcome")!;
  const centre = stage.querySelector<HTMLElement>(".welcome-centre")!;
  /** How far down the front of the ring may sit: low enough to pass under the centre, high enough to stay on screen. */
  const ringDepth = (h: number, cardH: number) => {
    const grow = PERSPECTIVE / (PERSPECTIVE - NEAR);
    return { least: (centre.offsetHeight / 2 + 16) / grow + cardH / 2, most: (h / 2 - 48) / grow - cardH / 2 };
  };
  // room for a ring, measured in ring mode (the centre and the cards are smaller there): wide enough, and
  // tall enough for the front of the ring to pass under the centre and stay on screen
  const fits = () => {
    if (welcome.clientWidth < 900) return false;
    const d = ringDepth(stage.clientHeight, cards()[0]?.offsetHeight || 150);
    return d.most >= d.least;
  };
  const ring = () => stage.classList.contains("ring-on");

  /**
   * Each card at its place on the ellipse, turned to face outwards like a card on a carousel: the
   * front at the bottom and nearest, facing you; the sides edge-on; the back at the top, showing its
   * reverse (mirrored, under a veil), so the front stays clear.
   */
  const place = () => {
    const shown = ringCards();
    if (!shown.length) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const cardH = shown[0].offsetHeight || 150;
    // wide, and much deeper behind than in front: the back of the ring feels far off, the front stays its size
    const rx = Math.min(w / 2 - 110, 820);
    const near = NEAR;
    const far = 760;
    // perspective enlarges a near card's place as well as its size: as low as the front cards can go
    // and still clear the bottom (and its hint); they pass under the drop area, never over it
    const ry = ringDepth(h, cardH).most;
    const step = (2 * Math.PI) / shown.length;
    shown.forEach((card, i) => {
      const t = angle + i * step;
      // facing outwards: at the front (t = 90°) square on, at the back turned half round
      const turn = Math.PI / 2 - t;
      const z = Math.sin(t) * (Math.sin(t) > 0 ? near : far);
      card.style.transform = `translate3d(${(Math.cos(t) * rx).toFixed(1)}px, ${(Math.sin(t) * ry).toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${turn.toFixed(4)}rad)`;
      card.classList.toggle("away", Math.cos(turn) < 0);
    });
  };

  const tick = (now: number) => {
    frame = 0;
    if (!ring() || !stage.offsetParent) return; // nothing to turn while the start screen is away
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (!held && !reducedMotion()) target += ((2 * Math.PI) / TURN_SECONDS) * dt;
    angle += (target - angle) * Math.min(1, dt * 6);
    if (reducedMotion()) angle = target;
    place();
    frame = requestAnimationFrame(tick);
  };
  const run = () => {
    if (!frame && ring()) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  };

  /** The ring, the grid of every card, or (on a small screen) the grid without the ring to come back to. */
  const layout = () => {
    const n = cards().length;
    // try the ring, then keep it only if it fits (all before the next paint, so nothing flickers)
    stage.classList.add("ring-on");
    list.classList.remove("grid");
    const asRing = n > 0 && !grid() && fits();
    stage.classList.toggle("ring-on", asRing);
    stage.classList.toggle("flat", n > 0 && !grid() && !asRing);
    list.classList.toggle("grid", !asRing);
    cards().forEach((c, i) => {
      c.classList.toggle("beyond-ring", asRing && i >= RING_MAX);
      if (!asRing) {
        c.style.transform = "";
        c.classList.remove("away");
      }
    });
    more.hidden = !asRing;
    for (const b of turns) b.hidden = !asRing;
    hide.hidden = !grid();
    more.setAttribute("aria-expanded", String(grid()));
    if (asRing) {
      place();
      run();
    }
  };

  // the cards arrive (and change) from the library: lay them out, and load their pictures
  new MutationObserver(() => {
    layout();
    if (cards().length) onShow();
  }).observe(list, { childList: true });

  more.addEventListener("click", () => {
    stage.classList.add("grid-on");
    layout();
    list.querySelector<HTMLElement>(".example")?.focus({ preventScroll: true });
    list.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  });
  hide.addEventListener("click", () => {
    stage.classList.remove("grid-on");
    layout();
    more.focus({ preventScroll: true });
    stage.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  });
  for (const b of turns) {
    b.addEventListener("click", () => {
      const n = ringCards().length;
      if (n) target -= Number(b.dataset.turn) * ((2 * Math.PI) / n);
      run();
    });
  }
  // a card being looked at holds still; one Tab reaches comes round to the front
  list.addEventListener("pointerover", (e) => {
    if ((e.target as HTMLElement).closest(".example")) held = true;
  });
  list.addEventListener("pointerout", (e) => {
    if (!list.contains(e.relatedTarget as Node | null) || !(e.relatedTarget as HTMLElement | null)?.closest(".example")) held = false;
  });
  list.addEventListener("focusin", (e) => {
    held = true;
    const i = ringCards().indexOf((e.target as HTMLElement).closest(".example") as HTMLElement);
    if (!ring() || i < 0) return;
    const step = (2 * Math.PI) / ringCards().length;
    // the turn that brings it to the front by the shortest way
    const front = Math.PI / 2 - i * step;
    target = front + Math.round((angle - front) / (2 * Math.PI)) * 2 * Math.PI;
    run();
  });
  list.addEventListener("focusout", (e) => {
    if (!list.contains(e.relatedTarget as Node | null)) held = false;
  });
  window.addEventListener("resize", layout);
  // the start screen comes back when the last window closes
  new MutationObserver(() => {
    if (stage.offsetParent) {
      layout();
      run();
    }
  }).observe(welcome, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && run());
}
