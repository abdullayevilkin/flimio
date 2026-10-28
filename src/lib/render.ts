/**
 * Loops a short video over a long audio track and exports an MP4 — entirely in the browser.
 *
 * Each stream is handled in the cheapest mode possible:
 * - Video is stream-copied (no re-encode) unless the clip is compressed or an intro/outro is added.
 *   In that case only the short pieces (intro + clip + outro) are encoded once, with a single encoder,
 *   so they share one decoder config; the encoded clip is then looped by copying its packets.
 * - Audio is stream-copied (trim at packet precision) unless loudness normalization or intro/outro
 *   is requested; then it's decoded, trimmed sample-accurately, gain/limited and re-encoded to AAC.
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type Rotation,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';
import { GainLimiter, LoudnessMeter } from './loudness';

export type RenderOptions = {
  audio: File;
  video: File;
  intro?: File | null;
  outro?: File | null;
  /** Seconds to cut from the start / end of the audio. */
  trimStart?: number;
  trimEnd?: number;
  /** Normalize integrated loudness to this LUFS target (YouTube plays at about -14). */
  normalize?: { targetLufs: number } | null;
  /** Re-encode the loop clip smaller. */
  compress?: { maxHeight: number | null; bitrate: number } | null;
  /** Written into the MP4 metadata. */
  title?: string;
  /** Write straight to disk (File System Access API). Without it the result is kept in memory. */
  writable?: WritableStream<StreamTargetChunk>;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
};

export type RenderResult = {
  blob: Blob | null;
  duration: number;
  loudness?: { measured: number; gainDb: number };
};

type Segment = { packets: EncodedPacket[]; start: number; duration: number };
type PreparedVideo = {
  codec: VideoCodec;
  decoderConfig: VideoDecoderConfig;
  rotation: Rotation;
  intro: Segment | null;
  clip: Segment;
  outro: Segment | null;
};

const ABORT = () => new DOMException('Cancelled', 'AbortError');

export async function render(opts: RenderOptions): Promise<RenderResult> {
  const { signal } = opts;
  const report = opts.onProgress ?? (() => {});
  const inputs: Input[] = [];
  const open = (file: File) => {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    inputs.push(input);
    return input;
  };
  let output: Output | null = null;

  try {
    const audioTrack = await open(opts.audio).getPrimaryAudioTrack();
    const clipTrack = await open(opts.video).getPrimaryVideoTrack();
    if (!audioTrack) throw new Error('The audio file has no audio track. Choose another audio file.');
    if (!clipTrack) throw new Error('The loop video has no video track. Choose another video file.');
    const introInput = opts.intro ? open(opts.intro) : null;
    const outroInput = opts.outro ? open(opts.outro) : null;
    const introTrack = introInput ? await introInput.getPrimaryVideoTrack() : null;
    const outroTrack = outroInput ? await outroInput.getPrimaryVideoTrack() : null;
    if (introInput && !introTrack) throw new Error('The intro file has no video track. Choose another file or remove the intro.');
    if (outroInput && !outroTrack) throw new Error('The outro file has no video track. Choose another file or remove the outro.');

    const format = new Mp4OutputFormat({ fastStart: false });

    // ---- Timeline -------------------------------------------------------------------------
    const audioEnd = await audioTrack.computeDuration();
    const trimStart = clamp(opts.trimStart ?? 0, 0, audioEnd);
    const mainEnd = clamp(audioEnd - (opts.trimEnd ?? 0), trimStart, audioEnd);
    const mainDuration = mainEnd - trimStart;
    if (mainDuration < 1) throw new Error('Cut less from the start or end — less than 1 second of audio would remain.');

    const encodeVideo = !!(opts.compress || introTrack || outroTrack);
    const encodeAudio = !!(opts.normalize || introTrack || outroTrack);
    const wPrep = encodeVideo ? 0.1 : 0;
    const wAnalyze = opts.normalize ? 0.35 : 0;
    const wRender = 1 - wPrep - wAnalyze;

    // ---- Video ----------------------------------------------------------------------------
    const video = encodeVideo
      ? await encodeVideoParts(format, clipTrack, introTrack, outroTrack, opts.video, opts.compress ?? null, (p) =>
          report(p * wPrep, 'Encoding clip'),
        signal)
      : await copyClip(format, clipTrack);
    if (signal?.aborted) throw ABORT();

    const introDur = video.intro?.duration ?? 0;
    const outroDur = video.outro?.duration ?? 0;
    const total = introDur + mainDuration + outroDur;

    // ---- Audio preparation ----------------------------------------------------------------
    let audioPlan: AudioPlan;
    let loudness: RenderResult['loudness'];
    if (encodeAudio) {
      const outRate = audioTrack.sampleRate;
      const introPcm = opts.intro ? await decodeShort(opts.intro, outRate) : null;
      const outroPcm = opts.outro ? await decodeShort(opts.outro, outRate) : null;
      const outCh = Math.min(
        2,
        Math.max(audioTrack.numberOfChannels, introPcm?.numberOfChannels ?? 1, outroPcm?.numberOfChannels ?? 1),
      );

      let gainDb = 0;
      if (opts.normalize) {
        const meter = new LoudnessMeter(outRate, outCh);
        for await (const chunk of mainPcm(audioTrack, trimStart, mainEnd, outCh)) {
          if (signal?.aborted) throw ABORT();
          meter.push(chunk.planes);
          report(wPrep + wAnalyze * ((chunk.end - trimStart) / mainDuration), 'Analyzing loudness');
        }
        const measured = meter.integrated();
        gainDb = Number.isFinite(measured) ? clamp(opts.normalize.targetLufs - measured, -30, 30) : 0;
        loudness = { measured, gainDb };
      }

      if (!(await canEncodeAudio('aac', { numberOfChannels: outCh, sampleRate: outRate }))) {
        const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
        registerAacEncoder();
      }
      audioPlan = { kind: 'encode', outRate, outCh, introPcm, outroPcm, gainDb, normalize: !!opts.normalize };
    } else {
      if (!audioTrack.codec || !format.getSupportedAudioCodecs().includes(audioTrack.codec)) {
        throw new Error(`This audio format (${audioTrack.codec ?? 'unknown'}) can't be saved in MP4 as-is. Turn on “Normalize loudness” to convert it.`);
      }
      audioPlan = { kind: 'copy' };
    }

    // ---- Output ---------------------------------------------------------------------------
    const target = opts.writable ? new StreamTarget(opts.writable, { chunked: true }) : new BufferTarget();
    output = new Output({ format, target });
    if (opts.title) output.setMetadataTags({ title: opts.title });

    const videoSource = new EncodedVideoPacketSource(video.codec);
    output.addVideoTrack(videoSource, { rotation: video.rotation });

    const copyAudioSource = audioPlan.kind === 'copy' ? new EncodedAudioPacketSource(audioTrack.codec!) : null;
    const encAudioSource =
      audioPlan.kind === 'encode' ? new AudioSampleSource({ codec: 'aac', quality: QUALITY_HIGH }) : null;
    output.addAudioTrack((copyAudioSource ?? encAudioSource)!);
    await output.start();

    // Video packets are interleaved against the audio clock.
    const videoPackets = timeline(video, mainDuration);
    let nextVideo = videoPackets.next();
    let firstVideo = true;
    const addVideoUntil = async (time: number) => {
      while (!nextVideo.done && nextVideo.value.timestamp <= time) {
        await videoSource.add(nextVideo.value, firstVideo ? { decoderConfig: video.decoderConfig } : undefined);
        firstVideo = false;
        nextVideo = videoPackets.next();
      }
    };
    let lastReport = 0;
    const progress = (t: number) => {
      const now = performance.now();
      if (now - lastReport < 100) return;
      lastReport = now;
      report(wPrep + wAnalyze + wRender * Math.min(0.99, t / total), 'Rendering');
    };

    if (audioPlan.kind === 'copy') {
      const meta = { decoderConfig: (await audioTrack.getDecoderConfig()) ?? undefined };
      let first = true;
      for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
        if (signal?.aborted) throw ABORT();
        if (packet.timestamp >= mainEnd) break;
        if (trimStart > 0 && packet.timestamp + packet.duration <= trimStart) continue;
        const p = trimStart > 0 ? packet.clone({ timestamp: packet.timestamp - trimStart }) : packet;
        await addVideoUntil(p.timestamp + 0.5);
        await copyAudioSource!.add(p, first ? meta : undefined);
        first = false;
        progress(p.timestamp);
      }
    } else {
      const { outRate, outCh, introPcm, outroPcm, gainDb, normalize } = audioPlan;
      let written = 0;
      const emit = async (planes: Float32Array[]) => {
        const n = planes[0]?.length ?? 0;
        if (!n) return;
        if (signal?.aborted) throw ABORT();
        const ts = written / outRate;
        await addVideoUntil(ts + 0.5);
        const data = new Float32Array(n * outCh);
        for (let c = 0; c < outCh; c++) data.set(planes[c], c * n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: outCh, sampleRate: outRate, timestamp: ts });
        await encAudioSource!.add(sample);
        sample.close();
        written += n;
        progress(ts);
      };

      if (video.intro) await emitFixed(emit, introPcm, outCh, Math.round(introDur * outRate));
      const limiter = normalize ? new GainLimiter(outRate, outCh, gainDb) : null;
      for await (const chunk of mainPcm(audioTrack, trimStart, mainEnd, outCh)) {
        await emit(limiter ? limiter.process(chunk.planes) : chunk.planes);
      }
      if (limiter) await emit(limiter.flush());
      if (video.outro) await emitFixed(emit, outroPcm, outCh, Math.round(outroDur * outRate));
    }
    await addVideoUntil(Infinity);
    await output.finalize();
    report(1, 'Done');

    const blob = target instanceof BufferTarget ? new Blob([target.buffer!], { type: 'video/mp4' }) : null;
    return { blob, duration: total, loudness };
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => {});
    }
    throw err;
  } finally {
    for (const input of inputs) input.dispose();
  }
}

// ==== Video ==================================================================================

/** Reads the clip's packets as-is (stream copy). */
async function copyClip(format: Mp4OutputFormat, track: InputVideoTrack): Promise<PreparedVideo> {
  if (!track.codec || !format.getSupportedVideoCodecs().includes(track.codec)) {
    throw new Error(`This video format (${track.codec ?? 'unknown'}) can't be saved in MP4 as-is. Turn on “Compress loop video” to convert it.`);
  }
  const all: EncodedPacket[] = [];
  for await (const p of new EncodedPacketSink(track).packets()) all.push(p);
  const firstKey = all.findIndex((p) => p.type === 'key');
  if (firstKey < 0) throw new Error('The loop video can’t be looped as-is. Turn on “Compress loop video” to re-encode it.');
  const packets = all.slice(firstKey);

  const durations = packets.map((p) => p.duration).filter((d) => d > 0).sort((a, b) => a - b);
  const frameDur = durations.length ? durations[durations.length >> 1] : 1 / 30;
  const start = Math.min(...packets.map((p) => p.timestamp));
  const end = Math.max(...packets.map((p) => p.timestamp + (p.duration > 0 ? p.duration : frameDur)));

  const config = await track.getDecoderConfig();
  if (!config) throw new Error('Could not read the loop video’s format. Turn on “Compress loop video” to re-encode it.');
  return {
    codec: track.codec,
    decoderConfig: config,
    rotation: await track.getRotation(),
    intro: null,
    clip: { packets, start, duration: end - start },
    outro: null,
  };
}

/**
 * Encodes intro + clip + outro with ONE encoder so all packets share a decoder config.
 * Every segment starts on a forced key frame, so the clip can be looped by packet copy.
 */
async function encodeVideoParts(
  format: Mp4OutputFormat,
  clip: InputVideoTrack,
  intro: InputVideoTrack | null,
  outro: InputVideoTrack | null,
  clipFile: File,
  compress: { maxHeight: number | null; bitrate: number } | null,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<PreparedVideo> {
  const srcW = clip.displayWidth;
  const srcH = clip.displayHeight;
  const height = even(compress?.maxHeight ? Math.min(srcH, compress.maxHeight) : srcH);
  const width = even((srcW * height) / srcH);

  const clipDuration = await clip.computeDuration();
  const sourceBitrate = (clipFile.size * 8) / Math.max(clipDuration, 0.1);
  const bitrate = compress?.bitrate ?? clamp(sourceBitrate, 1_000_000, 12_000_000);

  const preferred: VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1'];
  const codec = await getFirstEncodableVideoCodec(
    preferred.filter((c) => format.getSupportedVideoCodecs().includes(c)),
    { width, height, bitrate },
  );
  if (!codec) throw new Error('This browser can’t encode video. Use Chrome or Edge, or turn off compression and intro/outro.');

  const packets: EncodedPacket[] = [];
  let decoderConfig: VideoDecoderConfig | null = null;
  const source = new VideoSampleSource({
    codec,
    bitrate,
    keyFrameInterval: 2,
    onEncodedPacket: (packet, meta) => {
      packets.push(packet);
      if (!decoderConfig && meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
  });
  const scratch = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  scratch.addVideoTrack(source);
  await scratch.start();

  const parts = [intro, clip, outro];
  const durations = await Promise.all(parts.map((t) => (t ? t.computeDuration() : 0)));
  const totalDur = durations.reduce((a, b) => a + b, 0) || 1;
  const ranges: ({ start: number; end: number } | null)[] = [];
  let t = 0;
  for (const track of parts) {
    if (!track) {
      ranges.push(null);
      continue;
    }
    const first = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { width, height, fit: 'contain', poolSize: 2 });
    const start = t;
    let end = t;
    let n = 0;
    for await (const frame of sink.canvases()) {
      if (signal?.aborted) {
        await scratch.cancel();
        throw ABORT();
      }
      const ts = start + Math.max(0, frame.timestamp - first);
      const sample = new VideoSample(frame.canvas, { timestamp: ts, duration: frame.duration });
      await source.add(sample, n === 0 ? { keyFrame: true } : undefined);
      sample.close();
      n++;
      end = Math.max(end, ts + frame.duration);
      onProgress(Math.min(0.99, end / totalDur));
    }
    if (!n) throw new Error('Could not read frames from one of the videos. Re-export that clip as an H.264 MP4 and try again.');
    ranges.push({ start, end });
    t = end;
  }
  await scratch.finalize();
  if (!decoderConfig) throw new Error('Video encoder produced no decoder config.');

  const segment = (r: { start: number; end: number } | null): Segment | null => {
    if (!r) return null;
    const eps = 1e-4;
    const seg = packets.filter((p) => p.timestamp >= r.start - eps && p.timestamp < r.end - eps);
    if (!seg.length || seg[0].type !== 'key') throw new Error('Video segment does not start with a key frame.');
    return { packets: seg, start: r.start, duration: r.end - r.start };
  };
  onProgress(1);
  return {
    codec,
    decoderConfig,
    rotation: 0,
    intro: segment(ranges[0]),
    clip: segment(ranges[1])!,
    outro: segment(ranges[2]),
  };
}

/**
 * Yields the final video packet sequence: intro, the clip looped over `mainDuration`, outro.
 * For the last partial loop a decode-order prefix is used (up to the last packet whose
 * presentation time is inside the range) — references always precede a packet in decode order,
 * so this stays decodable even with B-frames.
 */
function* timeline(v: PreparedVideo, mainDuration: number): Generator<EncodedPacket> {
  let seq = 0;
  const shifted = function* (seg: Segment, offset: number, limit = Infinity) {
    let count = seg.packets.length;
    if (limit < seg.duration) {
      count = 0;
      seg.packets.forEach((p, i) => {
        if (p.timestamp - seg.start < limit) count = i + 1;
      });
    }
    for (let i = 0; i < count; i++) {
      const p = seg.packets[i];
      yield p.clone({ timestamp: offset + (p.timestamp - seg.start), sequenceNumber: seq++ });
    }
  };

  const introDur = v.intro?.duration ?? 0;
  if (v.intro) yield* shifted(v.intro, 0);
  for (let k = 0; ; k++) {
    const offset = k * v.clip.duration;
    const remaining = mainDuration - offset;
    if (remaining <= 1e-6) break;
    yield* shifted(v.clip, introDur + offset, remaining);
  }
  if (v.outro) yield* shifted(v.outro, introDur + mainDuration);
}

// ==== Audio ==================================================================================

type AudioPlan =
  | { kind: 'copy' }
  | {
      kind: 'encode';
      outRate: number;
      outCh: number;
      introPcm: AudioBuffer | null;
      outroPcm: AudioBuffer | null;
      gainDb: number;
      normalize: boolean;
    };

/** Streams the main audio as planar Float32 chunks, trimmed sample-accurately to [from, to). */
async function* mainPcm(track: InputAudioTrack, from: number, to: number, outCh: number) {
  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples(from, to)) {
    const rate = sample.sampleRate;
    const startFrame = clamp(Math.round((from - sample.timestamp) * rate), 0, sample.numberOfFrames);
    const endFrame = clamp(Math.round((to - sample.timestamp) * rate), 0, sample.numberOfFrames);
    const count = endFrame - startFrame;
    if (count > 0) {
      const planes: Float32Array[] = [];
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const buf = new Float32Array(count);
        sample.copyTo(buf, { planeIndex: c, format: 'f32-planar', frameOffset: startFrame, frameCount: count });
        planes.push(buf);
      }
      yield { planes: mapChannels(planes, outCh, count), end: sample.timestamp + endFrame / rate };
    }
    sample.close();
  }
}

/** Decodes the (short) audio of an intro/outro, resampled to `rate`. Returns null if it has none. */
async function decodeShort(file: File, rate: number): Promise<AudioBuffer | null> {
  try {
    const ctx = new OfflineAudioContext(2, 1, rate);
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** Emits exactly `frames` frames from `buf` (padded with silence / cut as needed). */
async function emitFixed(
  emit: (planes: Float32Array[]) => Promise<void>,
  buf: AudioBuffer | null,
  outCh: number,
  frames: number,
) {
  const src = buf ? Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) : [];
  const CHUNK = 8192;
  for (let pos = 0; pos < frames; pos += CHUNK) {
    const n = Math.min(CHUNK, frames - pos);
    const planes: Float32Array[] = src.length
      ? src.map((ch) => {
          const out = new Float32Array(n);
          if (pos < ch.length) out.set(ch.subarray(pos, Math.min(ch.length, pos + n)));
          return out;
        })
      : [new Float32Array(n)];
    await emit(mapChannels(planes, outCh, n));
  }
}

function mapChannels(planes: Float32Array[], outCh: number, n: number): Float32Array[] {
  if (planes.length === outCh) return planes;
  if (planes.length === 1) return Array.from({ length: outCh }, () => planes[0]);
  if (outCh === 1) {
    const mono = new Float32Array(n);
    for (const p of planes) for (let i = 0; i < n; i++) mono[i] += p[i] / planes.length;
    return [mono];
  }
  return planes.slice(0, outCh);
}

// ==== Helpers ================================================================================

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function even(x: number) {
  return Math.max(2, Math.round(x / 2) * 2);
}

/** Rough output size estimate in bytes. */
export function estimateSize(o: {
  audioSize: number;
  audioDuration: number;
  mainDuration: number;
  clipSize: number;
  clipDuration: number;
  compressBitrate: number | null;
  reencodeAudio: boolean;
  extraSize: number;
}): number {
  const audio = o.reencodeAudio ? (192_000 / 8) * o.mainDuration : o.audioSize * (o.mainDuration / o.audioDuration);
  const video = o.compressBitrate
    ? (o.compressBitrate / 8) * o.mainDuration
    : o.clipSize * (o.mainDuration / Math.max(o.clipDuration, 0.1));
  return audio + video + o.extraSize;
}
