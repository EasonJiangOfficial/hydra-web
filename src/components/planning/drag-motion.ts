"use client";

/**
 * Drag feel shared by the Board and the Calendar (DESIGN section 7: lift on drag, settle with an
 * ease, no bounce, transform and opacity only). The lifted copy is the DragOverlay child; on a drop
 * or a cancel the real item, already in its final slot, glides in from where the copy was (FLIP)
 * and items that shifted slide from their old place. Reduced motion: nothing slides or tilts, the
 * dropped item fades in briefly.
 */

/** The lifted copy: up 2% and tilted 1 degree. Matches the overlay's motion-safe classes. */
const LIFT = "scale(1.02) rotate(1deg)";
/** How long a settle glides. Callers wait this long before they let the layout move again. */
export const SETTLE_MS = 200;
const FADE_MS = 150;
/** The house ease (theme.css --ease-hydra). */
const EASE = "ease";
/** Moving items paint over still ones; the dropped item paints over the items sliding aside. */
const Z_SHIFTED = "30";
const Z_DROPPED = "31";

/** Screen boxes of every `[attr]` element under `root`, keyed by the attribute, transforms included. */
export function measure(root: ParentNode | null | undefined, attr: string): Map<string, DOMRect> {
  const boxes = new Map<string, DOMRect>();
  root?.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
    const key = el.getAttribute(attr);
    if (key) boxes.set(key, el.getBoundingClientRect());
  });
  return boxes;
}

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** The glide running on an element, and the inline styles it had before the first one. */
const running = new WeakMap<HTMLElement, Animation>();
const saved = new WeakMap<HTMLElement, { position: string; zIndex: string }>();

/** Ends a running glide at once and puts the element's own styles back. */
function stop(el: HTMLElement): void {
  const a = running.get(el);
  if (!a) return;
  running.delete(el);
  a.cancel();
  const s = saved.get(el);
  saved.delete(el);
  if (s) {
    el.style.position = s.position;
    el.style.zIndex = s.zIndex;
  }
}

/** Animate the transform (and the outline, for the dropped card) above the items it passes. */
function glide(el: HTMLElement, from: string, z: string, border?: { from: string; to: string }): void {
  stop(el);
  saved.set(el, { position: el.style.position, zIndex: el.style.zIndex });
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.style.zIndex = z;
  const a = el.animate(
    border ? [{ transform: from, borderColor: border.from }, { transform: "none", borderColor: border.to }] : [{ transform: from }, { transform: "none" }],
    { duration: SETTLE_MS, easing: EASE },
  );
  running.set(el, a);
  // A later glide on the same element replaced this one: leave its styles alone.
  a.onfinish = () => {
    if (running.get(el) === a) stop(el);
  };
}

/** A theme color as the browser resolves it (keyframes need a real color, not a var()). */
const token = (name: string) => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/**
 * Call right before the drop or cancel commits; runs on the next frame, after React has put the
 * item in its slot and before that frame paints.
 * - `root`, `attr`: where the items are and the attribute that keys them.
 * - `dropped`: the key of the item that was dragged, as it reads after the commit ("" for none:
 *   every item that moved just slides, as after a rollback).
 * - `lifted`: the box of the lifted copy at release (null: keyboard or unknown, no glide).
 * - `before`: `measure(root, attr)` taken before the commit, so shifted items slide.
 */
export function settle(opts: {
  root: ParentNode | null | undefined;
  attr: string;
  dropped: string;
  lifted: DOMRect | null;
  before: Map<string, DOMRect>;
  reduced: boolean;
  /** The lifted copy has an ink outline and the item a rule one (Board cards). */
  inkOutline?: boolean;
}): void {
  const { root, attr, dropped, lifted, before, reduced } = opts;
  requestAnimationFrame(() => {
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`));
    // An earlier settle still running: measure where things rest, not where they are mid-glide.
    items.forEach(stop);
    const el = dropped ? items.find((i) => i.getAttribute(attr) === dropped) : undefined;
    if (reduced) {
      el?.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: FADE_MS, easing: EASE });
      return;
    }
    if (el && lifted) {
      const a = center(lifted);
      const b = center(el.getBoundingClientRect());
      // A card's lifted copy has an ink outline: it fades to the card's rule as it lands, so it reads as one card.
      const ink = token("--ink");
      const rule = token("--rule");
      glide(el, `translate(${a.x - b.x}px, ${a.y - b.y}px) ${LIFT}`, Z_DROPPED, opts.inkOutline && ink && rule ? { from: ink, to: rule } : undefined);
    }
    items.forEach((item) => {
      const key = item.getAttribute(attr);
      const was = key && key !== dropped ? before.get(key) : undefined;
      if (!was) return;
      const now = item.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      glide(item, `translate(${dx}px, ${dy}px)`, Z_SHIFTED);
    });
  });
}

/** No text selection and no iOS callout anywhere while an item is held. */
export function holdSelection(on: boolean): void {
  const s = document.documentElement.style;
  s.userSelect = on ? "none" : "";
  s.setProperty("-webkit-user-select", on ? "none" : "");
}

/**
 * A short tick when a finger picks an item up (Android; iOS Safari has no vibrate). Chrome allows
 * vibrate only after a tap on the page, and the touch that starts the hold is not one yet.
 */
export function pickUpTick(activator: Event | null | undefined): void {
  if (typeof TouchEvent === "undefined" || !(activator instanceof TouchEvent)) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  navigator.vibrate?.(10);
}
