

function readU16(bytes: Uint8Array, pos: number): number {
  return bytes[pos] | (bytes[pos + 1] << 8);
}


function readColorTable(bytes: Uint8Array, pos: number, size: number): number[] {
  const out = new Array<number>(size * 3);
  for (let i = 0; i < size; i++) {
    out[i * 3] = bytes[pos + i * 3];
    out[i * 3 + 1] = bytes[pos + i * 3 + 1];
    out[i * 3 + 2] = bytes[pos + i * 3 + 2];
  }
  return out;
}


function lzwDecompress(data: number[], minCodeSize: number, expected: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([]);
    dict.push([]);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let prevCode = -1;
  let bitPos = 0;
  let buf = 0;
  let bitCount = 0;
  const readCode = (): number => {
    while (bitCount < codeSize) {
      buf |= data[bitPos++] << bitCount;
      bitCount += 8;
    }
    const code = buf & ((1 << codeSize) - 1);
    buf >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };
  while (out.length < expected) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      prevCode = -1;
      continue;
    }
    if (code === endCode) break;
    if (prevCode < 0) {
      out.push(code);
      prevCode = code;
      continue;
    }
    let entry: number[];
    if (code < dict.length) {
      entry = dict[code];
    } else if (code === dict.length) {
      entry = [dict[prevCode][0], ...dict[prevCode]];
    } else {
      break;
    }
    out.push(...entry);
    dict.push([...dict[prevCode], entry[0]]);
    if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    prevCode = code;
  }
  return out;
}


function interlaceRowOrder(height: number): number[] {
  const order: number[] = [];
  for (let y = 0; y < height; y += 8) order.push(y);
  for (let y = 4; y < height; y += 8) order.push(y);
  for (let y = 2; y < height; y += 4) order.push(y);
  for (let y = 1; y < height; y += 2) order.push(y);
  return order;
}

export function decodeGif(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 13) throw new Error('GIF: truncated header');
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('GIF: bad signature');
  const width = readU16(bytes, 6);
  const height = readU16(bytes, 8);
  if (width < 1 || height < 1) throw new Error('GIF: bad dimensions');
  const packed = bytes[10];
  const gctSize = 2 << (packed & 7);
  let pos = 13;
  let gct: number[] | null = null;
  if (packed & 0x80) {
    gct = readColorTable(bytes, pos, gctSize);
    pos += gctSize * 3;
  }
  const out = new Uint8Array(width * height * 4);
  let prevCanvas: Uint8Array | null = null;
  let nextTransparent = -1;
  let nextDisposal = 0;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const gceSize = bytes[pos++];
        const flags = bytes[pos];
        nextTransparent = flags & 1 ? bytes[pos + 3] : -1;
        nextDisposal = (flags >> 2) & 7;
        pos += gceSize + 1;
      } else {
        while (true) {
          const n = bytes[pos++];
          if (n === 0) break;
          pos += n;
        }
      }
      continue;
    }
    if (block !== 0x2c) throw new Error('GIF: unexpected block 0x' + block.toString(16));
    const left = readU16(bytes, pos); pos += 2;
    const top = readU16(bytes, pos); pos += 2;
    const iw = readU16(bytes, pos); pos += 2;
    const ih = readU16(bytes, pos); pos += 2;
    const ipacked = bytes[pos++];
    const interlace = (ipacked >> 6) & 1;
    let ct = gct;
    if (ipacked & 0x80) {
      const lctSize = 2 << (ipacked & 7);
      ct = readColorTable(bytes, pos, lctSize);
      pos += lctSize * 3;
    }
    const minCodeSize = bytes[pos++];
    const data: number[] = [];
    while (true) {
      const n = bytes[pos++];
      if (n === 0) break;
      for (let i = 0; i < n; i++) data.push(bytes[pos + i]);
      pos += n;
    }
    const indices = lzwDecompress(data, minCodeSize, iw * ih);
    const pal = ct as number[];
    const t = nextTransparent;
    const disposal = nextDisposal;
    nextTransparent = -1;
    nextDisposal = 0;
    if (disposal === 3) prevCanvas = new Uint8Array(out);
    const rowOrder = interlace ? interlaceRowOrder(ih) : null;
    let idx = 0;
    for (let y = 0; y < ih && idx < indices.length; y++) {
      const ty = top + (rowOrder ? rowOrder[y] : y);
      if (ty >= height) continue;
      for (let x = 0; x < iw && idx < indices.length; x++) {
        const pi = indices[idx++];
        const tx = left + x;
        if (tx >= width) continue;
        const o = (ty * width + tx) * 4;
        if (pi === t) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = 0;
        } else {
          out[o] = pal[pi * 3];
          out[o + 1] = pal[pi * 3 + 1];
          out[o + 2] = pal[pi * 3 + 2];
          out[o + 3] = 255;
        }
      }
    }
    if (disposal === 2) {
      for (let y = 0; y < ih; y++) {
        const ty = top + y;
        if (ty >= height) continue;
        for (let x = 0; x < iw; x++) {
          const tx = left + x;
          if (tx >= width) continue;
          const o = (ty * width + tx) * 4;
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = 0;
        }
      }
    } else if (disposal === 3 && prevCanvas) {
      out.set(prevCanvas);
    }
  }
  return { width, height, rgba: out };
}
