/**
 * MP3 duration (Director `member.duration` for sound members, in
 * milliseconds). Pure frame-header walk — no decode needed: every MPEG audio
 * frame carries its own version/layer/bitrate/sample-rate + a fixed sample
 * count, so summing frames gives the exact sample count regardless of CBR or
 * VBR. Handles ID3v2 tags and trailing garbage.
 */

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

// bitrate (kbps) by [version][layerIndex][bitrateIndex]; layerIndex 0=Layer I,
// 1=Layer II, 2=Layer III.
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

const SAMPLES_PER_FRAME = [384, 1152, 1152]; // Layer I, II, III (MPEG1)
const SAMPLES_PER_FRAME_LOW = [384, 1152, 576]; // Layer I, II, III (MPEG2/2.5)

/** Offset past an ID3v2 tag (when present), else 0. */
function id3v2End(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0; // "ID3"
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size;
}

/** MP3 duration in whole milliseconds; 0 when the bytes aren't MPEG audio. */
export function mp3DurationMs(bytes: Uint8Array): number {
  if (!bytes || bytes.length < 4) return 0;
  let off = id3v2End(bytes);
  let totalSamples = 0;
  let firstSampleRate = 0;
  let frames = 0;
  while (off + 4 <= bytes.length) {
    // MPEG audio frame sync: 11 set bits (0xFFE...).
    if (bytes[off] !== 0xff || (bytes[off + 1] & 0xe0) !== 0xe0) {
      off++;
      continue;
    }
    const version = (bytes[off + 1] >> 3) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
    const layerBits = (bytes[off + 1] >> 1) & 0x3; // 3=Layer I, 2=Layer II, 1=Layer III, 0=reserved
    const bitrateIdx = (bytes[off + 2] >> 4) & 0xf;
    const srIdx = (bytes[off + 2] >> 2) & 0x3;
    const padding = (bytes[off + 2] >> 1) & 0x1;
    if (version === 1 || layerBits === 0 || srIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) {
      // Not a valid frame header — skip a byte and resync.
      off++;
      continue;
    }
    const layer = 3 - layerBits; // 0=Layer I, 1=Layer II, 2=Layer III
    const sampleRate = SAMPLE_RATES[version][srIdx];
    const bitrateKbps = BITRATES[version][layer][bitrateIdx];
    if (sampleRate === 0 || bitrateKbps === 0) {
      off++;
      continue;
    }
    const samplesPerFrame = version === 3 ? SAMPLES_PER_FRAME[layer] : SAMPLES_PER_FRAME_LOW[layer];
    // Frame length in bytes (Layer I: (12*b/sr+pad)*4; II/III: 144 or 72 * b/sr + pad).
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
