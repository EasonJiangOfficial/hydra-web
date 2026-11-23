import { CENTROID, FADE, LOOP, PHASES, VIEWBOX, frame } from "./snake-rings";

/* Framework-free mount of the Hydra loading logo. The React <HydraLoader> uses it, and Hydra Desktop
   (Tauri) can import it as is. requestAnimationFrame only, paused while the tab is hidden, the still
   mark under prefers-reduced-motion. */

export type HydraLoaderOptions = {
  /** Square size in px. Default 64. */
  size?: number;
  /** "ink" on white, "white" on the ink hero. Default "ink". */
  tone?: "ink" | "white";
  /** Adds role="status" and a visually hidden label to `el`. Leave out when the host already has one. */
  label?: string;
  /** Freeze on this loop time in seconds (fixtures and screenshots). */
  at?: number;
};

const INK = "#1D1D1F";
const WHITE = "#FFFFFF";
let seq = 0;

export function mountHydraLoader(el: HTMLElement, opts: HydraLoaderOptions = {}): { destroy(): void } {
  const size = opts.size ?? 64;
  const id = `hydra-loader-${++seq}`;
  const fill = opts.tone === "white" ? WHITE : INK;
  const [cx, cy] = CENTROID;

  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEWBOX}" aria-hidden="true" focusable="false" style="display:block;overflow:hidden">` +
    `<defs><radialGradient id="${id}-g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${FADE.outer}">` +
    `<stop offset="${(FADE.inner / FADE.outer).toFixed(3)}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>` +
    `<mask id="${id}-m" maskUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000"><rect x="-1000" y="-1000" width="2000" height="2000" fill="url(#${id}-g)"/></mask></defs>` +
    `<g mask="url(#${id}-m)" fill="${fill}"><path/><path/><path/></g></svg>`;
  if (opts.label) {
    el.setAttribute("role", "status");
    const sr = document.createElement("span");
    sr.textContent = opts.label;
    sr.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
    el.appendChild(sr);
  }
  const paths = Array.from(el.querySelectorAll("path"));

  const draw = (t: number) =>
    frame(t).forEach((p, i) => {
      paths[i].setAttribute("d", p.d);
      paths[i].setAttribute("opacity", p.opacity.toFixed(3));
    });

  const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let raf = 0;
  let last = 0;
  let t = 0;

  const tick = (now: number) => {
    t = (t + Math.min(0.1, (now - last) / 1000)) % LOOP;
    last = now;
    draw(t);
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const sync = () => {
    if (opts.at !== undefined) {
      el.dataset.state = "frozen";
      draw(opts.at);
    } else if (reduce?.matches) {
      stop();
      el.dataset.state = "still";
      draw(PHASES.drawEnd); // the drawn mark, before the breath
    } else if (document.hidden) {
      stop();
    } else if (!raf) {
      el.dataset.state = "live";
      last = performance.now();
      draw(t);
      raf = requestAnimationFrame(tick);
    }
  };

  sync();
  document.addEventListener("visibilitychange", sync);
  reduce?.addEventListener("change", sync);
  return {
    destroy() {
      stop();
      document.removeEventListener("visibilitychange", sync);
      reduce?.removeEventListener("change", sync);
      el.innerHTML = "";
      if (opts.label) el.removeAttribute("role");
      delete el.dataset.state;
    },
  };
}
