/**
 * Qısa videonu uzun audionun üzərinə loop edib MP4 kimi export edir.
 *
 * Re-encode YOXDUR: video və audio paketləri olduğu kimi (stream copy) yeni MP4-ə köçürülür,
 * video paketlərinin timestamp-ləri hər loop üçün sürüşdürülür. Buna görə 20 dəqiqəlik
 * nəticə adətən bir neçə saniyəyə hazır olur və keyfiyyət itkisi olmur.
 *
 * Framework-dən asılı deyil — React olmadan da istifadə oluna bilər.
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
    if (!track) throw new Error('Bu faylda audio track tapılmadı.');
    return { duration: await track.computeDuration(), codec: track.codec, size: file.size };
  } finally {
    input.dispose();
  }
}

export async function probeVideo(file: File): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('Bu faylda video track tapılmadı.');
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
   * Nəticənin yazılacağı yer. Verilməzsə nəticə yaddaşda yığılır və Blob qaytarılır.
   * File System Access API-dən gələn `FileSystemWritableFileStream` vermək ən yaxşısıdır —
   * fayl birbaşa diskə yazılır, RAM istifadəsi minimal olur.
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
    if (!audioTrack) throw new Error('Audio faylda audio track tapılmadı.');
    if (!videoTrack) throw new Error('Video faylda video track tapılmadı.');

    const format = new Mp4OutputFormat({ fastStart: false });
    checkCodecs(format, audioTrack, videoTrack);

    const audioDuration = await audioTrack.computeDuration();
    const clip = await readClip(videoTrack);
    if (clip.loopDuration <= 0) throw new Error('Videonun müddəti təyin oluna bilmədi.');

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

    // Audio "master" kimi gedir; video paketləri ona uyğun interleave olunur ki,
    // muxer hər şeyi yaddaşda saxlamağa məcbur qalmasın.
    const audioSink = new EncodedPacketSink(audioTrack);
    let lastReport = 0;
    for await (const packet of audioSink.packets()) {
      if (signal?.aborted) throw new DOMException('Ləğv edildi', 'AbortError');
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
    throw new Error(`Video codec MP4 üçün dəstəklənmir: ${v.codec ?? 'naməlum'}`);
  }
  if (!a.codec || !format.getSupportedAudioCodecs().includes(a.codec)) {
    throw new Error(`Audio codec MP4 üçün dəstəklənmir: ${a.codec ?? 'naməlum'}`);
  }
}

/** Qısa klipin bütün paketlərini (decode sırası ilə) yaddaşa oxuyur və loop müddətini hesablayır. */
async function readClip(track: InputVideoTrack) {
  const sink = new EncodedPacketSink(track);
  const all: EncodedPacket[] = [];
  for await (const p of sink.packets()) all.push(p);

  // Klip key frame ilə başlamalıdır, əks halda hər loop-un əvvəli xarab görünər.
  const firstKey = all.findIndex((p) => p.type === 'key');
  if (firstKey < 0) throw new Error('Videoda key frame tapılmadı.');
  const raw = all.slice(firstKey);

  const positive = raw.map((p) => p.duration).filter((d) => d > 0).sort((x, y) => x - y);
  const frameDur = positive.length ? positive[Math.floor(positive.length / 2)] : 1 / 30;

  const t0 = Math.min(...raw.map((p) => p.timestamp));
  const end = Math.max(...raw.map((p) => p.timestamp + (p.duration > 0 ? p.duration : frameDur)));

  const packets: LoopPacket[] = raw.map((p) => ({ packet: p, relTs: p.timestamp - t0 }));
  return { packets, loopDuration: end - t0 };
}

/**
 * Klipi `total` saniyəni örtənə qədər təkrarlayır.
 * Son (natamam) loop-da decode sırası ilə prefiks götürülür: pts < qalan müddət olan son paketə qədər.
 * Decode sırasında hər paketin istinad etdiyi kadrlar ondan əvvəl gəldiyi üçün bu, B-frame-lərlə
 * belə düzgün decode olunan axın verir.
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

/** Nəticə faylının təxmini ölçüsü (bayt). */
export function estimateOutputSize(audio: MediaInfo, video: MediaInfo): number {
  if (!video.duration) return audio.size;
  return audio.size + video.size * (audio.duration / video.duration);
}
