/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R128) measurement and a look-ahead peak limiter.
 * Pure DSP on planar Float32 audio, streamed chunk by chunk.
 */

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }
  process(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** K-weighting (pre-filter shelf + RLB high-pass) for an arbitrary sample rate. */
function kWeighting(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = new Biquad(
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  );
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = new Biquad(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  return [shelf, hp];
}

export class LoudnessMeter {
  private filters: [Biquad, Biquad][];
  private subBlockSize: number;
  private acc: number[];
  private accCount = 0;
  private subBlocks: number[] = []; // per 100 ms: sum over channels of mean square
  peak = 0;

  private channels: number;

  constructor(sampleRate: number, channels: number) {
    this.channels = channels;
    this.filters = Array.from({ length: channels }, () => kWeighting(sampleRate));
    this.subBlockSize = Math.round(sampleRate / 10);
    this.acc = new Array(channels).fill(0);
  }

  push(planes: Float32Array[]) {
    const n = planes[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const x = planes[c][i];
        const ax = Math.abs(x);
        if (ax > this.peak) this.peak = ax;
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(x));
        this.acc[c] += y * y;
      }
      if (++this.accCount === this.subBlockSize) {
        let e = 0;
        for (let c = 0; c < this.channels; c++) {
          e += this.acc[c] / this.subBlockSize;
          this.acc[c] = 0;
        }
        this.subBlocks.push(e);
        this.accCount = 0;
      }
    }
  }

  /** Integrated loudness in LUFS (gated). Returns -Infinity for silence. */
  integrated(): number {
    const blocks: number[] = [];
    for (let i = 3; i < this.subBlocks.length; i++) {
      const s = this.subBlocks;
      blocks.push((s[i] + s[i - 1] + s[i - 2] + s[i - 3]) / 4);
    }
    const lufs = (e: number) => -0.691 + 10 * Math.log10(e);
    const abs = blocks.filter((e) => lufs(e) > -70);
    if (!abs.length) return -Infinity;
    const relThreshold = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const rel = abs.filter((e) => lufs(e) > relThreshold);
    if (!rel.length) return -Infinity;
    return lufs(rel.reduce((a, b) => a + b, 0) / rel.length);
  }
}

/**
 * Applies a fixed gain followed by a look-ahead peak limiter (ceiling in dBFS).
 * Output is delay-compensated: the total number of output frames equals the input frames.
 */
export class GainLimiter {
  private gain: number;
  private ceiling: number;
  private look: number;
  private delay: Float32Array[];
  private pos = 0;
  private skip: number;
  private reduction: Float32Array; // required gain per sample (ring, same size as delay)
  private dq: number[] = []; // monotonic deque of absolute sample indices
  private index = 0;
  private env = 1;
  private attack: number;
  private release: number;

  private channels: number;

  constructor(sampleRate: number, channels: number, gainDb: number, ceilingDb = -1) {
    this.channels = channels;
    this.gain = Math.pow(10, gainDb / 20);
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.look = Math.max(1, Math.round(sampleRate * 0.005));
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.look + 1));
    this.reduction = new Float32Array(this.look + 1);
    this.skip = this.look;
    this.attack = 1 - Math.exp(-1 / (this.look / 4));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.15));
  }

  process(planes: Float32Array[]): Float32Array[] {
    return this.run(planes, planes[0].length);
  }

  /** Emits the remaining delayed frames. */
  flush(): Float32Array[] {
    const zeros = Array.from({ length: this.channels }, () => new Float32Array(this.look));
    return this.run(zeros, this.look);
  }

  private run(planes: Float32Array[], n: number): Float32Array[] {
    const size = this.look + 1;
    const outLen = Math.max(0, n - Math.max(0, this.skip));
    const out = Array.from({ length: this.channels }, () => new Float32Array(outLen));
    let o = 0;
    for (let i = 0; i < n; i++) {
      // write gained input into delay line
      let p = 0;
      for (let c = 0; c < this.channels; c++) {
        const v = planes[c][i] * this.gain;
        this.delay[c][this.pos] = v;
        const a = Math.abs(v);
        if (a > p) p = a;
      }
      const need = p > this.ceiling ? this.ceiling / p : 1;
      this.reduction[this.pos] = need;
      const idx = this.index++;
      while (this.dq.length && this.reduction[this.dq[this.dq.length - 1] % size] >= need) this.dq.pop();
      this.dq.push(idx);
      while (this.dq[0] <= idx - size) this.dq.shift();
      const target = this.reduction[this.dq[0] % size];

      this.env += (target - this.env) * (target < this.env ? this.attack : this.release);
      const g = this.env;

      const readPos = (this.pos + 1) % size; // oldest sample = delayed by `look`
      this.pos = readPos;
      if (this.skip > 0) {
        this.skip--;
        continue;
      }
      for (let c = 0; c < this.channels; c++) {
        let v = this.delay[c][readPos] * g;
        if (v > this.ceiling) v = this.ceiling;
        else if (v < -this.ceiling) v = -this.ceiling;
        out[c][o] = v;
      }
      o++;
    }
    return out;
  }
}
