"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  blend,
  blendStep,
  blendTo,
  dotCount,
  dotFloor,
  dotRadius,
  frameDelay,
  levelBands,
  ORB_R,
  pendingOrbit,
  pendingPulse,
  place,
  placed,
  PRESS_MS,
  scene,
  smoothBands,
  sphere,
  spots,
  spotStep,
  springTo,
  WAKE_FADE_MS,
  WAKE_MS,
  yawSpeed,
  type Placed,
  type Sphere,
  type Wake,
} from "./orb-math";
import type { AgentStatus } from "./types";

export type OrbProps = {
  status: AgentStatus;
  /** 0..1 audio level, read every frame (the microphone while listening, Hydra's voice while speaking). */
  getLevel?: () => number;
  /** The spectrum, read every frame into `out` (24 bands, 0..1, low to high); false when there is none. */
  getBands?: (out: Float32Array) => boolean;
  /** `ink` for white surfaces, `white` on an ink block. */
  tone?: "ink" | "white";
  /** When Hydra Desktop last woke on a clap or the wake phrase (epoch ms): the wake burst, then the awake shimmer. */
  wokeAt?: number | null;
  className?: string;
};

const INK: [number, number, number] = [29, 29, 31];
const WHITE: [number, number, number] = [255, 255, 255];
const BUCKETS = 8;
const BANDS = 24;
/** The pointer's presence fades in and out over about 120 ms; its position follows in about 60 ms (sub-pixel smooth). */
const HOVER_TAU = 0.12;
const POINT_TAU = 0.06;
/** Reduced motion draws this one moment. */
const STILL_T = 1.5;

/**
 * The Hydra Agent orb: a see-through dust sphere of crisp dots (90 to 800 by size and density) in ink or white,
 * alpha only, no glow, no gradient, no color. Fills its parent square. Each status has its own look, eased over 250 ms
 * (orb-math):
 * listening draws in and ripples with the owner's voice, pending (thinking) carries an orbiting band and pulses with
 * the Mac's pending sound, speaking pushes out on Hydra's syllables, asleep is small, faint and slow. Bands are
 * sprung per band (fast attack, slow release) and blurred into one membrane, lows at the bottom, highs at the top,
 * and erupt in one patch that turns with the sphere (orb-math spotStep), the rest of the dust calm.
 * The pointer tilts the sphere toward itself and pulls the nearby dots; a press sends a ripple. A desktop wake (clap
 * or phrase) plays the burst, then the shimmer. Reduced motion: a still sphere; a status shows only as alpha.
 *
 * One canvas and one requestAnimationFrame loop that reads the level and bands itself (never a React render per
 * frame) and allocates nothing per frame: 60 fps awake, 10 asleep once still, none while it is not on the page
 * (display: none), off screen or in a hidden tab. Dots of one shade fill as one path: at most 9 fills a frame.
 */
export function Orb({ status, getLevel, getBands, tone = "ink", wokeAt = null, className }: OrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ status, getLevel, getBands, wokeAt });
  const repaint = useRef<() => void>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const rgb = tone === "white" ? WHITE : INK;
    const fills = Array.from({ length: BUCKETS + 1 }, (_, i) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(i / BUCKETS).toFixed(3)})`);
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reduced = Boolean(mq?.matches);
    let onScreen = true;
    let size = 0;
    let dpr = 1;
    let raf = 0;
    let nap: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    // Sized on fit(): the dots, their placement and the shade sort.
    let dots: Sphere = sphere(0);
    let out: Placed = placed(0);
    let order = new Uint16Array(0);
    const counts = new Int32Array(BUCKETS + 2);
    // Springs and buffers: one set for the loop's life.
    const raw = new Float32Array(BANDS);
    const bx = new Float32Array(BANDS);
    const bv = new Float32Array(BANDS);
    const membrane = new Float32Array(BANDS);
    const tmp = new Float32Array(BANDS);
    const lx = new Float32Array(1);
    const lv = new Float32Array(1);
    // Where the voice erupts: a patch on the sphere that turns with it.
    const hot = spots();
    const t0 = performance.now();
    const mix = blend(live.current.status, 0);
    const sc = scene(live.current.status);
    sc.w = mix.w;
    const wake: Wake = { ms: 0, awake: false };
    let last = t0;
    let thinkingAt = t0;
    // The pointer, in sphere units, and the last press (ms on the performance clock).
    let pointer = false;
    let px = 0;
    let py = 0;
    let pressAt = -Infinity;
    let pressX = 0;
    let pressY = 0;

    const draw = () => {
      raf = 0;
      nap = undefined;
      const { status: st, getLevel: read, getBands: readBands, wokeAt: woke } = live.current;
      const nowMs = performance.now();
      const t = (nowMs - t0) / 1000;
      const dt = Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
      last = nowMs;
      if (st === "thinking" && mix.to !== 2) thinkingAt = nowMs;
      blendTo(mix, st, t);
      const settled = blendStep(mix, t) >= 1;
      // The wake's stamp is the desktop's clock (Date.now() on the same Mac).
      const since = woke ? Math.max(0, Date.now() - woke) : Infinity;
      const bursting = since < WAKE_MS;
      const voiced = st === "speaking" || st === "listening";
      let pressing = false;
      if (reduced) {
        sc.still = true;
        sc.t = STILL_T;
        sc.turn = 0.6;
        sc.m = null;
        sc.wake = null;
        sc.hover = 0;
        sc.press = -1;
      } else {
        sc.still = false;
        sc.t = t;
        sc.turn += dt * yawSpeed(mix.w);
        // Level and bands only while there is a voice to show; a bare level makes voice-shaped bands.
        const target = voiced ? Math.min(1, Math.max(0, read?.() ?? 0)) : 0;
        springTo(lx, lv, 0, target, dt);
        sc.level = lx[0];
        const got = voiced && !!readBands?.(raw);
        if (!got) {
          if (voiced && target > 0) levelBands(raw, target, t);
          else raw.fill(0);
        }
        let peak = 0;
        for (let i = 0; i < BANDS; i++) {
          springTo(bx, bv, i, Math.min(1, Math.max(0, raw[i])), dt);
          if (bx[i] > peak) peak = bx[i];
        }
        smoothBands(bx, membrane, tmp);
        sc.m = peak > 0.003 ? membrane : null;
        spotStep(hot, membrane, target, sc.turn, dt);
        sc.sp = hot;
        const sinceThink = (nowMs - thinkingAt) / 1000;
        sc.pulse = pendingPulse(sinceThink);
        sc.orbit = pendingOrbit(sinceThink);
        const kh = 1 - Math.exp(-dt / HOVER_TAU);
        const kp = 1 - Math.exp(-dt / POINT_TAU);
        sc.hover += ((pointer ? 1 : 0) - sc.hover) * kh;
        if (sc.hover < 0.001) sc.hover = 0;
        sc.hx += (px - sc.hx) * kp;
        sc.hy += (py - sc.hy) * kp;
        const pms = nowMs - pressAt;
        pressing = pms < PRESS_MS;
        sc.press = pressing ? pms : -1;
        sc.qx = pressX;
        sc.qy = pressY;
        wake.ms = since;
        wake.awake = st !== "asleep";
        sc.wake = woke ? wake : null;
      }
      place(dots, sc, out);
      let fade = 1;
      // A wake under reduced motion: no motion, a fade from the asleep alpha to full.
      if (reduced && since < WAKE_FADE_MS && st !== "asleep") fade = 0.5 + 0.5 * (since / WAKE_FADE_MS);

      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const R = size * ORB_R;
      const dot = dotRadius(size);
      // Sort by shade (counting sort into `order`): faint first, so the front paints over the back.
      counts.fill(0);
      for (let i = 0; i < out.n; i++) counts[Math.round(Math.min(1, out.a[i] * fade) * BUCKETS) + 1]++;
      for (let b = 1; b <= BUCKETS + 1; b++) counts[b] += counts[b - 1];
      for (let i = 0; i < out.n; i++) order[counts[Math.round(Math.min(1, out.a[i] * fade) * BUCKETS)]++] = i;
      // counts[b] is now the end of shade b's run.
      let from = 0;
      for (let b = 0; b <= BUCKETS; b++) {
        const to = counts[b];
        if (to > from && b > 0) {
          ctx.beginPath();
          for (let k = from; k < to; k++) {
            const i = order[k];
            const x = c + out.x[i] * R;
            const y = c + out.y[i] * R;
            const r = out.r[i] * dot;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.fillStyle = fills[b];
          ctx.fill();
        }
        from = to;
      }

      if (!shown || !onScreen || document.hidden) return;
      // Reduced motion holds one still frame once a look's alpha has eased in (and a wake's fade is done).
      if (reduced) {
        if (!settled || since < WAKE_FADE_MS) raf = requestAnimationFrame(draw);
        return;
      }
      const motion = (settled ? 0 : 1) + sc.hover + (pressing ? 1 : 0) + (bursting ? 1 : 0);
      const wait = frameDelay(st, motion);
      if (wait) nap = setTimeout(() => (raf = requestAnimationFrame(draw)), wait);
      else raf = requestAnimationFrame(draw);
    };
    const halt = () => {
      cancelAnimationFrame(raf);
      clearTimeout(nap);
      raf = 0;
      nap = undefined;
    };
    const start = () => {
      halt();
      if (shown) draw();
    };

    const fit = () => {
      const box = el.parentElement;
      const rect = box?.getBoundingClientRect();
      // Not rendered (display: none): no loop until it shows again (the observer calls fit once more).
      shown = !!box && !!rect && rect.width > 0 && rect.height > 0;
      if (!box || !rect || !shown) return halt();
      // Layout size, not the painted box: mid-flight (FlyingOrb) the parent is scaled by a transform.
      const next = Math.max(1, Math.round(Math.min(box.clientWidth, box.clientHeight) || Math.min(rect.width, rect.height)));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = next;
      el.width = next * dpr;
      el.height = next * dpr;
      el.style.width = `${next}px`;
      el.style.height = `${next}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sc.floor = dotFloor(next, dpr);
      const n = dotCount(next, dpr);
      if (n !== dots.n) {
        dots = sphere(n);
        out = placed(n);
        order = new Uint16Array(n);
      }
      start();
    };

    // The pointer: sphere units from the canvas center (the rim is 1), held within 1.2 so a lean stays inside.
    const aim = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const rad = r.width * ORB_R || 1;
      let x = (e.clientX - r.left - r.width / 2) / rad;
      let y = (e.clientY - r.top - r.height / 2) / rad;
      const d = Math.hypot(x, y);
      if (d > 1.2) {
        x *= 1.2 / d;
        y *= 1.2 / d;
      }
      px = x;
      py = y;
    };
    // A nap (asleep) or a stopped loop picks up at once when the pointer arrives.
    const wakeLoop = () => {
      if (!reduced && shown && (nap !== undefined || !raf)) start();
    };
    const onMove = (e: PointerEvent) => {
      aim(e);
      if (!pointer) {
        pointer = true;
        // First contact: start the tilt from where the pointer is, not from the center.
        if (sc.hover === 0) {
          sc.hx = px;
          sc.hy = py;
        }
      }
      wakeLoop();
    };
    const onLeave = () => {
      pointer = false;
    };
    const onDown = (e: PointerEvent) => {
      aim(e);
      pressAt = performance.now();
      pressX = px;
      pressY = py;
      wakeLoop();
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerenter", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave, { passive: true });
    el.addEventListener("pointercancel", onLeave, { passive: true });
    el.addEventListener("pointerdown", onDown, { passive: true });

    repaint.current = start;
    const ro = new ResizeObserver(fit);
    if (el.parentElement) ro.observe(el.parentElement);
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([e]) => {
            const was = onScreen;
            onScreen = e?.isIntersecting ?? true;
            if (onScreen && !was) start();
          });
    io?.observe(el);
    fit();
    const onMotion = () => {
      reduced = Boolean(mq?.matches);
      start();
    };
    const onVisible = () => !document.hidden && start();
    mq?.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      repaint.current = null;
      halt();
      ro.disconnect();
      io?.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerenter", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointercancel", onLeave);
      el.removeEventListener("pointerdown", onDown);
      mq?.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tone]);

  // The loop reads `live` each frame. A still frame (reduced motion) or a nap must repaint on a change.
  useEffect(() => {
    live.current = { status, getLevel, getBands, wokeAt };
    repaint.current?.();
  }, [status, getLevel, getBands, wokeAt]);

  return <canvas ref={canvas} aria-hidden="true" data-status={status} data-woke={wokeAt ?? undefined} data-slot="orb" className={cn("block", className)} />;
}
