"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { driveLevel, frameDelay, place, spherePoints, WAKE_FADE_MS, WAKE_MS, wakeFade, type Placed, type Wake } from "./orb-math";
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
/** A band jumps up at once and falls back slowly, so a syllable reads as a spike, not a flicker. */
const ATTACK = 0.55;
const RELEASE = 0.12;
/** Reduced motion: no turn, ripple or spikes; the whole orb swells gently with the voice (a few percent). */
const PULSE = 0.06;

/**
 * The Hydra Agent orb: an open sphere of dots in ink and grays (alpha), no glow, no gradient, no color.
 * Fills its parent square. Each spectrum band pushes out the dots at its angle (low notes at the bottom, high at the
 * top), so a voice shows its own spikes; breathes at rest. A desktop wake (clap or phrase) plays a burst, then a slow
 * shimmer while awake (orb-math). Reduced motion: a still sphere with a gentle pulse; a wake only fades it in.
 * One canvas, about 200 dots, one requestAnimationFrame loop that reads the level and bands itself (never a React
 * render per frame): 60 fps awake, 10 asleep once a ripple settles, none while it is not on the page (display: none,
 * as the phone orb is on a desktop window), off screen or in a hidden tab. Dots of one shade fill as one path: 9 fills
 * a frame, not 220. Measured in WebKit (the Hydra Desktop window): the shell drew about 26,000 fills a second before,
 * about 420 after.
 */
export function Orb({ status, getLevel, getBands, tone = "ink", wokeAt = null, className }: OrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ status, getLevel, getBands, wokeAt });
  const repaint = useRef<() => void>(null);
  const dots = useMemo(() => spherePoints(220), []);

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
    let raf = 0;
    let nap: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    let lv = 0;
    const raw = new Float32Array(BANDS);
    const bands = new Float32Array(BANDS);
    const placed: Placed[] = [];
    const shade: number[] = [];
    // One wake object for the loop's life, set each frame: no allocation per frame while awake.
    const wake: Wake = { ms: 0, awake: false };
    const t0 = performance.now();

    const draw = () => {
      raf = 0;
      const { status: st, getLevel: read, getBands: readBands, wokeAt: woke } = live.current;
      const now = (performance.now() - t0) / 1000;
      // The wake's stamp is the desktop's clock (Date.now() on the same Mac).
      const since = woke ? Math.max(0, Date.now() - woke) : Infinity;
      const bursting = since < WAKE_MS;
      const target = driveLevel(st, read?.() ?? 0, now);
      // Bands only while there is a voice to show (speaking or listening), eased per band.
      const got = !reduced && (st === "speaking" || st === "listening") && !!readBands?.(raw);
      let any = false;
      for (let i = 0; i < BANDS; i++) {
        const want = got ? raw[i] : 0;
        bands[i] += (want - bands[i]) * (want > bands[i] ? ATTACK : RELEASE);
        if (bands[i] > 0.003) any = true;
      }
      let scale = 1;
      if (reduced) {
        lv += (target - lv) * 0.08;
        scale = 1 + PULSE * Math.min(1, Math.max(0, lv));
        place(dots, 1.5, 0, st, placed);
        // A wake under reduced motion: no motion, a fade from the asleep alpha to full.
        if (since < WAKE_FADE_MS && st !== "asleep") for (const p of placed) p.a *= 0.5 + 0.5 * wakeFade(since);
      } else {
        lv += (target - lv) * 0.25;
        wake.ms = since;
        wake.awake = st !== "asleep";
        place(dots, now, Math.min(1, Math.max(0, lv)), st, placed, any ? bands : null, woke ? wake : null);
      }
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const R = size * 0.38 * scale;
      const dot = Math.max(0.8, size / 72);
      for (let i = 0; i < placed.length; i++) shade[i] = Math.round(placed[i].a * BUCKETS);
      // Faint shades first, so the front of the sphere paints over the back.
      for (let b = 0; b <= BUCKETS; b++) {
        ctx.beginPath();
        let hit = false;
        for (let i = 0; i < placed.length; i++) {
          if (shade[i] !== b) continue;
          const p = placed[i];
          const x = c + p.x * R;
          const y = c + p.y * R;
          const r = p.r * dot;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
          hit = true;
        }
        if (!hit) continue;
        ctx.fillStyle = fills[b];
        ctx.fill();
      }
      // Reduced motion asleep holds one still frame; otherwise the loop runs while it can be seen.
      if ((reduced && st === "asleep" && !bursting) || !shown || !onScreen || document.hidden) return;
      const wait = bursting ? 0 : frameDelay(st, lv);
      if (wait) nap = setTimeout(() => (raf = requestAnimationFrame(draw)), wait);
      else raf = requestAnimationFrame(draw);
    };
    const halt = () => {
      cancelAnimationFrame(raf);
      clearTimeout(nap);
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = next;
      el.width = next * dpr;
      el.height = next * dpr;
      el.style.width = `${next}px`;
      el.style.height = `${next}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      start();
    };
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
      mq?.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dots, tone]);

  // The loop reads `live` each frame. A still frame (reduced motion asleep) or a nap must repaint on a change.
  useEffect(() => {
    live.current = { status, getLevel, getBands, wokeAt };
    repaint.current?.();
  }, [status, getLevel, getBands, wokeAt]);

  return <canvas ref={canvas} aria-hidden="true" data-status={status} data-woke={wokeAt ?? undefined} data-slot="orb" className={cn("block", className)} />;
}
