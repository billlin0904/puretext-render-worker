import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsDirectory = path.resolve(process.env.PURETEXT_SUBTITLE_FONTS_DIR ?? path.join(root, "fonts", "subtitles", "render"));
const catalogPath = path.resolve(process.env.PURETEXT_SUBTITLE_FONT_CATALOG ?? path.join(root, "artifacts", "api-server", "src", "lib", "subtitle-font-catalog.generated.ts"));
const outputPath = path.resolve(process.env.PURETEXT_SUBTITLE_FONT_METRICS_OUTPUT ?? path.join(root, "artifacts", "api-server", "src", "lib", "subtitle-font-metrics.generated.ts"));

function uint16(buffer, offset) {
  return buffer.readUInt16BE(offset);
}

function uint32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function sfntTables(buffer) {
  if (buffer.length < 12) throw new Error("font is shorter than an sfnt header");
  if (buffer.subarray(0, 4).toString("ascii") === "ttcf") {
    throw new Error("TTC collections are not supported; provide one TTF/OTF face per render file");
  }
  const tableCount = uint16(buffer, 4);
  const tables = new Map();
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    const tag = buffer.subarray(recordOffset, recordOffset + 4).toString("ascii");
    const offset = uint32(buffer, recordOffset + 8);
    const length = uint32(buffer, recordOffset + 12);
    if (offset + length > buffer.length) throw new Error(`invalid ${tag} table bounds`);
    tables.set(tag, { offset, length });
  }
  return tables;
}

function decodeName(buffer, platformId, offset, length) {
  const bytes = buffer.subarray(offset, offset + length);
  if (platformId === 0 || platformId === 3) {
    let value = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      value += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return value.replace(/\0/g, "").trim();
  }
  return bytes.toString("latin1").replace(/\0/g, "").trim();
}

function fontNames(buffer, table) {
  if (!table || table.length < 6) return {};
  const count = uint16(buffer, table.offset + 2);
  const stringsOffset = table.offset + uint16(buffer, table.offset + 4);
  const values = new Map();
  for (let index = 0; index < count; index += 1) {
    const record = table.offset + 6 + index * 12;
    if (record + 12 > table.offset + table.length) break;
    const platformId = uint16(buffer, record);
    const languageId = uint16(buffer, record + 4);
    const nameId = uint16(buffer, record + 6);
    const length = uint16(buffer, record + 8);
    const offset = stringsOffset + uint16(buffer, record + 10);
    if (offset + length > table.offset + table.length) continue;
    const value = decodeName(buffer, platformId, offset, length);
    if (!value) continue;
    const preference = (platformId === 3 ? 4 : platformId === 0 ? 3 : 1) + (languageId === 0x0409 ? 2 : 0);
    const existing = values.get(nameId);
    if (!existing || preference > existing.preference) values.set(nameId, { value, preference });
  }
  return {
    family: values.get(16)?.value ?? values.get(1)?.value,
    subfamily: values.get(17)?.value ?? values.get(2)?.value,
    fullName: values.get(4)?.value,
    postScriptName: values.get(6)?.value,
  };
}

function cmapCodePoints(buffer, table) {
  if (!table || table.length < 4) return [];
  const codePoints = new Set();
  const subtableCount = uint16(buffer, table.offset + 2);
  const offsets = new Set();
  for (let index = 0; index < subtableCount; index += 1) {
    const record = table.offset + 4 + index * 8;
    if (record + 8 > table.offset + table.length) break;
    const platformId = uint16(buffer, record);
    const encodingId = uint16(buffer, record + 2);
    if (platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10))) {
      offsets.add(table.offset + uint32(buffer, record + 4));
    }
  }
  for (const offset of offsets) {
    if (offset + 2 > buffer.length) continue;
    const format = uint16(buffer, offset);
    if (format === 4) {
      const length = uint16(buffer, offset + 2);
      const limit = Math.min(buffer.length, offset + length);
      const segmentCount = uint16(buffer, offset + 6) / 2;
      const endCodes = offset + 14;
      const startCodes = endCodes + segmentCount * 2 + 2;
      const deltas = startCodes + segmentCount * 2;
      const rangeOffsets = deltas + segmentCount * 2;
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const start = uint16(buffer, startCodes + segment * 2);
        const end = uint16(buffer, endCodes + segment * 2);
        const delta = uint16(buffer, deltas + segment * 2);
        const rangeOffsetAddress = rangeOffsets + segment * 2;
        const rangeOffset = uint16(buffer, rangeOffsetAddress);
        for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
          let glyphId;
          if (rangeOffset === 0) {
            glyphId = (codePoint + delta) & 0xffff;
          } else {
            const glyphAddress = rangeOffsetAddress + rangeOffset + (codePoint - start) * 2;
            if (glyphAddress + 2 > limit) continue;
            glyphId = uint16(buffer, glyphAddress);
            if (glyphId !== 0) glyphId = (glyphId + delta) & 0xffff;
          }
          if (glyphId !== 0) codePoints.add(codePoint);
        }
      }
    } else if (format === 12 || format === 13) {
      const length = uint32(buffer, offset + 4);
      const limit = Math.min(buffer.length, offset + length);
      const groupCount = uint32(buffer, offset + 12);
      for (let group = 0; group < groupCount; group += 1) {
        const record = offset + 16 + group * 12;
        if (record + 12 > limit) break;
        const start = uint32(buffer, record);
        const end = uint32(buffer, record + 4);
        const firstGlyph = uint32(buffer, record + 8);
        for (let codePoint = start; codePoint <= end && codePoint <= 0x10ffff; codePoint += 1) {
          const glyphId = format === 13 ? firstGlyph : firstGlyph + codePoint - start;
          if (glyphId !== 0) codePoints.add(codePoint);
        }
      }
    }
  }
  const sorted = [...codePoints].sort((left, right) => left - right);
  const ranges = [];
  for (const codePoint of sorted) {
    const previous = ranges.at(-1);
    if (previous && codePoint === previous[1] + 1) previous[1] = codePoint;
    else ranges.push([codePoint, codePoint]);
  }
  return ranges;
}

function encodeRangeDeltas(ranges) {
  const bytes = [];
  const writeVarint = (input) => {
    let value = input >>> 0;
    while (value >= 0x80) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value);
  };
  let previousEnd = -1;
  for (const [start, end] of ranges) {
    writeVarint(start - previousEnd - 1);
    writeVarint(end - start);
    previousEnd = end;
  }
  return Buffer.from(bytes).toString("base64");
}

function readFontMetric(file, configuredFamily) {
  const buffer = fs.readFileSync(path.join(fontsDirectory, file));
  const tables = sfntTables(buffer);
  const head = tables.get("head");
  const os2 = tables.get("OS/2");
  if (!head || head.length < 20) throw new Error(`${file}: missing head.unitsPerEm`);
  if (!os2 || os2.length < 78) throw new Error(`${file}: missing OS/2 usWin metrics`);
  const unitsPerEm = uint16(buffer, head.offset + 18);
  const usWinAscent = uint16(buffer, os2.offset + 74);
  const usWinDescent = uint16(buffer, os2.offset + 76);
  if (!unitsPerEm || !usWinAscent || usWinAscent + usWinDescent <= 0) {
    throw new Error(`${file}: invalid OpenType metrics`);
  }
  const names = fontNames(buffer, tables.get("name"));
  return {
    family: configuredFamily ?? names.family ?? path.basename(file, path.extname(file)),
    file,
    unitsPerEm,
    usWinAscent,
    usWinDescent,
    assFontSizeScale: (usWinAscent + usWinDescent) / unitsPerEm,
    internalFamily: names.family ?? null,
    internalSubfamily: names.subfamily ?? null,
    fullName: names.fullName ?? null,
    postScriptName: names.postScriptName ?? null,
    coverageBase64: encodeRangeDeltas(cmapCodePoints(buffer, tables.get("cmap"))),
  };
}

function configuredFamilies() {
  const source = fs.readFileSync(catalogPath, "utf8");
  const families = new Map();
  const expression = /"family"\s*:\s*"([^"]+)"\s*,\s*"file"\s*:\s*"([^"]+)"/g;
  for (const match of source.matchAll(expression)) families.set(match[2], match[1]);
  return families;
}

if (!fs.existsSync(fontsDirectory)) throw new Error(`subtitle font directory not found: ${fontsDirectory}`);
const families = configuredFamilies();
const files = fs.readdirSync(fontsDirectory)
  .filter((file) => /\.(?:ttf|otf)$/i.test(file))
  .sort((left, right) => left.localeCompare(right));
const metrics = files.map((file) => readFontMetric(file, families.get(file)));
const output = `// Generated by scripts/generate-subtitle-font-metrics.mjs. Do not edit.\n` +
  `export type GeneratedSubtitleFontMetric = {\n` +
  `  family: string; file: string; unitsPerEm: number; usWinAscent: number; usWinDescent: number;\n` +
  `  assFontSizeScale: number; internalFamily: string | null; internalSubfamily: string | null;\n` +
  `  fullName: string | null; postScriptName: string | null; coverageBase64: string;\n` +
  `};\n` +
  `export const GENERATED_SUBTITLE_FONT_METRICS: ReadonlyArray<GeneratedSubtitleFontMetric> = ${JSON.stringify(metrics, null, 2)};\n`;
fs.writeFileSync(outputPath, output, "utf8");
console.log(`Generated metrics and cmap coverage for ${metrics.length} subtitle font files`);
