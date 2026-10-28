/**
 * Loops a short video over a long audio track and exports an MP4.
 *
 * NO re-encoding: video and audio packets are copied as-is (stream copy) into the new MP4,
 * with the video packet timestamps shifted for every loop. A 20-minute result is usually
 * ready in a few seconds, with no quality loss.
 *
 * Framework-agnostic — usable without React.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type InputAudioTrack,
  type InputVideoTrack,
  type StreamTargetChunk,
} from 'mediabunny';

export type MediaInfo = {
  duration: number;
  codec: string | null;
  width?: number;
  height?: number;
  size: number;
};

export async function probeAudio(file: File): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('No audio track found in this file.');
    return { duration: await track.computeDuration(), codec: track.codec, size: file.size };
  } finally {
    input.dispose();
  }
}

export async function probeVideo(file: File): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found in this file.');
    return {
      duration: await track.computeDuration(),
      codec: track.codec,
      width: track.displayWidth,
      height: track.displayHeight,
      size: file.size,
    };
  } finally {
    input.dispose();
  }
}

export type LoopMergeOptions = {
  audio: File;
  video: File;
  /**
   * Where to write the result. If omitted, the result is built in memory and returned as a Blob.
   * Passing a `FileSystemWritableFileStream` (File System Access API) is best —
   * the file goes straight to disk with minimal RAM use.
   */
  writable?: WritableStream<StreamTargetChunk>;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};

export type LoopMergeResult = {
  blob: Blob | null;
  duration: number;
  loops: number;
  mimeType: string;
};

type LoopPacket = { packet: EncodedPacket; relTs: number };

export async function loopMerge(opts: LoopMergeOptions): Promise<LoopMergeResult> {
  const { audio, video, writable, onProgress, signal } = opts;

  const audioInput = new Input({ source: new BlobSource(audio), formats: ALL_FORMATS });
  const videoInput = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
  let output: Output | null = null;

  try {
    const audioTrack = await audioInput.getPrimaryAudioTrack();
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    if (!audioTrack) throw new Error('The audio file has no audio track.');
    if (!videoTrack) throw new Error('The video file has no video track.');

    const format = new Mp4OutputFormat({ fastStart: false });
    checkCodecs(format, audioTrack, videoTrack);

    const audioDuration = await audioTrack.computeDuration();
    const clip = await readClip(videoTrack);
    if (clip.loopDuration <= 0) throw new Error('Could not determine the video duration.');

    const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
    output = new Output({ format, target });

    const videoSource = new EncodedVideoPacketSource(videoTrack.codec!);
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec!);
    output.addVideoTrack(videoSource, { rotation: await videoTrack.getRotation() });
    output.addAudioTrack(audioSource);
    await output.start();

    const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig()) ?? undefined };
    const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig()) ?? undefined };

    const videoPackets = loopedVideo(clip.packets, clip.loopDuration, audioDuration);
    let nextVideo = videoPackets.next();
    let firstVideo = true;
    let firstAudio = true;

    const addVideoUntil = async (time: number) => {
      while (!nextVideo.done && nextVideo.value.timestamp <= time) {
        await videoSource.add(nextVideo.value, firstVideo ? videoMeta : undefined);
        firstVideo = false;
        nextVideo = videoPackets.next();
      }
    };

    // Audio is the master clock; video packets are interleaved against it so the
    // muxer doesn't have to buffer everything in memory.
    const audioSink = new EncodedPacketSink(audioTrack);
    let lastReport = 0;
    for await (const packet of audioSink.packets()) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await addVideoUntil(packet.timestamp + 0.5);
      await audioSource.add(packet, firstAudio ? audioMeta : undefined);
      firstAudio = false;

      const now = performance.now();
      if (onProgress && now - lastReport > 100) {
        lastReport = now;
        onProgress(Math.min(0.99, packet.timestamp / audioDuration));
      }
    }
    await addVideoUntil(Infinity);

    const mimeType = await output.getMimeType();
    await output.finalize();
    onProgress?.(1);

    let blob: Blob | null = null;
    if (target instanceof BufferTarget) {
      blob = new Blob([target.buffer!], { type: 'video/mp4' });
    }
    return {
      blob,
      duration: audioDuration,
      loops: audioDuration / clip.loopDuration,
      mimeType,
    };
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => {});
    }
    throw err;
  } finally {
    audioInput.dispose();
    videoInput.dispose();
  }
}

function checkCodecs(format: Mp4OutputFormat, a: InputAudioTrack, v: InputVideoTrack) {
  if (!v.codec || !format.getSupportedVideoCodecs().includes(v.codec)) {
    throw new Error(`This video codec can't go into MP4: ${v.codec ?? 'unknown'}`);
  }
  if (!a.codec || !format.getSupportedAudioCodecs().includes(a.codec)) {
    throw new Error(`This audio codec can't go into MP4: ${a.codec ?? 'unknown'}`);
  }
}

/** Reads all packets of the short clip (in decode order) into memory and computes the loop duration. */
async function readClip(track: InputVideoTrack) {
  const sink = new EncodedPacketSink(track);
  const all: EncodedPacket[] = [];
  for await (const p of sink.packets()) all.push(p);

  // The clip must start on a key frame, otherwise the start of every loop would be corrupted.
  const firstKey = all.findIndex((p) => p.type === 'key');
  if (firstKey < 0) throw new Error('The video has no key frame.');
  const raw = all.slice(firstKey);

  const positive = raw.map((p) => p.duration).filter((d) => d > 0).sort((x, y) => x - y);
  const frameDur = positive.length ? positive[Math.floor(positive.length / 2)] : 1 / 30;

  const t0 = Math.min(...raw.map((p) => p.timestamp));
  const end = Math.max(...raw.map((p) => p.timestamp + (p.duration > 0 ? p.duration : frameDur)));

  const packets: LoopPacket[] = raw.map((p) => ({ packet: p, relTs: p.timestamp - t0 }));
  return { packets, loopDuration: end - t0 };
}

/**
 * Repeats the clip until it covers `total` seconds.
 * For the last (partial) loop a decode-order prefix is used, up to the last packet with pts < remaining.
 * References always precede a packet in decode order, so this stays decodable even with B-frames.
 */
function* loopedVideo(clip: LoopPacket[], loopDur: number, total: number): Generator<EncodedPacket> {
  let seq = 0;
  for (let k = 0; ; k++) {
    const offset = k * loopDur;
    const remaining = total - offset;
    if (remaining <= 1e-6) return;

    let count = clip.length;
    if (remaining < loopDur) {
      count = 0;
      for (let i = 0; i < clip.length; i++) if (clip[i].relTs < remaining) count = i + 1;
    }
    for (let i = 0; i < count; i++) {
      const { packet, relTs } = clip[i];
      yield packet.clone({ timestamp: offset + relTs, sequenceNumber: seq++ });
    }
  }
}

/** Rough output size estimate (bytes). */
export function estimateOutputSize(audio: MediaInfo, video: MediaInfo): number {
  if (!video.duration) return audio.size;
  return audio.size + video.size * (audio.duration / video.duration);
}
