import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export type MediaInfo = {
  duration: number;
  codec: string | null;
  width?: number;
  height?: number;
  hasAudio?: boolean;
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
      hasAudio: !!(await input.getPrimaryAudioTrack()),
      size: file.size,
    };
  } finally {
    input.dispose();
  }
}
