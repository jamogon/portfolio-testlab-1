/* ============================================================
   Optimización de imágenes — Portfolio
   Convierte las imágenes de proyecto (JPG) a WebP y genera
   variantes responsive (400w / 800w). Los JPG originales se
   conservan en assets/ como fallback para navegadores sin WebP.

   Uso:
     node js/tests/optimize-images.cjs

   Requisitos: Node.js >= 18. Sin dependencias externas:
   - Decodificador JPEG propio (baseline DCT Huffman, 8 bits,
     muestreos 4:4:4 / 4:2:2 / 4:2:0 / 4:1:1, sin progresivo).
   - Reescalado por muestreo de área (promedio de caja).
   - Codificador WebP lossless (VP8L) propio: LZ77 con hash
     chains + backward references y codificación Huffman
     canónica (sin meta-Huffman ni color cache).
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

/* ============================================================
   1. DECODIFICADOR JPEG (baseline) → { width, height, data:RGBA }
   ============================================================ */

function decodeJPEG(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("No es JPEG (SOI ausente)");

  // Tablas de Huffman: { dc: [...], ac: [...] } por id
  const huff = { dc: {}, ac: {} };
  const qtables = {};
  let frame = null;
  let pos = 2;

  const buildDec = (counts, symbols) => {
    // Genera tabla canónica: mapa (longitud,código) → símbolo
    const table = new Map();
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len++) {
      for (let i = 0; i < counts[len - 1]; i++) {
        table.set((len << 24) | code, symbols[k++]);
        code++;
      }
      code <<= 1;
    }
    return { table, maxLen: 16 };
  };

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    let marker = buf[pos + 1];
    // Rellenos 0xFF
    while (marker === 0xff) { pos++; marker = buf[pos + 1]; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const len = buf.readUInt16BE(pos + 2);
    const seg = pos + 4;

    if (marker === 0xdb) {
      // DQT
      let p = seg;
      while (p < seg + len - 2) {
        const pq = buf[p] >> 4;
        const id = buf[p] & 0x0f;
        p++;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          t[i] = pq === 0 ? buf[p + i] : buf.readUInt16BE(p + i * 2);
        }
        p += pq === 0 ? 64 : 128;
        qtables[id] = t;
      }
    } else if (marker === 0xc4) {
      // DHT
      let p = seg;
      const end = seg + len - 2;
      while (p < end) {
        const tc = buf[p] >> 4;
        const th = buf[p] & 0x0f;
        p++;
        const counts = Array.from(buf.subarray(p, p + 16));
        p += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        const symbols = Array.from(buf.subarray(p, p + total));
        p += total;
        huff[tc === 0 ? "dc" : "ac"][th] = buildDec(counts, symbols);
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (marker === 0xc2) throw new Error("JPEG progresivo no soportado");
      const height = buf.readUInt16BE(seg + 1);
      const width = buf.readUInt16BE(seg + 3);
      const ncomp = buf[seg + 5];
      const comps = [];
      for (let i = 0; i < ncomp; i++) {
        comps.push({
          id: buf[seg + 6 + i * 3],
          h: buf[seg + 6 + i * 3 + 1] >> 4,
          v: buf[seg + 6 + i * 3 + 1] & 0x0f,
          tq: buf[seg + 6 + i * 3 + 2],
        });
      }
      frame = { width, height, comps };
    } else if (marker === 0xda) {
      // SOS: cabecera de scan + datos entrelazados hasta el siguiente marker
      const ns = buf[seg];
      const scomps = [];
      for (let i = 0; i < ns; i++) {
        scomps.push({
          id: buf[seg + 1 + i * 2],
          td: buf[seg + 2 + i * 2] >> 4,
          ta: buf[seg + 2 + i * 2] & 0x0f,
        });
      }
      const dataStart = seg + len - 2;
      // El scan termina en el próximo marker no-RST (0xFF 0xD9 EOI, u otro)
      let dataEnd = dataStart;
      while (dataEnd < buf.length - 1) {
        if (buf[dataEnd] === 0xff && buf[dataEnd + 1] !== 0x00 &&
            !(buf[dataEnd + 1] >= 0xd0 && buf[dataEnd + 1] <= 0xd7)) {
          break;
        }
        dataEnd++;
      }
      const scan = buf.subarray(dataStart, dataEnd);
      const pixels = decodeScan(scan, frame, scomps, huff, qtables);
      return pixels;
    }
    pos += 2 + len;
  }
  throw new Error("No se encontró scan SOS");
}

// Lector de bits con destuffing de 0xFF00 y reinicio en RST
function bitReader(buf) {
  let bytePos = 0;
  let bitPos = 0;
  return {
    getBit() {
      if (bytePos >= buf.length) return 0; // padding
      let b = buf[bytePos];
      const bit = (b >> (7 - bitPos)) & 1;
      bitPos++;
      if (bitPos === 8) {
        bitPos = 0;
        bytePos++;
        if (bytePos < buf.length && buf[bytePos - 1] === 0xff) {
          if (buf[bytePos] === 0x00) bytePos++; // destuff
        }
      }
      return bit;
    },
    getBits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | this.getBit();
      return v;
    },
    align() {
      if (bitPos !== 0) { bitPos = 0; bytePos++; }
      // Saltar markers RST en el flujo
      while (bytePos + 1 < buf.length && buf[bytePos] === 0xff &&
             buf[bytePos + 1] >= 0xd0 && buf[bytePos + 1] <= 0xd7) {
        bytePos += 2;
      }
    },
  };
}

function huffDecode(reader, dec) {
  let code = 0;
  for (let len = 1; len <= dec.maxLen; len++) {
    code = (code << 1) | reader.getBit();
    const sym = dec.table.get((len << 24) | code);
    if (sym !== undefined) return sym;
  }
  throw new Error("Código Huffman inválido");
}

function extend(v, t) {
  // JPEG "extend": valores con t bits; si el bit alto es 0, es negativo
  return v < (1 << (t - 1)) ? v - (1 << t) + 1 : v;
}

// IDCT 8x8 (flotante, directa) sobre coeficientes descuantizados
function idct8x8(coeff) {
  const out = new Float64Array(64);
  const C = [];
  for (let u = 0; u < 8; u++) C[u] = u === 0 ? Math.SQRT1_2 : 1;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          s += C[u] * C[v] * coeff[v * 8 + u] *
               Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
               Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      out[y * 8 + x] = s / 4;
    }
  }
  return out;
}

// Orden zigzag
const ZZ = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

function decodeScan(scan, frame, scomps, huff, qtables) {
  const { width, height, comps } = frame;
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcusX = Math.ceil(width / (8 * maxH));
  const mcusY = Math.ceil(height / (8 * maxV));

  // Planos por componente (a resolución del componente)
  const planes = comps.map((c) => {
    const pw = mcusX * c.h * 8;
    const ph = mcusY * c.v * 8;
    return { w: pw, h: ph, data: new Float64Array(pw * ph) };
  });

  const reader = bitReader(scan);
  const predDC = new Array(comps.length).fill(0);

  const compById = {};
  comps.forEach((c, i) => (compById[c.id] = i));

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (const sc of scomps) {
        const ci = compById[sc.id];
        const comp = comps[ci];
        const plane = planes[ci];
        const dcDec = huff.dc[sc.td];
        const acDec = huff.ac[sc.ta];
        const qt = qtables[comp.tq];

        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            // DC
            const t = huffDecode(reader, dcDec);
            const diff = t > 0 ? extend(reader.getBits(t), t) : 0;
            predDC[ci] += diff;
            // AC
            const coeff = new Float64Array(64);
            coeff[0] = predDC[ci] * qt[0];
            let k = 1;
            while (k < 64) {
              const rs = huffDecode(reader, acDec);
              const r = rs >> 4;
              const s = rs & 0x0f;
              if (s === 0) {
                if (r === 15) { k += 16; continue; } // ZRL
                break; // EOB
              }
              k += r;
              if (k >= 64) break;
              coeff[ZZ[k]] = extend(reader.getBits(s), s) * qt[ZZ[k]];
              k++;
            }
            const block = idct8x8(coeff);
            const ox = (mx * comp.h + bx) * 8;
            const oy = (my * comp.v + by) * 8;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                plane.data[(oy + y) * plane.w + (ox + x)] = block[y * 8 + x] + 128;
              }
            }
          }
        }
      }
      reader.align(); // posibles RST entre MCUs
    }
  }

  // Recomponer a RGB con upsampling nearest.
  // Nota: las imágenes de este proyecto son 4:4:4 (sin subsampling),
  // pero el índice se calcula de forma general para 4:2:0/4:2:2.
  const rgba = new Uint8Array(width * height * 4);
  const ncomp = comps.length;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ncomp === 1) {
        const sy = Math.min(planes[0].h - 1, Math.floor(y * planes[0].h / height));
        const sx = Math.min(planes[0].w - 1, Math.floor(x * planes[0].w / width));
        const g = planes[0].data[sy * planes[0].w + sx];
        rgba[o] = rgba[o + 1] = rgba[o + 2] = clamp255(g);
      } else {
        const sy0 = Math.min(planes[0].h - 1, Math.floor(y * planes[0].h / height));
        const sx0 = Math.min(planes[0].w - 1, Math.floor(x * planes[0].w / width));
        const sy1 = Math.min(planes[1].h - 1, Math.floor(y * planes[1].h / height));
        const sx1 = Math.min(planes[1].w - 1, Math.floor(x * planes[1].w / width));
        const sy2 = Math.min(planes[2].h - 1, Math.floor(y * planes[2].h / height));
        const sx2 = Math.min(planes[2].w - 1, Math.floor(x * planes[2].w / width));
        const Y = planes[0].data[sy0 * planes[0].w + sx0];
        const Cb = planes[1].data[sy1 * planes[1].w + sx1] - 128;
        const Cr = planes[2].data[sy2 * planes[2].w + sx2] - 128;
        rgba[o] = clamp255(Y + 1.402 * Cr);
        rgba[o + 1] = clamp255(Y - 0.344136 * Cb - 0.714136 * Cr);
        rgba[o + 2] = clamp255(Y + 1.772 * Cb);
      }
      rgba[o + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/* ============================================================
   2. REESCALADO RGBA — muestreo de área (promedio de caja)
   ============================================================ */

function resizeRGBA(img, newW, newH) {
  const { width: sw, height: sh, data: src } = img;
  const out = new Uint8Array(newW * newH * 4);
  const xRatio = sw / newW;
  const yRatio = sh / newH;
  for (let y = 0; y < newH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * yRatio));
    for (let x = 0; x < newW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * xRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * sw + sx) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
          n++;
        }
      }
      const d = (y * newW + x) * 4;
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n); out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n);
    }
  }
  return { width: newW, height: newH, data: out };
}

/* ============================================================
   3. CODIFICADOR WEBP LOSSLESS (VP8L)
   ============================================================ */

class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
  }
  writeBits(value, n) {
    for (let i = 0; i < n; i++) {
      this.cur |= ((value >> i) & 1) << this.nbits;
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }
  // Escribe el código Huffman canónico (bits en orden MSB→LSB del código)
  writeHuff(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.writeBits((code >> i) & 1, 1);
    }
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.cur);
    return Buffer.from(this.bytes);
  }
}

// Longitudes de código limitadas a 15 bits (package-merge no necesario
// para alfabetos pequeños; usamos Huffman estándar con límite simple)
function huffmanCodeLengths(freqs, maxBits) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const items = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) items.push({ sym: i, f: freqs[i] });
  if (items.length === 0) return lengths;
  if (items.length === 1) { lengths[items[0].sym] = 1; return lengths; }

  // Huffman con límite de profundidad: heap simple
  const depths = new Array(n).fill(0);
  const nodes = items.map((it) => ({ f: it.f, left: -1, right: -1, sym: it.sym }));
  // Construcción del árbol con cola de prioridad simple
  const pq = nodes.map((nd, i) => i);
  const pull = () => {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (nodes[pq[i]].f < nodes[pq[bi]].f) bi = i;
    return pq.splice(bi, 1)[0];
  };
  while (pq.length > 1) {
    const a = pull();
    const b = pull();
    nodes.push({ f: nodes[a].f + nodes[b].f, left: a, right: b, sym: -1 });
    pq.push(nodes.length - 1);
  }
  const walk = (ni, d) => {
    const nd = nodes[ni];
    if (nd.sym >= 0) { depths[nd.sym] = Math.max(1, d); return; }
    walk(nd.left, d + 1);
    walk(nd.right, d + 1);
  };
  walk(pq[0], 0);

  // Limitar a maxBits (raro con nuestros alfabetos, pero por seguridad)
  for (let i = 0; i < n; i++) {
    if (depths[i] > 0) lengths[i] = Math.min(depths[i], maxBits);
  }
  return lengths;
}

// Asigna códigos canónicos a partir de longitudes
function canonicalCodes(lengths) {
  const maxLen = Math.max(...lengths, 0);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
  }
  return codes;
}

// Escribe las longitudes de código de un Huffman. Si hay un único
// símbolo usa la forma "simple" de VP8L; si no, envía las longitudes
// literales codificadas con el Huffman del alfabeto de longitudes
// (0..18), sin RLE, para mantenerlo sencillo y correcto.
function writeHuffmanCode(w, lengths) {
  const used = [];
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) used.push(i);

  if (used.length === 1) {
    // Forma simple de VP8L: 1 bit a 1 + símbolo (1 u 8 bits) +
    // 1 bit "is_last" a 1 (es el único código del alfabeto).
    w.writeBits(1, 1);
    const sym = used[0];
    if (sym <= 1) {
      w.writeBits(0, 1);
      w.writeBits(sym, 1);
    } else {
      w.writeBits(1, 1);
      w.writeBits(sym, 8);
    }
    w.writeBits(1, 1); // is_last
    return;
  }

  w.writeBits(0, 1); // no simple
  // Codificamos las longitudes con el código de longitudes (alfabeto 0..18),
  // sin RLE (todo literal) para mantenerlo sencillo y correcto.
  const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const lenFreqs = new Array(19).fill(0);
  for (const l of lengths) if (l > 0) lenFreqs[l]++;

  const lenLengths = huffmanCodeLengths(lenFreqs, 7);
  const lenCodes = canonicalCodes(lenLengths);

  // Elegir cuántos códigos de longitud enviar (mínimo 4)
  let numCodes = 19;
  while (numCodes > 4 && lenLengths[CODE_LENGTH_ORDER[numCodes - 1]] === 0) numCodes--;

  w.writeBits(numCodes - 4, 4);
  for (let i = 0; i < numCodes; i++) {
    w.writeBits(lenLengths[CODE_LENGTH_ORDER[i]], 3);
  }

  // Escribir cada longitud usando el código de longitudes
  for (const l of lengths) {
    w.writeHuff(lenCodes[l], lenLengths[l]);
  }
}

const LITERAL_CODES = 256 + 24; // literales + códigos de longitud
const DIST_CODES = 40;

const kLengthBase = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24];
const kLengthExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4];
const kDistBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,32769,49153,65537,98305,131073,163841,196609,262145,393217,524289];
const kDistExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14,15,15,16,16,17,17,18,18];

function lengthToCode(len) {
  for (let i = 23; i >= 0; i--) if (len >= kLengthBase[i]) return 256 + i;
  return 256;
}
function distToCode(dist) {
  for (let i = 39; i >= 0; i--) if (dist >= kDistBase[i]) return i;
  return 0;
}

// LZ77 con hash chains sobre píxeles ARGB (4 bytes)
function lz77(argb) {
  const n = argb.length;
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const WINDOW = 4096;
  const MAX_CHAIN = 64;
  const MIN_MATCH = 3; // en píxeles
  const MAX_MATCH = 24;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);

  const hash = (i) => {
    const p0 = argb[i];
    const p1 = i + 1 < n ? argb[i + 1] : 0;
    const p2 = i + 2 < n ? argb[i + 2] : 0;
    return ((p0 * 0x1e35a7bd + p1 * 0x9e3779b1 + p2 * 0x85ebca6b) >>> 0) & (HASH_SIZE - 1);
  };

  const tokens = []; // {type:'lit',px} | {type:'copy',len,dist}
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const h = hash(i);
      let cand = head[h];
      let chain = 0;
      while (cand >= 0 && i - cand <= WINDOW && chain < MAX_CHAIN) {
        let len = 0;
        const maxLen = Math.min(MAX_MATCH, n - i);
        while (len < maxLen && argb[cand + len] === argb[i + len]) len++;
        if (len > bestLen && len >= MIN_MATCH) {
          bestLen = len;
          bestDist = i - cand;
          if (len >= maxLen) break;
        }
        cand = prev[cand];
        chain++;
      }
    }
    if (bestLen >= MIN_MATCH) {
      tokens.push({ type: "copy", len: bestLen, dist: bestDist });
      for (let k = 0; k < bestLen; k++) {
        if (i + k + MIN_MATCH <= n) {
          const h = hash(i + k);
          prev[i + k] = head[h];
          head[h] = i + k;
        }
      }
      i += bestLen;
    } else {
      // Literal
      const px = argb[i];
      tokens.push({ type: "lit", px });
      if (i + MIN_MATCH <= n) {
        const h = hash(i);
        prev[i] = head[h];
        head[h] = i;
      }
      i++;
    }
  }
  return tokens;
}

function encodeWebPLossless(img) {
  const { width, height, data } = img;
  const n = width * height;

  // ARGB empaquetado (A<<24 | R<<16 | G<<8 | B)
  const argb = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    argb[i] = ((data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]) >>> 0;
  }

  const tokens = lz77(argb);

  // Frecuencias de los 5 alfabetos: verde, rojo, azul, alfa, distancia
  const fGreen = new Array(LITERAL_CODES).fill(0);
  const fRed = new Array(256).fill(0);
  const fBlue = new Array(256).fill(0);
  const fAlpha = new Array(256).fill(0);
  const fDist = new Array(DIST_CODES).fill(0);

  for (const t of tokens) {
    if (t.type === "lit") {
      const px = t.px;
      fGreen[(px >> 8) & 0xff]++;
      fRed[(px >> 16) & 0xff]++;
      fBlue[px & 0xff]++;
      fAlpha[(px >>> 24) & 0xff]++;
    } else {
      fGreen[lengthToCode(t.len)]++; // código de longitud en alfabeto verde
      fDist[distToCode(t.dist)]++;
    }
  }
  // Asegurar al menos un símbolo por alfabeto (Huffman válido)
  const ensure = (f) => { if (!f.some((x) => x > 0)) f[0] = 1; };
  ensure(fGreen); ensure(fRed); ensure(fBlue); ensure(fAlpha); ensure(fDist);

  const lGreen = huffmanCodeLengths(fGreen, 15);
  const lRed = huffmanCodeLengths(fRed, 15);
  const lBlue = huffmanCodeLengths(fBlue, 15);
  const lAlpha = huffmanCodeLengths(fAlpha, 15);
  const lDist = huffmanCodeLengths(fDist, 15);

  // VP8L exige códigos canónicos completos (suma Kraft = 1). Con un
  // único símbolo por alfabeto se usa la forma "simple"; con varios,
  // el árbol Huffman ya es completo por construcción.
  const cGreen = canonicalCodes(lGreen);
  const cRed = canonicalCodes(lRed);
  const cBlue = canonicalCodes(lBlue);
  const cAlpha = canonicalCodes(lAlpha);
  const cDist = canonicalCodes(lDist);

  const w = new BitWriter();
  w.writeBits(0x2f, 8); // firma VP8L
  w.writeBits(width - 1, 14);
  w.writeBits(height - 1, 14);
  w.writeBits(0, 1); // alpha_is_used = 0 (opacas)
  w.writeBits(0, 3); // version = 0

  // Transformaciones: bit a 1 mientras haya; aquí ninguna
  w.writeBits(0, 1);

  // color_cache_size = 0 → no cache
  w.writeBits(0, 1);

  // Meta-Huffman: huffman_image sin agrupación →
  // "use meta huffman" bit = 0
  w.writeBits(0, 1);

  // 5 códigos Huffman (verde, rojo, azul, alfa, distancia)
  writeHuffmanCode(w, lGreen);
  writeHuffmanCode(w, lRed);
  writeHuffmanCode(w, lBlue);
  writeHuffmanCode(w, lAlpha);
  writeHuffmanCode(w, lDist);

  // Datos LZ77
  for (const t of tokens) {
    if (t.type === "lit") {
      const px = t.px;
      const g = (px >> 8) & 0xff;
      w.writeHuff(cGreen[g], lGreen[g]);
      w.writeHuff(cRed[(px >> 16) & 0xff], lRed[(px >> 16) & 0xff]);
      w.writeHuff(cBlue[px & 0xff], lBlue[px & 0xff]);
      w.writeHuff(cAlpha[(px >>> 24) & 0xff], lAlpha[(px >>> 24) & 0xff]);
    } else {
      const lenCode = lengthToCode(t.len);
      w.writeHuff(cGreen[lenCode], lGreen[lenCode]);
      const li = lenCode - 256;
      if (kLengthExtra[li] > 0) {
        w.writeBits(t.len - kLengthBase[li], kLengthExtra[li]);
      }
      const dCode = distToCode(t.dist);
      w.writeHuff(cDist[dCode], lDist[dCode]);
      if (kDistExtra[dCode] > 0) {
        w.writeBits(t.dist - kDistBase[dCode], kDistExtra[dCode]);
      }
    }
  }

  const payload = w.finish();

  // Contenedor RIFF WebP (los chunks van alineados a tamaño par)
  const pad = payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const vp8lChunk = Buffer.concat([Buffer.from("VP8L"), u32le(payload.length), payload, pad]);
  return Buffer.concat([
    Buffer.from("RIFF"),
    u32le(4 + vp8lChunk.length),
    Buffer.from("WEBP"),
    vp8lChunk,
  ]);
}

function u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

/* ============================================================
   4. PROCESO
   ============================================================ */

const KB = 1024;

const TRABAJOS = [
  // Proyectos: original 800×500 → 400×250 (móvil) y 800×500 (escritorio)
  { src: "assets/project-01.jpg", salidas: [[400, 250], [800, 500]] },
  { src: "assets/project-02.jpg", salidas: [[400, 250], [800, 500]] },
  { src: "assets/project-03.jpg", salidas: [[400, 250], [800, 500]] },
  { src: "assets/project-04.jpg", salidas: [[400, 250], [800, 500]] },
];

console.log("\n=== Optimización de imágenes (JPG → WebP + responsive) ===\n");

let totalAntes = 0;
let totalDespues = 0;
let errores = 0;

for (const { src, salidas } of TRABAJOS) {
  const abs = path.join(ROOT, src);
  if (!fs.existsSync(abs)) {
    console.log(`  ⚠️  No existe: ${src}`);
    errores++;
    continue;
  }
  const sizeAntes = fs.statSync(abs).size;
  totalAntes += sizeAntes;

  let img;
  try {
    img = decodeJPEG(fs.readFileSync(abs));
  } catch (e) {
    console.log(`  ❌ ${src}: error decodificando JPEG — ${e.message}`);
    errores++;
    continue;
  }
  console.log(`  ${src} — ${(sizeAntes / KB).toFixed(1)} KB (${img.width}×${img.height})`);

  const base = src.replace(/\.jpe?g$/i, "");
  for (const [w, h] of salidas) {
    const escalada = (w === img.width && h === img.height) ? img : resizeRGBA(img, w, h);
    const webp = encodeWebPLossless(escalada);
    const dest = path.join(ROOT, `${base}-${w}w.webp`);
    fs.writeFileSync(dest, webp);
    totalDespues += webp.length;
    console.log(
      `    → ${base}-${w}w.webp — ${(webp.length / KB).toFixed(1)} KB (${w}×${h})`
    );
  }
}

console.log(`\n  Total original (JPG): ${(totalAntes / KB).toFixed(1)} KB`);
console.log(`  Total generado (WebP, todos los tamaños): ${(totalDespues / KB).toFixed(1)} KB`);
if (totalAntes > 0) {
  console.log(`  Variación: ${(((totalDespues - totalAntes) / totalAntes) * 100).toFixed(1)} %`);
}
console.log(`\n=== Fin (${errores === 0 ? "todo OK" : errores + " errores"}) ===\n`);
process.exit(errores === 0 ? 0 : 1);
