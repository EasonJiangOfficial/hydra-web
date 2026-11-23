/* Web Audio plumbing: one AudioContext, an AnalyserNode per source, and a 0..1 level read each frame. */

let ctx: AudioContext | null = null;

/** iPhone and iPad (iPadOS reports itself as a Mac with touch): Safari there differs in how it shares the mic and the speaker. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  // iOS also leaves a context "interrupted" (a call, the lock screen, the Home Screen app in the background).
  if (ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => {});
  return ctx;
}

/*
 * The orb's spectrum (W5 section 5): BAND_COUNT log-spaced bands from BAND_LOW_HZ to BAND_HIGH_HZ, where a voice lives.
 * Calibration knobs: BAND_FLOOR is the share of the analyser's dB range (-100..-30) that reads as silence (room
 * noise sits near it), BAND_GAIN lifts ordinary speech toward 1. Tune on a real room, not here.
 */
export const BAND_COUNT = 24;
const BAND_LOW_HZ = 90;
const BAND_HIGH_HZ = 7500;
export const BAND_FLOOR = 0.38;
export const BAND_GAIN = 1.25;

/** For each band, its first and last FFT bin (at least one bin each). */
export function bandBins(binCount: number, sampleRate: number, bands = BAND_COUNT): [number, number][] {
  const hzPerBin = sampleRate / 2 / binCount;
  const ratio = BAND_HIGH_HZ / BAND_LOW_HZ;
  const out: [number, number][] = [];
  for (let b = 0; b < bands; b++) {
    const lo = Math.floor((BAND_LOW_HZ * ratio ** (b / bands)) / hzPerBin);
    const hi = Math.floor((BAND_LOW_HZ * ratio ** ((b + 1) / bands)) / hzPerBin);
    const first = Math.min(binCount - 1, lo);
    out.push([first, Math.min(binCount - 1, Math.max(first, hi - 1))]);
  }
  return out;
}

/** One band's 0..1 value from its loudest bin (0..255 bytes): silence and room noise under the floor read 0. */
export const bandValue = (byte: number) => Math.min(1, Math.max(0, (byte / 255 - BAND_FLOOR) / (1 - BAND_FLOOR)) * BAND_GAIN);

/** RMS of the analyser's time-domain data, scaled so ordinary speech lands around 0.3 to 0.8; and its spectrum. */
export class Meter {
  private buf: Float32Array<ArrayBuffer>;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private bins: [number, number][] = [];
  constructor(private analyser: AnalyserNode) {
    this.buf = new Float32Array(analyser.fftSize);
  }
  read(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 5);
  }
  /** BAND_COUNT values 0..1 into `out`, low to high. */
  bands(out: Float32Array): boolean {
    if (!this.freq) {
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.bins = bandBins(this.freq.length, this.analyser.context.sampleRate);
    }
    this.analyser.getByteFrequencyData(this.freq);
    for (let b = 0; b < this.bins.length; b++) {
      const [lo, hi] = this.bins[b];
      let peak = 0;
      for (let i = lo; i <= hi; i++) if (this.freq[i] > peak) peak = this.freq[i];
      out[b] = bandValue(peak);
    }
    return true;
  }
}

function analyser(c: AudioContext) {
  const a = c.createAnalyser();
  // 1024: about 47 Hz per bin at 48 kHz, so the low bands of a voice get bins of their own.
  a.fftSize = 1024;
  a.smoothingTimeConstant = 0.6;
  return a;
}

/** Opens the microphone for level metering only (speech recognition has its own audio path). Needs a user gesture the first time. */
export async function openMic(): Promise<{ meter: Meter; close: () => void } | null> {
  const c = audioContext();
  if (!c || !navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const node = c.createMediaStreamSource(stream);
    const a = analyser(c);
    node.connect(a); // not connected to the speakers: no feedback
    return {
      meter: new Meter(a),
      close() {
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch {
    return null;
  }
}

/** Meters an <audio> element and keeps it audible. An element can be wrapped once, so call this once per element. */
export function meterElement(el: HTMLAudioElement): Meter | null {
  const c = audioContext();
  if (!c) return null;
  try {
    const src = c.createMediaElementSource(el);
    const a = analyser(c);
    src.connect(a);
    a.connect(c.destination);
    return new Meter(a);
  } catch {
    return null;
  }
}

/** One soft 120 ms tone: the sleep word's answer ("one short sound, not a sentence"). */
export function blip() {
  const c = audioContext();
  if (!c) return;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.frequency.value = 520;
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, c.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.14);
  } catch {
    /* no audio: the orb going still is the answer */
  }
}
