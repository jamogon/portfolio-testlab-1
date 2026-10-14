#!/usr/bin/env node
/**
 * optimize-images.cjs — Genera versiones WebP optimizadas de las imágenes de proyecto.
 *
 * Uso:  node js/tests/optimize-images.cjs
 *
 * Entrada:  assets/project-01.jpg … assets/project-04.jpg
 * Salida:   assets/project-XX-400w.webp  (400×250)
 *           assets/project-XX-800w.webp  (800×500)
 *
 * Zero-dependency (Node ≥ 18). Decodifica JPEG baseline, redimensiona con
 * area-average y codifica WebP lossless (VP8L).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/*  JPEG decoder (baseline DCT, Huffman)                               */
/* ------------------------------------------------------------------ */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

function buildHuffmanTable(counts, symbols) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      table.set((code << 16) | len, symbols[k++]);
      code++;
    }
    code <<= 1;
  }
  return table;
}

function bitReader(data) {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  function readBit() {
    if (bitCnt === 0) {
      if (pos >= data.length) throw new Error('JPEG: unexpected end of data');
      let byte = data[pos++];
      if (byte === 0xff) {
        const next = data[pos++];
        if (next === 0x00) {
          /* stuffed byte — ok */
        } else if (next >= 0xd0 && next <= 0xd7) {
          /* restart marker — skip */
        } else {
          throw new Error(`JPEG: unexpected marker 0xFF${next.toString(16)} in scan data`);
        }
      }
      bitBuf = byte;
      bitCnt = 8;
    }
    const bit = (bitBuf >> 7) & 1;
    bitBuf = (bitBuf << 1) & 0xff;
    bitCnt--;
    return bit;
  }

  function readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  }

  function decodeHuffman(table) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      const sym = table.get((code << 16) | len);
      if (sym !== undefined) return sym;
    }
    throw new Error('JPEG: invalid Huffman code');
  }

  return { readBit, readBits, decodeHuffman, get pos() { return pos; } };
}

function idct8x8(block) {
  const out = new Float32Array(64);
  const tmp = new Float32Array(64);
  const C = [];
  for (let i = 0; i < 8; i++) C[i] = i === 0 ? 1 / Math.SQRT2 : 1;
  const cos = [];
  for (let u = 0; u < 8; u++) {
    cos[u] = [];
    for (let x = 0; x < 8; x++) cos[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          sum += C[u] * C[v] * block[v * 8 + u] * cos[u][x] * cos[v][y];
        }
      }
      tmp[y * 8 + x] = sum / 4;
    }
  }
  for (let i = 0; i < 64; i++) out[i] = tmp[i] + 128;
  return out;
}

function decodeJpeg(buffer) {
  let pos = 0;
  function readMarker() {
    while (pos < buffer.length && buffer[pos] !== 0xff) pos++;
    while (pos < buffer.length && buffer[pos] === 0xff) pos++;
    return buffer[pos++];
  }
  function readSegment() {
    const len = buffer.readUInt16BE(pos);
    const data = buffer.slice(pos + 2, pos + len);
    pos += len;
    return data;
  }

  const quantTables = [];
  const huffmanDC = [];
  const huffmanAC = [];
  let width = 0;
  let height = 0;
  let components = [];
  let maxH = 1;
  let maxV = 1;
  let precision = 8;

  /* ---- parse headers ---- */
  for (;;) {
    const marker = readMarker();
    if (marker === 0xd8) continue; // SOI
    if (marker === 0xd9) break;    // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone

    const seg = readSegment();
    switch (marker) {
      case 0xdb: { // DQT
        let off = 0;
        while (off < seg.length) {
          const id = seg[off] & 0x0f;
          const prec = seg[off] >> 4;
          off++;
          const table = new Uint16Array(64);
          for (let i = 0; i < 64; i++) {
            table[ZIGZAG[i]] = prec ? seg.readUInt16BE(off + i * 2) : seg[off + i];
          }
          off += prec ? 128 : 64;
          quantTables[id] = table;
        }
        break;
      }
      case 0xc4: { // DHT
        let off = 0;
        while (off < seg.length) {
          const tc = seg[off] >> 4;
          const th = seg[off] & 0x0f;
          off++;
          const counts = Array.from(seg.slice(off, off + 16));
          off += 16;
          const total = counts.reduce((a, b) => a + b, 0);
          const symbols = Array.from(seg.slice(off, off + total));
          off += total;
          const table = buildHuffmanTable(counts, symbols);
          if (tc === 0) huffmanDC[th] = table;
          else huffmanAC[th] = table;
        }
        break;
      }
      case 0xc0: // SOF0 (baseline)
      case 0xc1: { // SOF1
        precision = seg[0];
        height = seg.readUInt16BE(1);
        width = seg.readUInt16BE(3);
        const ncomp = seg[5];
        components = [];
        for (let i = 0; i < ncomp; i++) {
          const id = seg[6 + i * 3];
          const hv = seg[7 + i * 3];
          const tq = seg[8 + i * 3];
          components.push({
            id,
            h: hv >> 4,
            v: hv & 0x0f,
            tq,
            dcTable: null,
            acTable: null,
          });
          if (hv >> 4 > maxH) maxH = hv >> 4;
          if ((hv & 0x0f) > maxV) maxV = hv & 0x0f;
        }
        break;
      }
      case 0xc2:
        throw new Error('JPEG progresivo no soportado');
      case 0xda: { // SOS
        const ns = seg[0];
        for (let i = 0; i < ns; i++) {
          const cs = seg[1 + i * 2];
          const tdta = seg[2 + i * 2];
          const comp = components.find(c => c.id === cs);
          if (comp) {
            comp.dcTable = huffmanDC[tdta >> 4];
            comp.acTable = huffmanAC[tdta & 0x0f];
          }
        }
        /* scan data starts here */
        const scanData = buffer.slice(pos);
        return decodeScan(scanData, components, width, height, maxH, maxV, quantTables);
      }
      default:
        /* skip unknown segments */
        break;
    }
  }
  throw new Error('JPEG: no SOS found');
}

function decodeScan(data, components, width, height, maxH, maxV, quantTables) {
  const reader = bitReader(data);
  const mcusX = Math.ceil(width / (maxH * 8));
  const mcusY = Math.ceil(height / (maxV * 8));

  /* per-component planes */
  const planes = components.map(comp => {
    const pw = Math.ceil((width * comp.h) / maxH);
    const ph = Math.ceil((height * comp.v) / maxV);
    return {
      comp,
      data: new Float32Array(pw * ph),
      width: pw,
      height: ph,
      dcPred: 0,
    };
  });

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (const plane of planes) {
        const { comp } = plane;
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            const block = new Float32Array(64);
            /* DC */
            const dcSym = reader.decodeHuffman(comp.dcTable);
            let dcDiff = 0;
            if (dcSym > 0) {
              dcDiff = reader.readBits(dcSym);
              if (dcDiff < (1 << (dcSym - 1))) dcDiff -= (1 << dcSym) - 1;
            }
            plane.dcPred += dcDiff;
            block[0] = plane.dcPred * quantTables[comp.tq][0];
            /* AC */
            let k = 1;
            while (k < 64) {
              const rs = reader.decodeHuffman(comp.acTable);
              const r = rs >> 4;
              const s = rs & 0x0f;
              if (s === 0) {
                if (r === 15) { k += 16; continue; }
                break; // EOB
              }
              k += r;
              if (k >= 64) break;
              let val = reader.readBits(s);
              if (val < (1 << (s - 1))) val -= (1 << s) - 1;
              block[ZIGZAG[k]] = val * quantTables[comp.tq][ZIGZAG[k]];
              k++;
            }
            const pixels = idct8x8(block);
            const px = mx * comp.h * 8 + bx * 8;
            const py = my * comp.v * 8 + by * 8;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                const dx = px + x;
                const dy = py + y;
                if (dx < plane.width && dy < plane.height) {
                  plane.data[dy * plane.width + dx] = pixels[y * 8 + x];
                }
              }
            }
          }
        }
      }
    }
  }

  /* convert to RGB */
  const rgb = new Uint8Array(width * height * 3);
  const [yPlane, cbPlane, crPlane] = planes;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const yi = yPlane.data[y * yPlane.width + x];
      const cbi = cbPlane.data[
        Math.min(Math.floor(y * cbPlane.height / height), cbPlane.height - 1) * cbPlane.width +
        Math.min(Math.floor(x * cbPlane.width / width), cbPlane.width - 1)
      ];
      const cri = crPlane.data[
        Math.min(Math.floor(y * crPlane.height / height), crPlane.height - 1) * crPlane.width +
        Math.min(Math.floor(x * crPlane.width / width), crPlane.width - 1)
      ];
      const idx = (y * width + x) * 3;
      rgb[idx] = clamp(Math.round(yi + 1.402 * (cri - 128)), 0, 255);
      rgb[idx + 1] = clamp(Math.round(yi - 0.344136 * (cbi - 128) - 0.714136 * (cri - 128)), 0, 255);
      rgb[idx + 2] = clamp(Math.round(yi + 1.772 * (cbi - 128)), 0, 255);
    }
  }
  return { data: rgb, width, height };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ------------------------------------------------------------------ */
/*  Resizer (area-average / box sampling)                              */
/* ------------------------------------------------------------------ */

function resize(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 3);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = dx * xRatio;
      const x1 = x0 + xRatio;
      const y0 = dy * yRatio;
      const y1 = y0 + yRatio;
      let r = 0, g = 0, b = 0, area = 0;
      const ix0 = Math.floor(x0);
      const ix1 = Math.ceil(x1);
      const iy0 = Math.floor(y0);
      const iy1 = Math.ceil(y1);
      for (let iy = iy0; iy < iy1; iy++) {
        const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
        if (wy <= 0) continue;
        for (let ix = ix0; ix < ix1; ix++) {
          const wx = Math.min(ix + 1, x1) - Math.max(ix, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (Math.min(iy, srcH - 1) * srcW + Math.min(ix, srcW - 1)) * 3;
          r += src[si] * w;
          g += src[si + 1] * w;
          b += src[si + 2] * w;
          area += w;
        }
      }
      const di = (dy * dstW + dx) * 3;
      dst[di] = Math.round(r / area);
      dst[di + 1] = Math.round(g / area);
      dst[di + 2] = Math.round(b / area);
    }
  }
  return dst;
}

/* ------------------------------------------------------------------ */
/*  WebP lossless (VP8L) encoder                                       */
/* ------------------------------------------------------------------ */

const LITERAL_CODES = 280;   // 256 literals + 24 length codes
const DIST_CODES = 40;       // distance codes

const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5];
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,32769,49153,65537,98305,131073,163841,196609,229377,262145];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14,15,15,16,16,17,17,18,18];

function lengthToCode(len) {
  for (let i = LENGTH_BASE.length - 1; i >= 0; i--) {
    if (len >= LENGTH_BASE[i]) return i;
  }
  return 0;
}

function distToCode(dist) {
  for (let i = DIST_BASE.length - 1; i >= 0; i--) {
    if (dist >= DIST_BASE[i]) return i;
  }
  return 0;
}

/* LZ77 with hash chains */
function lz77(data, width, height) {
  const WINDOW = 1 << 15;
  const MAX_CHAIN = 128;
  const MIN_MATCH = 3;
  const MAX_MATCH = 131;
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const HASH_MASK = HASH_SIZE - 1;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);

  function hash(pos) {
    let h = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16);
    h = ((h * 0x9e3779b1) >>> 0) & HASH_MASK;
    return h;
  }

  const tokens = [];
  let pos = 0;
  const totalPixels = width * height;

  while (pos < data.length) {
    let bestLen = 0;
    let bestDist = 0;

    if (pos + MIN_MATCH <= data.length) {
      const h = hash(pos);
      let candidate = head[h];
      let chain = 0;
      const maxLen = Math.min(MAX_MATCH, data.length - pos);

      while (candidate >= 0 && chain < MAX_CHAIN) {
        const dist = pos - candidate;
        if (dist > WINDOW) break;
        let len = 0;
        while (len < maxLen && data[candidate + len] === data[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= maxLen) break;
        }
        candidate = prev[candidate];
        chain++;
      }
    }

    if (bestLen >= MIN_MATCH) {
      tokens.push({ type: 'match', len: bestLen, dist: bestDist });
      for (let i = 0; i < bestLen; i++) {
        if (pos + i + MIN_MATCH <= data.length) {
          const h = hash(pos + i);
          prev[pos + i] = head[h];
          head[h] = pos + i;
        }
      }
      pos += bestLen;
    } else {
      tokens.push({ type: 'literal', sym: data[pos] });
      if (pos + MIN_MATCH <= data.length) {
        const h = hash(pos);
        prev[pos] = head[h];
        head[h] = pos;
      }
      pos++;
    }
  }
  return tokens;
}

/* canonical Huffman codes */
function buildCanonicalCodes(lengths) {
  const maxLen = Math.max(...lengths.filter(l => l > 0), 0);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let n = 0; n < lengths.length; n++) {
    if (lengths[n] > 0) {
      codes[n] = nextCode[lengths[n]]++;
    }
  }
  return codes;
}

/* bit writer (LSB-first) */
function bitWriter() {
  const bytes = [];
  let bitBuf = 0;
  let bitCnt = 0;
  function writeBits(value, count) {
    bitBuf |= value << bitCnt;
    bitCnt += count;
    while (bitCnt >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCnt -= 8;
    }
  }
  function finish() {
    if (bitCnt > 0) {
      bytes.push(bitBuf & 0xff);
    }
    return Buffer.from(bytes);
  }
  return { writeBits, finish };
}

/* write Huffman code lengths (VP8L "simple" form for single-symbol alphabets) */
function writeHuffmanCode(bw, lengths) {
  const used = lengths.filter(l => l > 0);
  if (used.length === 0) {
    /* empty alphabet — write a single code of length 0 */
    bw.writeBits(0, 1); // not simple
    bw.writeBits(0, 4); // numCodeLengthCodes = 0 (invalid, but decoder won't read)
    return;
  }
  if (used.length === 1) {
    /* simple form: 1 bit = 1, then symbol */
    const sym = lengths.indexOf(used[0]);
    bw.writeBits(1, 1); // simple
    bw.writeBits(sym, 8); // symbol (8 bits for literal/length alphabet)
    return;
  }
  /* normal form */
  bw.writeBits(0, 1); // not simple
  /* code length alphabet order */
  const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const NUM_CODE_LENGTH_CODES = 19;
  /* build code length code lengths */
  const clLengths = new Array(NUM_CODE_LENGTH_CODES).fill(0);
  /* encode each code length as a literal (no RLE) */
  const clSymbols = [];
  for (const l of lengths) {
    clSymbols.push(l); // 0..15
  }
  /* count frequencies */
  const clFreq = new Array(NUM_CODE_LENGTH_CODES).fill(0);
  for (const s of clSymbols) clFreq[s]++;
  /* build Huffman for code lengths */
  const clCodeLengths = buildHuffmanLengths(clFreq, 7);
  /* write numCodeLengthCodes */
  let numCodes = NUM_CODE_LENGTH_CODES;
  while (numCodes > 4 && clCodeLengths[CODE_LENGTH_ORDER[numCodes - 1]] === 0) numCodes--;
  bw.writeBits(numCodes - 4, 4);
  for (let i = 0; i < numCodes; i++) {
    bw.writeBits(clCodeLengths[CODE_LENGTH_ORDER[i]], 3);
  }
  /* write code lengths */
  const clCodes = buildCanonicalCodes(clCodeLengths);
  for (const s of clSymbols) {
    const len = clCodeLengths[s];
    bw.writeBits(clCodes[s], len);
  }
}

/* build Huffman code lengths from frequencies (package-merge simplified) */
function buildHuffmanLengths(freqs, maxLen) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const items = [];
  for (let i = 0; i < n; i++) {
    if (freqs[i] > 0) items.push({ sym: i, freq: freqs[i] });
  }
  if (items.length === 0) return lengths;
  if (items.length === 1) {
    lengths[items[0].sym] = 1;
    return lengths;
  }
  /* simple Huffman: repeatedly merge two smallest */
  const nodes = items.map(it => ({ ...it, children: null }));
  const heap = [...nodes];
  while (heap.length > 1) {
    heap.sort((a, b) => a.freq - b.freq);
    const a = heap.shift();
    const b = heap.shift();
    heap.push({ freq: a.freq + b.freq, children: [a, b] });
  }
  function walk(node, depth) {
    if (node.children) {
      walk(node.children[0], depth + 1);
      walk(node.children[1], depth + 1);
    } else {
      lengths[node.sym] = Math.min(depth, maxLen);
    }
  }
  walk(heap[0], 0);
  return lengths;
}

/* encode image as WebP lossless */
function encodeWebPLossless(rgb, width, height) {
  /* convert RGB to ARGB (alpha=255) */
  const argb = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    argb[i * 4] = 255; // alpha
    argb[i * 4 + 1] = rgb[i * 3]; // R
    argb[i * 4 + 2] = rgb[i * 3 + 1]; // G
    argb[i * 4 + 3] = rgb[i * 3 + 2]; // B
  }

  /* LZ77 on the green channel (VP8L uses green for literals) */
  const green = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) green[i] = argb[i * 4 + 2];
  const tokens = lz77(green, width, height);

  /* build frequency tables */
  const greenFreq = new Array(LITERAL_CODES).fill(0);
  const redFreq = new Array(256).fill(0);
  const blueFreq = new Array(256).fill(0);
  const alphaFreq = new Array(256).fill(0);
  const distFreq = new Array(DIST_CODES).fill(0);

  for (const t of tokens) {
    if (t.type === 'literal') {
      greenFreq[t.sym]++;
      /* for simplicity, encode red/blue/alpha as literals too */
      redFreq[argb[(tokens.indexOf(t)) * 4 + 1]]++;
      blueFreq[argb[(tokens.indexOf(t)) * 4 + 3]]++;
      alphaFreq[255]++;
    } else {
      const lenCode = lengthToCode(t.len);
      greenFreq[256 + lenCode]++;
      distFreq[distToCode(t.dist)]++;
    }
  }

  /* build Huffman codes */
  const greenLengths = buildHuffmanLengths(greenFreq, 15);
  const redLengths = buildHuffmanLengths(redFreq, 15);
  const blueLengths = buildHuffmanLengths(blueFreq, 15);
  const alphaLengths = buildHuffmanLengths(alphaFreq, 15);
  const distLengths = buildHuffmanLengths(distFreq, 15);

  const greenCodes = buildCanonicalCodes(greenLengths);
  const redCodes = buildCanonicalCodes(redLengths);
  const blueCodes = buildCanonicalCodes(blueLengths);
  const alphaCodes = buildCanonicalCodes(alphaLengths);
  const distCodes = buildCanonicalCodes(distLengths);

  /* write bitstream */
  const bw = bitWriter();
  /* VP8L header */
  bw.writeBits(0x2f, 8); // signature
  bw.writeBits(width - 1, 14);
  bw.writeBits(height - 1, 14);
  bw.writeBits(0, 1); // alpha used
  bw.writeBits(0, 3); // version

  /* no transforms */
  bw.writeBits(0, 1); // transform present
  /* no color cache */
  bw.writeBits(0, 1); // color cache present
  /* no meta-Huffman */
  bw.writeBits(0, 1); // meta-Huffman present

  /* write 5 Huffman codes */
  writeHuffmanCode(bw, greenLengths);
  writeHuffmanCode(bw, redLengths);
  writeHuffmanCode(bw, blueLengths);
  writeHuffmanCode(bw, alphaLengths);
  writeHuffmanCode(bw, distLengths);

  /* encode tokens */
  let pixelPos = 0;
  for (const t of tokens) {
    if (t.type === 'literal') {
      const sym = t.sym;
      bw.writeBits(greenCodes[sym], greenLengths[sym]);
      /* red, blue, alpha */
      const r = argb[pixelPos * 4 + 1];
      const b = argb[pixelPos * 4 + 3];
      const a = argb[pixelPos * 4];
      bw.writeBits(redCodes[r], redLengths[r]);
      bw.writeBits(blueCodes[b], blueLengths[b]);
      bw.writeBits(alphaCodes[a], alphaLengths[a]);
      pixelPos++;
    } else {
      const lenCode = lengthToCode(t.len);
      bw.writeBits(greenCodes[256 + lenCode], greenLengths[256 + lenCode]);
      bw.writeBits(t.len - LENGTH_BASE[lenCode], LENGTH_EXTRA[lenCode]);
      const dCode = distToCode(t.dist);
      bw.writeBits(distCodes[dCode], distLengths[dCode]);
      bw.writeBits(t.dist - DIST_BASE[dCode], DIST_EXTRA[dCode]);
      pixelPos += t.len;
    }
  }

  const payload = bw.finish();

  /* RIFF container */
  const riffSize = 12 + 8 + payload.length + (payload.length % 2);
  const riff = Buffer.alloc(riffSize);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(riffSize - 8, 4);
  riff.write('WEBP', 8);
  riff.write('VP8L', 12);
  riff.writeUInt32LE(payload.length, 16);
  payload.copy(riff, 20);
  return riff;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SIZES = [
  { suffix: '400w', width: 400, height: 250 },
  { suffix: '800w', width: 800, height: 500 },
];

function main() {
  const files = fs.readdirSync(ASSETS)
    .filter(f => /^project-\d+\.jpg$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error('No se encontraron imágenes project-*.jpg en', ASSETS);
    process.exit(1);
  }

  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of files) {
    const srcPath = path.join(ASSETS, file);
    const srcBuf = fs.readFileSync(srcPath);
    totalBefore += srcBuf.length;

    const { data: rgb, width, height } = decodeJpeg(srcBuf);
    console.log(`Decodificado ${file}: ${width}×${height}`);

    for (const size of SIZES) {
      const resized = resize(rgb, width, height, size.width, size.height);
      const webp = encodeWebPLossless(resized, size.width, size.height);
      const outName = file.replace('.jpg', `-${size.suffix}.webp`);
      const outPath = path.join(ASSETS, outName);
      fs.writeFileSync(outPath, webp);
      totalAfter += webp.length;
      console.log(`  → ${outName}  ${(webp.length / 1024).toFixed(1)} KiB`);
    }
  }

  console.log('\nResumen:');
  console.log(`  Antes:  ${(totalBefore / 1024).toFixed(1)} KiB (${files.length} archivos)`);
  console.log(`  Después: ${(totalAfter / 1024).toFixed(1)} KiB (${files.length * SIZES.length} archivos)`);
  console.log(`  Ahorro:  ${((1 - totalAfter / totalBefore) * 100).toFixed(1)} %`);
}

main();
