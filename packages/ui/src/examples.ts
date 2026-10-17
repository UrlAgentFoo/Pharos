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
/** How far the eye is from the ring's middle, in px: each card is seen through `perspective()` from there. */
const PERSPECTIVE = 1200;
/**
 * The ring's scene is SCENE_W px wide, and as tall as the ring needs (measured in `measure`). The ring is laid
 * out in it, never in the window, and the scene is scaled as a whole to fit: zooming the page then makes the
 * ring larger or smaller without changing the angle it's seen from.
 */
const SCENE_W = 1500;
/** Below this scale the cards are too small to read, and the grid shows instead. */
const MIN_SCALE = 0.45;
/** How near the front of the ring comes, and how far off the back goes, in px. */
const NEAR = 200;
const FAR = 760;
/** How much the back of the ring rises, against how far the front falls: the ring is seen nearly side on. */
const BACK_RISE = 0.45;
/** How far the light on the floor under the centre reaches below it, and half its width (`.ring-on .welcome-centre::after`). */
const FLOOR_BELOW = 48;
const FLOOR_HALF = 260;
/** How far the centre stands above the ring's middle: the front cards then clear it with a flatter ring. */
const LIFT = 64;
/** The clear space between the light on the floor and the tops of the front cards, and around the scene's edges. */
const GAP = 20;
const EDGE = 48;
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
  const scene = document.getElementById("ring-scene")!;
  const centre = stage.querySelector<HTMLElement>(".welcome-centre")!;
  /** The ring's size and the scene's height, measured in ring mode; `place` and `scale` use them. */
  let geo = { rx: 0, ry: 0, sceneH: 820 };
  /** How much perspective enlarges something at depth `z`. */
  const grow = (z: number) => PERSPECTIVE / (PERSPECTIVE - z);
  /** The ring's depth behind or before the centre at angle `t` (90° is the front). */
  const depth = (t: number) => Math.sin(t) * (Math.sin(t) > 0 ? NEAR : FAR);
  /** How far below the ring's middle a card sits at angle `t` (above it, at the back). */
  const drop = (t: number, ry: number) => Math.sin(t) * (Math.sin(t) > 0 ? ry : ry * BACK_RISE);

  /**
   * The ring as tall as it must be for every front card that passes under the light on the floor to clear
   * it by GAP, and the scene as tall as the ring and the centre need, with the ring's middle where they fit.
   */
  const measure = () => {
    const card = ringCards()[0];
    const cardW = card?.offsetWidth || 228;
    const cardH = card?.offsetHeight || 200;
    const rx = SCENE_W / 2 - cardW / 2 - 20;
    const clear = centre.offsetHeight / 2 - LIFT + FLOOR_BELOW + GAP;
    let ry = 0;
    for (let k = 1; k < 90; k++) {
      const t = (k / 90) * Math.PI;
      const g = grow(depth(t));
      // a card wholly to one side of the light can rise past it
      if (g * (Math.abs(Math.cos(t) * rx) - cardW / 2) < FLOOR_HALF) ry = Math.max(ry, (clear / g + cardH / 2) / Math.sin(t));
    }
    // how far the ring (and the centre with its backdrop) reach above and below the ring's middle
    let above = centre.offsetHeight / 2 + LIFT + 64;
    let below = 0;
    for (let k = 0; k < 180; k++) {
      const t = (k / 180) * 2 * Math.PI;
      const g = grow(depth(t));
      above = Math.max(above, g * (cardH / 2 - drop(t, ry)));
      below = Math.max(below, g * (cardH / 2 + drop(t, ry)));
    }
    const top = above + EDGE / 2;
    geo = { rx, ry, sceneH: Math.ceil(top + below + EDGE) };
    scene.style.height = `${geo.sceneH}px`;
    scene.style.setProperty("--ring-y", `${top.toFixed(1)}px`);
    scene.style.setProperty("--centre-y", `${(top - LIFT).toFixed(1)}px`);
    scene.style.setProperty("--card-h", `${cardH}px`);
  };
  /** The scene's scale that fits the stage; never above 1, so zooming the page in makes the ring larger. */
  const scale = () => Math.min(1, stage.clientWidth / SCENE_W, stage.clientHeight / geo.sceneH);
  const ring = () => stage.classList.contains("ring-on");

  /**
   * Each card at its place on the ellipse, turned to face outwards like a card on a carousel: square on
   * at the front and the back (where it shows its reverse, mirrored, under a veil, so the front stays
   * clear), and edge-on at the ring's leftmost and rightmost points on screen. The turn is measured from
   * the line between your eye and the card, so it reads that way through the perspective too.
   */
  const place = () => {
    const shown = ringCards();
    if (!shown.length) return;
    const { rx, ry } = geo;
    // the leftmost and rightmost points on screen are a little in front of the ring's sides, where
    // cos t / (PERSPECTIVE - NEAR sin t) is largest
    const side = Math.asin(NEAR / PERSPECTIVE);
    const step = (2 * Math.PI) / shown.length;
    shown.forEach((card, i) => {
      // t from the right-hand side, round through the front and the left, to the back and round again
      const tau = 2 * Math.PI;
      const t = ((((angle + i * step - side) % tau) + tau) % tau) + side;
      // how far round the card has turned from facing you: 0 at the front, 90° at the sides, 180° at the back
      const facing =
        t <= Math.PI - side
          ? ((Math.PI / 2 - t) / (Math.PI / 2 - side)) * (Math.PI / 2)
          : -Math.PI / 2 - ((t - (Math.PI - side)) / (Math.PI + 2 * side)) * Math.PI;
      const x = Math.cos(t) * rx;
      const z = depth(t);
      // the turn that faces the card to your eye, then turned round from there
      const turn = Math.atan2(-x, PERSPECTIVE - z) + facing;
      // each card stands at the ring's middle before it moves, so its own perspective sees it from the one eye there
      card.style.transform = `perspective(${PERSPECTIVE}px) translate3d(${x.toFixed(1)}px, ${drop(t, ry).toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${turn.toFixed(4)}rad)`;
      card.style.zIndex = String(Math.round(z));
      card.classList.toggle("away", Math.cos(facing) < 0);
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
    measure();
    const asRing = n > 0 && !grid() && scale() >= MIN_SCALE;
    scene.style.setProperty("--ring-scale", scale().toFixed(4));
    stage.classList.toggle("ring-on", asRing);
    stage.classList.toggle("flat", n > 0 && !grid() && !asRing);
    list.classList.toggle("grid", !asRing);
    cards().forEach((c, i) => {
      c.classList.toggle("beyond-ring", asRing && i >= RING_MAX);
      if (!asRing) {
        c.style.transform = "";
        c.style.zIndex = "";
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
