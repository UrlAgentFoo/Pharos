/**
 * Example cards: a picture of the data, what it is, its name and the
 * question it comes with. On the start screen they stand in a ring around
 * the drop area, standing on a band seen a little from above, which turns slowly (hovering or
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
        <em>“${escapeHtml(e.prompt)}”</em></span><span class="example-edge" aria-hidden="true"></span></button>`,
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
/**
 * The ring is a band: two circles of one radius, one above the other a card's height apart, and each card
 * stands flush on it, its top corners on the upper circle and its bottom corners on the lower. One eye looks
 * at the band from in front and above it, level, as through a shift lens: the cards all stand upright on
 * screen, and every card's place, turn and size follow from the band and the eye.
 * The band's middle is one radius behind the screen, so the front cards are at about their own size, and the
 * eye is EYE radii in front of the screen: nearer makes the back of the band look farther off.
 */
const EYE = 1.3;
/** How far the eye looks down on the band's middle: lower brings the front of the band up towards the drop area. */
const ELEVATION = (15 * Math.PI) / 180;
/**
 * The ring's scene is SCENE_W px wide, and as tall as the band needs (measured in `measure`). The band is as
 * wide as the scene allows, laid out in it and never in the window, and the scene is scaled as a whole to
 * fit: zooming the page then makes the ring larger or smaller without changing the angle it's seen from.
 */
const SCENE_W = 1500;
/** Below this scale the cards are too small to read, and the grid shows instead. */
const MIN_SCALE = 0.45;
/** How far the light on the floor under the centre reaches below it, and half its width (`.ring-on .welcome-centre::after`). */
const FLOOR_BELOW = 158;
const FLOOR_HALF = 200;
/**
 * That light is two circles on the floor round the band's axis, seen by the band's eye: its heart POOL_R
 * across, and its glow as wide on screen as the light (twice FLOOR_HALF). Their middle is at least POOL_MID
 * above the light's foot on screen.
 */
const POOL_R = 200;
const POOL_MID = 28;
/** How far the centre stands above the ring's middle, at least: more if the front cards need it to clear the light. */
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
  /**
   * The band, measured in ring mode: its radius, how far its cards' edges stand in from it (they're chords
   * of its circles), the eye's distance and its height above the band's middle, and the scene's height.
   */
  let geo = { radius: 1000, inset: 990, eye: 1300, height: 300, sceneH: 820 };
  type Band = typeof geo;
  /** How far the centre stands above the band's middle on screen (LIFT, or more for the front cards to clear the light). */
  let lift = LIFT;
  /**
   * Where the point (u, v) of a card at turn `phi` (0 at the front, 90° at the right) lands: x and y on the
   * screen from the band's middle, and its depth before (+) or behind (−) the band's middle. The same steps
   * as the card's CSS transform in `place`: the eye looks level, so upright lines stay upright, and the
   * picture is shifted so the band's middle stays where it is.
   */
  const project = (b: Band, phi: number, u: number, v: number) => {
    const x = u * Math.cos(phi) + b.inset * Math.sin(phi);
    const depth = -u * Math.sin(phi) + b.inset * Math.cos(phi);
    const k = b.eye / (b.eye + b.radius - depth);
    return { x: x * k, y: (v + b.height) * k - b.height * (b.eye / (b.eye + b.radius)), depth };
  };
  const band = (radius: number, height: number, cardW: number): Band => ({
    radius,
    inset: Math.sqrt(Math.max(0, radius * radius - (cardW / 2) ** 2)),
    eye: EYE * radius,
    height,
    sceneH: geo.sceneH,
  });
  /** Each card's corners at `steps` turns round the band, with whether the card is in the front half. */
  const corners = (b: Band, cardW: number, cardH: number, steps = 180) => {
    const out: { xs: number[]; ys: number[]; front: boolean }[] = [];
    for (let k = 0; k < steps; k++) {
      const phi = (k / steps) * 2 * Math.PI;
      const pts = [-1, 1].flatMap((su) => [-1, 1].map((sv) => project(b, phi, (su * cardW) / 2, (sv * cardH) / 2)));
      out.push({ xs: pts.map((q) => q.x), ys: pts.map((q) => q.y), front: Math.cos(phi) > 0 });
    }
    return out;
  };

  /**
   * The band as wide as the scene, seen from ELEVATION, with the centre raised above the band's middle just
   * enough for every front card that passes under the light on the floor to clear it by GAP, and the scene
   * as tall as the band and the centre need.
   */
  const measure = () => {
    const card = ringCards()[0];
    const cardW = card?.offsetWidth || 262;
    const cardH = card?.offsetHeight || 230;
    const halfW = SCENE_W / 2 - EDGE / 2;
    // the largest radius that fits the scene's width (the eye's height doesn't change how wide it looks)
    let lo = cardW, hi = 8000;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const reach = Math.max(...corners(band(mid, 0, cardW), cardW, cardH, 90).flatMap((c) => c.xs.map(Math.abs)));
      if (reach > halfW) hi = mid;
      else lo = mid;
    }
    const radius = lo;
    const b = band(radius, Math.tan(ELEVATION) * (EYE * radius + radius), cardW);
    // the centre high enough that the light's foot is GAP above every front card under it (a card wholly
    // to one side of the light can rise past it)
    const tops = corners(b, cardW, cardH)
      .filter((c) => c.front && Math.min(...c.xs) < FLOOR_HALF && Math.max(...c.xs) > -FLOOR_HALF)
      .map((c) => Math.min(...c.ys));
    lift = Math.max(LIFT, centre.offsetHeight / 2 + FLOOR_BELOW + GAP - Math.min(Infinity, ...tops));
    // how far the band (and the centre with its backdrop) reach above and below the band's middle
    let above = centre.offsetHeight / 2 + lift + 64;
    let below = 0;
    for (const c of corners(b, cardW, cardH)) {
      above = Math.max(above, -Math.min(...c.ys));
      below = Math.max(below, Math.max(...c.ys));
    }
    const top = above + EDGE / 2;
    geo = { ...b, sceneH: Math.ceil(top + below + EDGE) };
    scene.style.height = `${geo.sceneH}px`;
    scene.style.setProperty("--ring-y", `${top.toFixed(1)}px`);
    scene.style.setProperty("--centre-y", `${(top - lift).toFixed(1)}px`);
    scene.style.setProperty("--card-h", `${cardH}px`);
    shapePool();
  };
  /**
   * The light on the floor: its heart and its glow, circles on the floor round the band's axis, seen by the
   * same eye as the band, so they lie as flat as it does, on the level that shows them where the light is
   * (`.ring-on .welcome-centre::after`).
   */
  const shapePool = () => {
    // a circle's width and height on screen, at level v
    const shape = (r: number, v: number) => {
      const pts = Array.from({ length: 120 }, (_, k) => project({ ...geo, inset: r }, (k / 120) * 2 * Math.PI, 0, v));
      return {
        w: Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)),
        h: Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y)),
      };
    };
    let mid = POOL_MID;
    let heart = { w: 0, h: 0 }, glow = { w: 0, h: 0 };
    for (let pass = 0; pass < 3; pass++) {
      const at = centre.offsetHeight / 2 + FLOOR_BELOW - mid - lift; // below the band's middle on screen
      let lo = -4000, hi = 4000;
      for (let k = 0; k < 40; k++) {
        const v = (lo + hi) / 2;
        if (project({ ...geo, inset: 0 }, 0, 0, v).y > at) hi = v;
        else lo = v;
      }
      heart = shape(POOL_R, lo);
      // the glow's circle, scaled to be as wide on screen as the light
      glow = shape((POOL_R * 2 * FLOOR_HALF) / heart.w, lo);
      mid = Math.max(POOL_MID, glow.h / 2);
    }
    scene.style.setProperty("--pool-w", `${heart.w.toFixed(1)}px`);
    scene.style.setProperty("--pool-h", `${heart.h.toFixed(1)}px`);
    scene.style.setProperty("--glow-w", `${glow.w.toFixed(1)}px`);
    scene.style.setProperty("--glow-h", `${glow.h.toFixed(1)}px`);
    scene.style.setProperty("--pool-mid", `${mid.toFixed(1)}px`);
  };
  /** The scene's scale that fits the stage; never above 1, so zooming the page in makes the ring larger. */
  const scale = () => Math.min(1, stage.clientWidth / SCENE_W, stage.clientHeight / geo.sceneH);
  const ring = () => stage.classList.contains("ring-on");

  /**
   * Each card flush on the band, facing outwards: square on at the front, and at the back showing its reverse,
   * a little see-through. Each card is seen through its own `perspective()`
   * from where they all start, the band's middle on screen, so all share the one eye, and they're stacked by
   * depth: a nearer card always covers a farther one, the front passes before the drop area and the back behind.
   */
  const place = () => {
    const shown = ringCards();
    if (!shown.length) return;
    const { radius, inset, eye, height } = geo;
    const shift = height * (eye / (eye + radius));
    const step = (2 * Math.PI) / shown.length;
    shown.forEach((card, i) => {
      // the turn from the front, where `angle` 90° is: increasing `angle` carries the cards from right to left
      const phi = Math.PI / 2 - (angle + i * step);
      const depth = inset * Math.cos(phi);
      // the card faces you while its outward side looks towards the eye
      const toEye = Math.cos(phi) * (eye + radius) - inset;
      card.style.transform = `translateY(${(-shift).toFixed(1)}px) perspective(${eye.toFixed(1)}px) translateY(${height.toFixed(1)}px) translateZ(${(-radius).toFixed(1)}px) rotateY(${phi.toFixed(4)}rad) translateZ(${inset.toFixed(1)}px)`;
      card.style.zIndex = String(Math.round(depth));
      card.classList.toggle("away", toEye < 0);
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
