
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

const BITRATES: Record<number, number[][]> = {
  3: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
  0: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};

const SAMPLES_PER_FRAME = [384, 1152, 1152];
const SAMPLES_PER_FRAME_LOW = [384, 1152, 576];

function id3v2End(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size;
}

export function mp3DurationMs(bytes: Uint8Array): number {
  if (!bytes || bytes.length < 4) return 0;
  let off = id3v2End(bytes);
  let totalSamples = 0;
  let firstSampleRate = 0;
  let frames = 0;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff || (bytes[off + 1] & 0xe0) !== 0xe0) {
      off++;
      continue;
    }
    const version = (bytes[off + 1] >> 3) & 0x3;
    const layerBits = (bytes[off + 1] >> 1) & 0x3;
    const bitrateIdx = (bytes[off + 2] >> 4) & 0xf;
    const srIdx = (bytes[off + 2] >> 2) & 0x3;
    const padding = (bytes[off + 2] >> 1) & 0x1;
    if (version === 1 || layerBits === 0 || srIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) {
      off++;
      continue;
    }
    const layer = 3 - layerBits;
    const sampleRate = SAMPLE_RATES[version][srIdx];
    const bitrateKbps = BITRATES[version][layer][bitrateIdx];
    if (sampleRate === 0 || bitrateKbps === 0) {
      off++;
      continue;
    }
    const samplesPerFrame = version === 3 ? SAMPLES_PER_FRAME[layer] : SAMPLES_PER_FRAME_LOW[layer];
    let frameLen: number;
    if (layer === 0) {
      frameLen = Math.floor((12 * bitrateKbps * 1000) / sampleRate + padding) * 4;
    } else {
      const factor = version === 3 ? 144 : 72;
      frameLen = Math.floor((factor * bitrateKbps * 1000) / sampleRate) + padding;
    }
    if (frameLen < 4) {
      off++;
      continue;
    }
    if (firstSampleRate === 0) firstSampleRate = sampleRate;
    totalSamples += samplesPerFrame;
    frames++;
    off += frameLen;
  }
  if (frames === 0 || firstSampleRate === 0) return 0;
  return Math.round((totalSamples / firstSampleRate) * 1000);
}
