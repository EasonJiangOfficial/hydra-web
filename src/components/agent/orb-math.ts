import type { AgentStatus } from "./types";

/*
 * The orb's math, pure and allocation-free per frame (orb.tsx owns the canvas and the clock). The bar is Phonon's dot
 * sphere (owner's pick; measured in side-session-notes orb-bar.md): a gridless, living dust shell of tiny dots (each
 * scattered off the lattice and wandering sideways on its own phase), the back filling the gaps between the front, a
 * steady turn, fast-attack slow-release motion. Hydra keeps that and fixes what Phonon gets wrong:
 * every band moves (log bands, lows at the bottom, highs at the top), the push is radial, neighbours move as one
 * membrane, time is in seconds (no per-frame constants), and each status has its own look, eased over 250 ms. Like
 * Phonon's hot cap, a voice erupts in one patch fixed on the sphere (it turns with it) while the rest stays calm.
 * Monochrome: the signal is size, position and alpha. No color, no glow, no gradient.
 */

/* ---- the dots ---- */

/** Unit-sphere points as typed arrays: `seed` is each dot's own phase, 0..1. */
export type Sphere = { n: number; x: Float32Array; y: Float32Array; z: Float32Array; seed: Float32Array };

/** A fixed hash, 0..1: the same dust every load (so frames, tests and reduced motion are repeatable). */
const hash = (i: number, k: number) => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
/**
 * How far each dot is scattered off its lattice point, as a share of the lattice spacing (uniform in a disc on the
 * surface). A bare Fibonacci lattice reads as spiral rows, a dotted golf ball; a nudge off it, the per-dot wander
 * (WOBBLE) and the back layer sliding under the front break the rows. Critic round 9: at 0.8 of a spacing the dust
 * turned into random clumps, pairs and holes (screen density CV 0.33-0.40, widest hole 0.13 R; Phonon 0.16-0.19 and
 * 0.066 R, its dots moved about 0.19 of a spacing). At 0.25 the sphere is as full and even as Phonon's (simulated at
 * 240 px: CV 0.20, widest hole 0.09 R).
 */
export const SCATTER = 0.25;

/** `n` points over the unit sphere: a Fibonacci lattice (even cover) scattered sideways into gridless dust. */
export function sphere(n: number): Sphere {
  const s: Sphere = { n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), seed: new Float32Array(n) };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spacing = Math.sqrt((4 * Math.PI) / Math.max(1, n));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // A tangent frame at the point (any axis not near it), then a step in a random direction, uniform in the disc.
    const ux = Math.abs(y) < 0.9 ? 0 : 1;
    const uy = 1 - ux;
    let t1x = uy * z;
    let t1y = -ux * z;
    let t1z = ux * y - uy * x;
    const l1 = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= l1;
    t1y /= l1;
    t1z /= l1;
    const t2x = y * t1z - z * t1y;
    const t2y = z * t1x - x * t1z;
    const t2z = x * t1y - y * t1x;
    const m = SCATTER * spacing * Math.sqrt(hash(i, 1));
    const th = 2 * Math.PI * hash(i, 2);
    const c = m * Math.cos(th);
    const d = m * Math.sin(th);
    const px = x + c * t1x + d * t2x;
    const py = y + c * t1y + d * t2y;
    const pz = z + c * t1z + d * t2z;
    const l = Math.hypot(px, py, pz);
    s.x[i] = px / l;
    s.y[i] = py / l;
    s.z[i] = pz / l;
    s.seed[i] = (i * 0.618034) % 1;
  }
  return s;
}

/**
 * Critic round 9: 560 dots left the shell thin and blotchy (Phonon draws about 800, the spec 700-1000). The same ink
 * now goes into 800 smaller dots (DOT_K), the back still at BACK_A and BACK_R (critic round 7: never a 34 % ghost).
 */
export const MIN_DOTS = 90;
export const MAX_DOTS = 800;
/** The sphere's radius as a share of the canvas side (the rest is room for the push and the wake). */
export const ORB_R = 0.38;
/**
 * The dot radius as a share of the sphere radius (times each dot's depth factor: 1.15 at the front, BACK_R at the
 * back). Phonon's shell is about 99 % empty space. Round 3 drew 0.0072 on 1000 dots, 2.5 to 4 times Phonon's ink;
 * rounds 4-8 drew 0.0049 on 560. Round 9 spreads that same ink over 800 dots: 0.0049 sqrt(553 / 800), the front dot
 * 0.94 % of R across.
 */
export const DOT_K = 0.0041;
/**
 * Depth shading: the back dot's size factor is 0.7 (the front's 1.15) at 85 % alpha, rising to full at the front.
 * Phonon draws the back at full strength; Hydra keeps it one step fainter and smaller for depth, but crisp, so the two
 * layers read as two clouds sliding past each other as the sphere turns. Round 6's 0.58x at 34 % drew the back at
 * about 1 device px and 10 to 34 % contrast: it vanished.
 */
export const BACK_R = 0.7;
export const BACK_A = 0.85;
/**
 * No dot is drawn under 1.1 device px across (radius 0.55). A small orb raises its smallest dots to this floor
 * (Scene.floor) and draws fewer of them (dotCount). Round 7 set 1.4 px, so the 96 px sidebar orb kept only about 130
 * dots: a third of its 0.2 R cells empty, a sparse cloud whose outline barely held (critic round 9). At 1.1 px it
 * keeps about 210 at the same ink (simulated: cells empty 5 %, no longer 32 %); a 1 px disc smears into gray (40 % of
 * dots under 40 % contrast, 1.1 px: about a quarter).
 */
export const DOT_MIN_PX = 0.55;

/** The base dot radius in CSS px for an orb `size` CSS px wide (times each dot's size factor). */
export const dotRadius = (size: number) => Math.max(0, size) * ORB_R * DOT_K;

/** The smallest size factor drawn for an orb `size` CSS px wide at `dpr` (the canvas caps at 2x): DOT_MIN_PX on screen. */
export function dotFloor(size: number, dpr: number): number {
  const d = Math.min(2, Math.max(1, dpr || 1));
  const r = dotRadius(size);
  return r > 0 ? DOT_MIN_PX / d / r : 0;
}

/** One quiet dot's mean ink (alpha times size factor squared, over the depth: uniform on a sphere) at a size `floor`. */
export function dotInk(floor = 0): number {
  const N = 32;
  let sum = 0;
  for (let k = 0; k < N; k++) {
    const depth = (k + 0.5) / N;
    sum += (BACK_A + (1 - BACK_A) * depth) * Math.max(floor, BACK_R + (1.15 - BACK_R) * depth) ** 2;
  }
  return sum / N;
}

/**
 * How many dots an orb `size` CSS px wide gets at `dpr`: MAX_DOTS while every dot can be drawn at its true size, then
 * fewer as the floor makes the small ones bigger than their share, so a small orb carries the same share of ink as a
 * big one (ink goes with count times dot ink): fewer dots, each crisp, never many faint ones. A 240 px orb on a Retina
 * Mac has about 790 (its back dots just under the floor), the 96 px sidebar orb about 210.
 */
export function dotCount(size: number, dpr: number): number {
  const share = size > 0 ? dotInk() / dotInk(dotFloor(size, dpr)) : 0;
  return Math.min(MAX_DOTS, Math.max(MIN_DOTS, Math.round(MAX_DOTS * share)));
}

/* ---- springs: fast attack, slower release ---- */

/** A band's rise to 90 % of a step, and its fall to 10 %: onsets snap, tails glide (Phonon: 35 ms and ~570 ms). */
export const ATTACK_S = 0.05;
export const RELEASE_S = 0.25;
/** A critically damped spring from rest reaches 90 % of a step when ωt = 3.8897 ((1 + ωt)e^(-ωt) = 0.1). */
const RISE90 = 3.8897;
export const ATTACK_W = RISE90 / ATTACK_S;
export const RELEASE_W = RISE90 / RELEASE_S;

/**
 * One exact step of a critically damped spring at x[i] (velocity v[i]) toward `target` over `dt` seconds: stable at
 * any frame time, no overshoot from rest. Rising uses the attack stiffness, falling the release one. Never below 0.
 */
export function springTo(x: Float32Array, v: Float32Array, i: number, target: number, dt: number, up = ATTACK_W, down = RELEASE_W) {
  const w = target >= x[i] ? up : down;
  const e0 = x[i] - target;
  const c = v[i] + w * e0;
  const k = Math.exp(-w * dt);
  const nx = target + (e0 + c * dt) * k;
  v[i] = (v[i] - w * c * dt) * k;
  x[i] = nx;
  if (x[i] < 0) {
    x[i] = 0;
    v[i] = 0;
  }
}

/**
 * Neighbouring bands moved as one membrane: two passes of a [1 2 1] blur, edges held. A lone loud band becomes a
 * smooth bump with shoulders, so the surface never steps from one band to the next. `tmp` is scratch (same length).
 */
export function smoothBands(src: ArrayLike<number>, out: Float32Array, tmp: Float32Array) {
  const n = out.length;
  if (!n) return;
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? src : out;
    for (let i = 0; i < n; i++) tmp[i] = 0.25 * (from[Math.max(0, i - 1)] ?? 0) + 0.5 * (from[i] ?? 0) + 0.25 * (from[Math.min(n - 1, i + 1)] ?? 0);
    // A copy, not tmp.subarray(): a view is a fresh object, and this runs twice a frame.
    for (let i = 0; i < n; i++) out[i] = tmp[i];
  }
}

/** The membrane at height `u` (0 the bottom, 1 the top): eased between samples, so a bump has a round shoulder. */
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

/* ---- status looks, blended ---- */

/** Blend weight order: asleep, listening, thinking (pending), speaking. */
export const LOOKS: AgentStatus[] = ["asleep", "listening", "thinking", "speaking"];
export const BLEND_S = 0.25;
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** The current mix of looks: `w` sums to 1; a change eases from wherever it is over BLEND_S, never a cut. */
export type Blend = { w: Float32Array; from: Float32Array; to: number; t0: number; p: number };

export function blend(status: AgentStatus, t = 0): Blend {
  const to = Math.max(0, LOOKS.indexOf(status));
  const w = new Float32Array(4);
  w[to] = 1;
  return { w, from: w.slice(), to, t0: t - BLEND_S, p: 1 };
}

/** Retarget at time `t` (seconds). A change mid-way starts from the mix on screen now. */
export function blendTo(b: Blend, status: AgentStatus, t: number) {
  const to = Math.max(0, LOOKS.indexOf(status));
  if (to === b.to) return;
  b.from.set(b.w);
  b.to = to;
  b.t0 = t;
  b.p = 0;
}

/** Advance to time `t`; returns how far the change is, 0..1 (1: settled). */
export function blendStep(b: Blend, t: number): number {
  b.p = Math.min(1, Math.max(0, (t - b.t0) / BLEND_S));
  const e = ease(b.p);
  for (let i = 0; i < 4; i++) b.w[i] = b.from[i] + ((i === b.to ? 1 : 0) - b.from[i]) * e;
  return b.p;
}

/** Turn speed (rad/s) for a mix: asleep barely turns, pending turns most, speaking holds steadier for the push. */
const YAW = [0.05, 0.22, 0.34, 0.18];
export const yawSpeed = (w: ArrayLike<number>) => w[0] * YAW[0] + w[1] * YAW[1] + w[2] * YAW[2] + w[3] * YAW[3];

/** Reduced motion: no motion at all, only an alpha per look (asleep faint, pending a little under awake). */
const STILL = [0.5, 0.88, 0.72, 1];
export const stillAlpha = (w: ArrayLike<number>) => w[0] * STILL[0] + w[1] * STILL[1] + w[2] * STILL[2] + w[3] * STILL[3];

/* ---- pending: in time with the Mac's pending sound ---- */

/** Hydra Desktop's pending sound (BRIDGE.md, build 4) loops every 2.4 s and fades in 0.6 s after a turn starts. */
export const PENDING_LOOP_S = 2.4;
export const PENDING_DELAY_S = 0.6;

/** The pending pulse, 0..1, `s` seconds after thinking began: nothing for 0.6 s, then a raised cosine per loop, faded in. */
export function pendingPulse(s: number): number {
  if (!(s > PENDING_DELAY_S)) return 0;
  const k = s - PENDING_DELAY_S;
  const env = Math.min(1, k / PENDING_DELAY_S);
  return env * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / PENDING_LOOP_S));
}

/** The pending band's angle: once round every two loops of the sound. */
export const pendingOrbit = (s: number) => (Math.PI * Math.max(0, s)) / PENDING_LOOP_S;

/* ---- the wake (lane A contract, unchanged) ---- */

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

/* ---- touch: a press ripple ---- */

/** A press sends one soft ripple across the face from the press point: 0.9 s, out at 2 radii a second. */
export const PRESS_MS = 900;
const PRESS_SPEED = 2;
const PRESS_WIDTH = 0.22;
/** The ripple's strength at screen distance `d` from the press, `ms` after it: 0..1, fading as it spreads. */
export function pressWave(d: number, ms: number): number {
  if (!(ms >= 0) || ms >= PRESS_MS) return 0;
  const front = (ms / 1000) * PRESS_SPEED;
  const fade = (1 - ms / PRESS_MS) ** 2;
  return fade * Math.exp(-(((d - front) / PRESS_WIDTH) ** 2));
}

/* ---- the hot spot: where a voice erupts ---- */

/**
 * Critic round 4: a band in screen space pushed a whole latitude out on both limbs at once, a mirrored barrel. Now a
 * voice erupts in one patch fixed on the sphere (Phonon's hot cap): the patch turns with the sphere, so the eruption
 * travels with the turn, and the rest of the dust keeps SPOT_FLOOR of the push. Each phrase (after a SPOT_PAUSE_S
 * pause), a patch turned past the limb, or SPOT_LIFE_S of steady voice moves the heat to a fresh patch on the face,
 * SPOT_SETTLE_S later, a little toward the loudest band's height (lows sit low, highs high). The old patch releases as the new one attacks (the
 * band springs), so nothing pops. Two slots: the one heating and the one cooling.
 */
export type Spots = {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Each slot's heat, 0..1, and its spring velocity. */
  g: Float32Array;
  v: Float32Array;
  /** The slot heating now; seconds since it was placed; seconds of silence; how many patches so far. */
  k: number;
  age: number;
  quiet: number;
  count: number;
  /** Seconds a move has waited (-1: none): a phrase opens on a hiss, so the patch is placed once the voice is up. */
  armed: number;
};
/**
 * The patch is HEAT_GAIN exp((cos θ - 1) SPOT_K), capped at 1: a flat-topped cap, full out to about 0.5 rad (29°) and
 * falling to 1/e by about 0.85 rad (49°), some 15 % of the shell (Phonon's voice cap is 17 %). Round 4's 33° gaussian
 * left too few dots in it.
 */
export const SPOT_K = 4;
export const HEAT_GAIN = 1.7;
export const HEAT_CUT = 0.06;
/**
 * Critic round 5: round 4 multiplied the patch by the membrane at each dot's height, a thin bump that moves every
 * syllable, so only ~1 % of the dust swelled (Phonon: 6.4 %). Now the whole patch erupts with the voice: PATCH_BODY of
 * a patch dot's drive is the loudest band, the rest its own band's height (which still shapes the cap per syllable).
 */
export const PATCH_BODY = 0.7;
/**
 * Size and ink follow the patch's drive on this concave curve, so a mid voice already swells its dots (the push stays
 * linear). Critic round 8: at 0.6 too few patch dots reached a crisp swell (talking 3.9 % of dots swollen at p90,
 * Phonon 6.9 %); at 0.55 a mid syllable takes most of the patch to 1.5x and up.
 */
export const GROW_EXP = 0.55;
export const SPOT_FLOOR = 0.12;
export const SPOT_PAUSE_S = 0.3;
export const SPOT_LIFE_S = 5;
/** Where a patch is seated: its view azimuth (radians off the front, on the incoming side) and its screen height at
 * most SEAT_Y of R from the equator, so the cap is seen face-on (critic round 10). */
export const SEAT_AZ = [0.3, 0.9] as const;
export const SEAT_Y = 0.35;
/** A patch whose view azimuth is past this (radians from the front) has turned away. */
export const SPOT_AWAY = 1.75;
const VOICED = 0.04;

export const spots = (): Spots => ({
  x: new Float32Array(2),
  y: new Float32Array(2),
  z: new Float32Array([1, 1]),
  g: new Float32Array(2),
  v: new Float32Array(2),
  k: 0,
  age: Infinity,
  quiet: Infinity,
  count: 0,
  armed: -1,
});
/** How long a move waits for the voice to come up (two attack times) before it reads the loudest band. */
export const SPOT_SETTLE_S = 0.1;

/** The view azimuth of slot `j` at `turn` (0 facing the viewer, ±π/2 the limbs, + to the right): turn, then tilt. */
export function spotAzimuth(sp: Spots, j: number, turn: number): number {
  const cy = Math.cos(turn);
  const sy = Math.sin(turn);
  const z1 = -sp.x[j] * sy + sp.z[j] * cy;
  return Math.atan2(sp.x[j] * cy + sp.z[j] * sy, sp.y[j] * Math.sin(TILT) + z1 * Math.cos(TILT));
}

/** Put slot `j` where the view direction (azimuth `az`, screen height `yv`, y down) is at `turn`: undo tilt, then turn. */
function seat(sp: Spots, j: number, az: number, yv: number, turn: number) {
  const vy = Math.min(0.9, Math.max(-0.9, yv));
  const ce = Math.sqrt(1 - vy * vy);
  const vx = Math.sin(az) * ce;
  const vz = Math.cos(az) * ce;
  const cx = Math.cos(TILT);
  const sx = Math.sin(TILT);
  const z1 = -vy * sx + vz * cx;
  const cy = Math.cos(turn);
  const sy = Math.sin(turn);
  sp.x[j] = vx * cy - z1 * sy;
  sp.y[j] = vy * cx + vz * sx;
  sp.z[j] = vx * sy + z1 * cy;
}

/**
 * One frame of the hot spot: `level` is the raw voice level (unsprung, so a pause reads as one), `m` the membrane.
 * Moves the heat to a new patch when a voice starts a phrase, the patch has turned away, or it has lived its life.
 */
export function spotStep(sp: Spots, m: ArrayLike<number> | null, level: number, turn: number, dt: number) {
  sp.age += dt;
  const voiced = level > VOICED;
  if (sp.armed < 0 && voiced && (sp.quiet > SPOT_PAUSE_S || sp.age > SPOT_LIFE_S || Math.abs(spotAzimuth(sp, sp.k, turn)) > SPOT_AWAY)) sp.armed = 0;
  else if (sp.armed >= 0) sp.armed += dt;
  if (sp.armed >= SPOT_SETTLE_S) {
    // The loudest band's height (0 the bottom, 1 the top): the patch's heart sits on it, so it erupts at full.
    const n = m ? m.length : 0;
    let at = -1;
    for (let b = 0; b < n; b++) if (m![b] > (at < 0 ? 0 : m![at])) at = b;
    const u = at < 0 ? 0.5 : at / Math.max(1, n - 1);
    const c = sp.count++;
    sp.k = 1 - sp.k;
    // Critic round 10: seated at the limb (1.0-1.45 rad) and at the band's full height, the cap sat edge-on on the
    // bottom rim. Now it sits on the face near the equator, on the side the turn brings in (the turn only grows, so
    // azimuth grows with it), and sweeps across the face like Phonon's hot cap.
    seat(sp, sp.k, -(SEAT_AZ[0] + (SEAT_AZ[1] - SEAT_AZ[0]) * hash(c, 4)), SEAT_Y * (1 - 2 * u), turn);
    sp.age = 0;
    sp.armed = -1;
  }
  sp.quiet = voiced ? 0 : sp.quiet + dt;
  for (let j = 0; j < 2; j++) springTo(sp.g, sp.v, j, j === sp.k && sp.count > 0 ? 1 : 0, dt);
}

/* ---- a frame ---- */

/**
 * Everything one frame depends on. The component fills it each frame (no allocation): `t` and `turn` in seconds and
 * radians (turn integrates yawSpeed, so a status change never jumps the angle), `w` the look mix, `level` and `m` (the
 * membrane, low to high) already smoothed, the pointer in sphere units, and the press and wake clocks.
 */
export type Scene = {
  t: number;
  turn: number;
  w: Float32Array;
  level: number;
  /** The smoothed membrane, 0..1 per band, low to high; null: none (pending, asleep). */
  m: Float32Array | null;
  /** Pending: pulse 0..1 and the band's angle. */
  pulse: number;
  orbit: number;
  /** Pointer in sphere units (center 0, rim 1; y down) and how present it is (0..1, eased). */
  hx: number;
  hy: number;
  hover: number;
  /** Ms since the last press (-1: none) and where it was. */
  press: number;
  qx: number;
  qy: number;
  wake: Wake | null;
  /** Where a voice erupts (spotStep); null: everywhere alike (the bare membrane). */
  sp: Spots | null;
  /** Reduced motion: a still sphere, alpha by look only. */
  still: boolean;
  /** The smallest size factor drawn (dotFloor): a small orb raises its back dots to stay crisp. */
  floor: number;
};

export function scene(status: AgentStatus = "listening", t = 0): Scene {
  return { t, turn: 0, w: blend(status).w, level: 0, m: null, pulse: 0, orbit: 0, hx: 0, hy: 0, hover: 0, press: -1, qx: 0, qy: 0, wake: null, sp: null, still: false, floor: 0 };
}

export type Placed = { n: number; x: Float32Array; y: Float32Array; r: Float32Array; a: Float32Array };
export const placed = (n: number): Placed => ({ n, x: new Float32Array(n), y: new Float32Array(n), r: new Float32Array(n), a: new Float32Array(n) });

const TILT = 0.38;
/** The pointer tilts the sphere toward itself: up to these angles at the rim. */
const HOVER_YAW = 0.42;
const HOVER_PITCH = 0.32;
/** Breathing at rest: 1.2 % of the radius over 7 s, plus each dot's own slow 1 % drift (Phonon's shimmer, calmer). */
const BREATH = 0.012;
const DRIFT = 0.01;
/**
 * Each dot also wanders sideways on its own phase (Phonon: 0.2 units, 2.4 % of the radius, phase 0.1 rad per index):
 * the dust lives, and no two neighbours move together, so no row ever lines up. On the surface (the radius holds).
 * Asleep it wanders a third as far.
 */
export const WOBBLE = 0.024;
const WOBBLE_SPEED = 0.9;
/** Asleep the shell is 12 % smaller. */
const SLEEP_SHRINK = 0.12;
/** The furthest any look reaches past the shell (sphere radii): the wake swell fills up to it, never past. */
export const SPIKE = 0.28;
/**
 * Speaking: a full voice pushes the hot patch's dots out up to TALK_PUSH and grows them up to 2x (a mid voice about
 * 1.5x), as Phonon's. Each dot reaches its own way (RAG, slowly changing), in push and in size, so the eruption's
 * edge is ragged dust, not a smooth dome. Critic round 6: round 5 grew them 2.8 to 3.6x, fat dark discs over a third
 * of the disk; the bulge carries the strength, the dots stay dust.
 */
const TALK_PUSH = 0.16;
/** Critic round 8: 0.75 swelled too few dots (half Phonon's share at the peaks); the 2x cap still holds every dot. */
export const TALK_GROW = 0.9;
const RAG = 0.45;
/**
 * Listening: the hot patch draws in with his voice (a dent, LIS_DENT at full) and swells its dots, and rings of
 * larger dots run in to its heart. The whole shell draws in only a little (INWARD; round 3's 0.1 pumped the rim ±5 %).
 */
export const INWARD = 0.03;
const LIS_DENT = 0.08;
/**
 * Critic round 8: at 0.45 the owner's own voice swelled a quarter of Phonon's share of dots (the weakest voice look).
 * The dent draws the patch in, so its dots crowd and need a little more swell than talking's to read as strongly.
 */
export const LIS_GROW = 1.05;
const RIPPLE = 0.2;
const RIPPLE_K = 8;
const RIPPLE_W = 6;
const RIPPLE_GROW = 0.65;
/** Pending: a band (a tilted great circle) orbits the sphere, lifting its dots; the shell pulses with the sound. */
const PEND_LIFT = 0.07;
const PEND_WIDTH = 0.24;
/**
 * Pending swells its band's dots up to 1 + PEND_GROW at the pulse's peak. Critic round 8: at 1.1 (2x at the front) the
 * silence-filling band was the busiest orb, with more swollen dots than either voice; at 0.65 it is a calm band of
 * slightly larger dots, under the voice looks (measured at 240 px: 1.8 % of dots swollen at p90, talking 6.5 %).
 */
export const PEND_GROW = 0.65;
/** Pending: the dots off the band rest a little fainter, so the band carries the look. */
const PEND_DIM = 0.15;
const PEND_TILT = 0.62;
const PULSE_SWELL = 0.03;
/** Hover: dots near the pointer lean up to 22 % of the way to it and grow a little. */
const LEAN = 0.22;
const LEAN_R2 = 0.16;
const PRESS_PUSH = 0.08;
/** No look, pointer or press grows a dot past twice its size (Phonon's peak): the shell stays about 99 % empty space. */
export const GROW_MAX = 1;
/** Nothing is drawn past this radius (the canvas leaves 1.32). */
export const MAX_R = 1.28;

/**
 * Where each dot sits this frame, in sphere units (x right, y down, about -1.28..1.28), with its size factor `r` and
 * alpha `a` (0..1; depth shading: the back is fainter and smaller, so the two layers read as a 3D shell).
 */
export function place(s: Sphere, sc: Scene, out: Placed): Placed {
  const { w, t, m, sp } = sc;
  const sleep = w[0];
  const lis = sc.still ? 0 : w[1];
  const thk = sc.still ? 0 : w[2];
  const spk = sc.still ? 0 : w[3];
  const awake = 1 - sleep;
  const hov = sc.still ? 0 : sc.hover;
  const yaw = sc.turn + hov * sc.hx * HOVER_YAW;
  const pitch = TILT - hov * sc.hy * HOVER_PITCH;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const lvl = sc.level;
  const base = sc.still ? 1 : 1 - SLEEP_SHRINK * sleep + PULSE_SWELL * thk * sc.pulse - INWARD * lis * lvl;
  const breath = sc.still ? 0 : BREATH * Math.sin((t * 2 * Math.PI) / 7) * (1 - 0.6 * lvl);
  // The pending band's normal, in view space: tilted off vertical, precessing with the orbit.
  const st = Math.sin(PEND_TILT);
  const nx = st * Math.cos(sc.orbit);
  const ny = -Math.cos(PEND_TILT);
  const nz = st * Math.sin(sc.orbit);
  const wake = sc.wake;
  const burst = wake ? wakeBurst(wake.ms) : 0;
  const ring = wake ? wakeRing(wake.ms) : null;
  const shine = !!wake && wake.awake && wake.ms >= WAKE_MS;
  const pressing = !sc.still && sc.press >= 0 && sc.press < PRESS_MS;
  const alphaScale = sc.still ? stillAlpha(w) : 1 - 0.5 * sleep;
  // Reduced motion holds the one wander of its still moment, the same in every look (the look shows only in alpha).
  const wob = sc.still ? WOBBLE : WOBBLE * (1 - (2 / 3) * sleep);
  let peak = 0;
  if (m) for (let b = 0; b < m.length; b++) if (m[b] > peak) peak = m[b];
  const tw = t * WOBBLE_SPEED;
  for (let i = 0; i < s.n; i++) {
    const seed = s.seed[i];
    const ph = i * 0.1;
    let ux = s.x[i] + wob * Math.sin(tw + ph);
    let uy = s.y[i] + wob * Math.sin(1.27 * tw + 1.3 * ph + 2.1);
    let uz = s.z[i] + wob * Math.sin(0.83 * tw + 0.7 * ph + 4.2);
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // Turn about the vertical axis, then tilt toward the viewer.
    const x1 = ux * cy + uz * sy;
    const z1 = -ux * sy + uz * cy;
    const y2 = uy * cx - z1 * sx;
    const z2 = uy * sx + z1 * cx;
    // Height on screen: 0 at the bottom (y down is +1), 1 at the top. Lows sit low, highs high, on every side.
    const mu = m ? bandAt(m, (1 - y2) / 2) : 0;
    const rho = Math.sqrt(x1 * x1 + y2 * y2);
    let d = breath;
    let grow = 0;
    let lift = 0;
    let touch = 0;
    let dim = 0;
    if (!sc.still) {
      d += DRIFT * awake * Math.sin(t * 0.9 + seed * 6.2832);
      // The hot patch, in the sphere's own frame (it turns with it): 1 at its heart, SPOT_FLOOR on the calm dust.
      let e = mu;
      let ge = mu;
      let heart = rho;
      if (sp && peak > 0 && spk + lis > 0) {
        let heat = 0;
        for (let j = 0; j < 2; j++) if (sp.g[j] > 0.001) heat += sp.g[j] * Math.exp((ux * sp.x[j] + uy * sp.y[j] + uz * sp.z[j] - 1) * SPOT_K);
        heat = Math.min(1, Math.max(0, HEAT_GAIN * heat - HEAT_CUT));
        // Critic round 5: the patch times the band's thin height bump left ~1 % of the dust moving. Now the whole patch
        // erupts with the voice (PATCH_BODY of the loudest band), the membrane at each dot's height only shapes it.
        const calm = mu * SPOT_FLOOR * (1 - heat);
        const body = heat * (PATCH_BODY * peak + (1 - PATCH_BODY) * mu);
        e = calm + body;
        // Size and ink rise faster than the push (a concave curve), so a mid voice already swells the patch's dots.
        ge = calm + body ** GROW_EXP;
        // Distance (chord) to the heating patch's heart, for the listening rings.
        const k = sp.k;
        heart = Math.sqrt(Math.max(0, 2 - 2 * (ux * sp.x[k] + uy * sp.y[k] + uz * sp.z[k])));
      }
      if (spk > 0 && ge > 0) {
        const rag = 1 - RAG + 2 * RAG * (0.5 + 0.5 * Math.sin(seed * 91.7 + 2.3 * t));
        d += spk * TALK_PUSH * rag * e ** 1.3;
        grow += spk * TALK_GROW * ge * (0.75 + 0.5 * rag);
        lift = Math.max(lift, spk * 0.95 * ge);
      }
      if (lis > 0 && ge > 0) {
        // A ring running in to the patch's heart: its crest is where sin peaks; dots on it rise a little and grow.
        const wave = Math.sin(RIPPLE_K * heart + RIPPLE_W * t + seed * 0.5);
        const crest = Math.max(0, wave) ** 2;
        d += lis * (RIPPLE * wave - LIS_DENT) * e;
        grow += lis * (RIPPLE_GROW * crest + LIS_GROW) * ge;
        lift = Math.max(lift, lis * 0.95 * ge * (0.6 + 0.4 * crest));
      }
      if (thk > 0) {
        const q = (x1 * nx + y2 * ny + z2 * nz) / PEND_WIDTH;
        const band = Math.exp(-q * q) * (0.7 + 0.3 * sc.pulse);
        d += thk * PEND_LIFT * band;
        grow += thk * PEND_GROW * band;
        lift = Math.max(lift, thk * 0.85 * band);
        dim = thk * PEND_DIM * (1 - band);
      }
      if (pressing) {
        const pw = pressWave(Math.hypot(x1 - sc.qx, y2 - sc.qy), sc.press);
        d += PRESS_PUSH * pw;
        grow += 0.6 * pw;
        touch = 0.5 * pw;
      }
    }
    const raw = base * (1 + d);
    // The wake swell fills the room up to a full spike's reach, never past it (a voice at the wake stays inside).
    let rad = raw + ((WAKE_SWELL * burst) / SPIKE) * Math.max(0, 1 + SPIKE - raw);
    if (rad > MAX_R) rad = MAX_R;
    let px = x1 * rad;
    let py = y2 * rad;
    if (hov > 0) {
      // Dots near the pointer lean toward it (front dots more): a convex step, so they never leave the box.
      const dx = sc.hx - px;
      const dy = sc.hy - py;
      const k = hov * LEAN * Math.exp(-(dx * dx + dy * dy) / LEAN_R2) * (0.4 + 0.6 * Math.max(0, z2));
      px += dx * k;
      py += dy * k;
      grow += k * 3;
      touch = Math.max(touch, k * 3);
    }
    const depth = (z2 + 1) / 2; // 0 back, 1 front
    out.x[i] = px;
    out.y[i] = py;
    out.r[i] = Math.max(sc.floor, BACK_R + (1.15 - BACK_R) * depth) * (1 + Math.min(GROW_MAX, grow)) * (1 + RING_GROW * ringNear(Math.hypot(x1, y2), ring));
    const a = alphaScale * (BACK_A + (1 - BACK_A) * depth) * (1 - dim);
    // The burst takes every dot to full alpha; the shimmer, a voice, the pending band and the pointer lift the faint
    // ones (the pointer even asleep: touching it stirs it).
    out.a[i] = a + (1 - a) * Math.min(1, Math.max(burst, lift * awake, touch, shine && wake ? shimmerAt(x1, t, wake.ms) : 0));
  }
  return out;
}

/** Asleep, the orb barely turns (0.05 rad/s): 10 frames a second look the same as 60 and cost a sixth. */
export const ASLEEP_MS = 100;

/**
 * Wait before the next frame: 0 is the next animation frame. Asleep naps ASLEEP_MS, but only once nothing moves faster
 * than the sleep look (`motion` < 0.01: the 250 ms fade into sleep, the pointer, a press); stepped at 10 fps those
 * would stutter.
 */
export function frameDelay(status: AgentStatus, motion: number): number {
  return status === "asleep" && Math.abs(motion) < 0.01 ? ASLEEP_MS : 0;
}

/**
 * Bands from a bare level (no analyser: the browser voice on iOS, an older desktop): a voice-shaped hump, low-middle
 * heavy, drifting slowly so it is not one rigid swell.
 */
export function levelBands(out: Float32Array, level: number, t: number) {
  const n = out.length;
  for (let b = 0; b < n; b++) {
    const x = b / Math.max(1, n - 1);
    const shape = Math.exp(-((x - 0.3) ** 2) / 0.06) + 0.5 * Math.exp(-((x - 0.65) ** 2) / 0.03);
    out[b] = Math.min(1, level * shape * (0.75 + 0.25 * Math.sin(t * 2.3 + b * 0.9)));
  }
}
