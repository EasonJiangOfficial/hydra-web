import type { AgentStatus } from "./types";

export type Dot = { x: number; y: number; z: number; seed: number };

/** `n` points spread evenly over the unit sphere (Fibonacci lattice): an open shell, nothing inside. */
export function spherePoints(n: number): Dot[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r, seed: (i * 0.618034) % 1 };
  });
}

export type Placed = { x: number; y: number; r: number; a: number };

/** Breathing at rest: 1.2 % of the radius over a 7 s cycle. */
const BREATH = 0.012;
const TILT = 0.38;

/** Idle motion by status, so Thinking has life of its own while no audio level drives it. */
export function driveLevel(status: AgentStatus, level: number, t: number): number {
  if (status === "thinking") return 0.2 + 0.08 * Math.sin(t * 3.1);
  if (status === "asleep") return 0;
  return level;
}

/** Asleep, the orb barely turns (0.04 rad/s): 10 frames a second look the same as 60 and cost a sixth. */
export const ASLEEP_MS = 100;

/**
 * Wait before the next frame: 0 is the next animation frame. Asleep naps ASLEEP_MS, but only once a ripple from
 * before sleep has settled (lv < 0.01); stepped at 10 fps it would stutter for about a second instead of 0.3 s.
 */
export function frameDelay(status: AgentStatus, lv: number): number {
  return status === "asleep" && Math.abs(lv) < 0.01 ? ASLEEP_MS : 0;
}

/** How far a band at full scale pushes its dots out (sphere radii). */
export const SPIKE = 0.28;

/**
 * A band's value at screen angle `u` (0 at the bottom, 1 at the top; both sides mirror): low notes at the bottom,
 * high at the top, eased between neighbours so a spike has a shoulder, not a step.
 */
export function bandAt(bands: ArrayLike<number>, u: number): number {
  const n = bands.length;
  if (!n) return 0;
  const x = Math.min(1, Math.max(0, u)) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = bands[i] ?? 0;
  const b = bands[Math.min(n - 1, i + 1)] ?? 0;
  return a + (b - a) * (f * f * (3 - 2 * f));
}

/**
 * The wake look (owner: "when I clap or say hey hydra ... the orb should change texture"; texture, no color). A 900 ms
 * burst: the shell swells up to +10 % and every dot goes to full alpha, then eases back; a ring runs from the center
 * out through the shell in the first 600 ms and grows the dots it passes by up to 40 %. After it, while awake, a slow
 * shimmer: a band of light crosses the sphere every 3 s, so awake reads apart from asleep even in silence.
 */
export const WAKE_MS = 900;
export const RING_MS = 600;
export const WAKE_SWELL = 0.1;
export const RING_GROW = 0.4;
const RING_WIDTH = 0.2;
/** The burst's rise, as a share of WAKE_MS. */
const RISE = 0.15;
export const SHIMMER_S = 3;
/** How much of the way to full alpha the shimmer's band lifts a dot. */
export const SHIMMER = 0.75;
/** Reduced motion: no motion, only this fade from the asleep alpha to full. */
export const WAKE_FADE_MS = 300;

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The burst, 0..1, `ms` after the wake: a quick ease-out rise, then an ease-out fall to 0 at WAKE_MS. */
export function wakeBurst(ms: number): number {
  if (!(ms > 0) || ms >= WAKE_MS) return 0;
  const p = ms / WAKE_MS;
  return p < RISE ? easeOut(p / RISE) : 1 - easeOut((p - RISE) / (1 - RISE));
}

/**
 * The ring's radius on screen (sphere radii: 0 at the center, 1 at the rim), or null outside its 600 ms. It ends a
 * ring-width past the rim, so the last dots it grew are back to size when it stops (no pop at RING_MS).
 */
export function wakeRing(ms: number): number | null {
  return ms >= 0 && ms < RING_MS ? (1 + RING_WIDTH) * (1 - (1 - ms / RING_MS) ** 2) : null;
}

/** How close a dot at screen distance `d` is to the ring: 1 on it, 0 a ring-width away or more. */
export const ringNear = (d: number, ring: number | null) => (ring === null ? 0 : clamp01(1 - Math.abs(d - ring) / RING_WIDTH));

/**
 * The shimmer's lift at screen x (-1..1) at time `t` (seconds): a soft band that crosses the sphere left to right once
 * every SHIMMER_S. 0..SHIMMER; it fades in over 600 ms after the burst.
 */
export function shimmerAt(x: number, t: number, ms: number): number {
  const ramp = clamp01((ms - WAKE_MS) / 600);
  if (!ramp) return 0;
  // The band enters and leaves far enough off the sphere that its tail is ~0 on it when it wraps (no step at the edge).
  const sweep = ((t / SHIMMER_S) % 1) * 2 * SWEEP - SWEEP;
  return SHIMMER * ramp * Math.exp(-(((x - sweep) / SHIMMER_WIDTH) ** 2));
}
const SHIMMER_WIDTH = 0.4;
const SWEEP = 1 + 3 * SHIMMER_WIDTH;

/** Reduced motion: 0 at the wake to 1 after WAKE_FADE_MS, the share of the way from the asleep alpha to full. */
export const wakeFade = (ms: number) => clamp01(ms / WAKE_FADE_MS);

/** A wake to draw: ms since it, and whether the orb is awake now (the shimmer only shows awake). */
export type Wake = { ms: number; awake: boolean };

/**
 * Where each dot sits at time `t` (seconds) for an audio `level` of 0..1. Ripples travel up the sphere with the
 * level; at level 0 only the slow breath and the turn remain. With a spectrum (`bands`, 0..1 each, low to high), each
 * dot is pushed out by the band at its angle on screen, so a voice shows its own spikes; the ripple then shrinks to a
 * texture under them. Output is in -1.3..1.3 sphere units.
 */
export function place(
  dots: Dot[],
  t: number,
  level: number,
  status: AgentStatus,
  out: Placed[] = [],
  bands?: ArrayLike<number> | null,
  wake?: Wake | null,
): Placed[] {
  const turn = t * (status === "thinking" ? 0.9 : status === "asleep" ? 0.04 : 0.16);
  const breath = BREATH * Math.sin((t * 2 * Math.PI) / 7) * (1 - level);
  const cy = Math.cos(turn);
  const sy = Math.sin(turn);
  const cx = Math.cos(TILT);
  const sx = Math.sin(TILT);
  const base = status === "asleep" ? 0.5 : 1;
  const ripple = bands ? 0.1 : 1;
  const burst = wake ? wakeBurst(wake.ms) : 0;
  const ring = wake ? wakeRing(wake.ms) : null;
  const shine = !!wake?.awake && wake.ms >= WAKE_MS;
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    const wave = (Math.sin(d.y * 5.2 - t * 7 + d.seed * 2.4) * level * 0.2 + Math.sin(d.seed * 40 + t * 15) * level * 0.05) * ripple;
    // turn about the vertical axis, then tilt toward the viewer
    const x1 = d.x * cy + d.z * sy;
    const z1 = -d.x * sy + d.z * cy;
    const y2 = d.y * cx - z1 * sx;
    const z2 = d.y * sx + z1 * cx;
    // Screen y grows downward: 0 at the bottom, 1 at the top, the same on both sides.
    // A contrast curve: middling bands stay low, so the loud ones read as spikes, not one swell.
    const spike = bands ? SPIKE * Math.min(1, 1.15 * bandAt(bands, Math.atan2(Math.abs(x1), y2) / Math.PI)) ** 1.6 : 0;
    // The swell fills the room up to a full spike's reach, never past it: a voice at the wake keeps its reach, inside
    // the canvas (a plain multiply took a full spike 10 % past the edge, cut flat).
    const raw = 1 + breath + wave + spike;
    const rad = raw + ((WAKE_SWELL * burst) / SPIKE) * Math.max(0, 1 + SPIKE - raw);
    const depth = (z2 + 1) / 2; // 0 back, 1 front
    const o = (out[i] ??= { x: 0, y: 0, r: 0, a: 0 });
    o.x = x1 * rad;
    o.y = y2 * rad;
    o.r = (0.7 + 0.45 * depth) * (1 + RING_GROW * ringNear(Math.hypot(x1, y2), ring));
    const a = base * (0.22 + 0.78 * depth);
    // The burst takes every dot to full alpha; the shimmer's band lifts the faint ones it crosses.
    o.a = a + (1 - a) * Math.max(burst, shine && wake ? shimmerAt(x1, t, wake.ms) : 0);
  }
  return out;
}
