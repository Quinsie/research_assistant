import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

const DEFAULT_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  archiveEntries: 10_000,
  entryBytes: 8 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  expansionRatio: 100
});

const LEGACY_BINARY = new Set([".doc", ".ppt", ".xls"]);
const ZIP_FORMATS = new Map([
  [".docx", "docx"],
  [".pptx", "pptx"],
  [".xlsx", "xlsx"],
  [".odt", "odt"]
]);

function boundedText(value, limit) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= limit) low = middle;
    else high = middle - 1;
  }
  return {
    text: `${value.slice(0, low)}\n[... bounded extraction truncated ...]\n`,
    truncated: true
  };
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlText(xml, options = {}) {
  const paragraphTags = options.paragraphTags ?? [
    "w:p",
    "a:p",
    "text:p",
    "text:h",
    "table:table-row"
  ];
  let value = xml;
  for (const tag of paragraphTags) {
    value = value.replace(new RegExp(`</${tag}>`, "giu"), "\n");
  }
  value = value
    .replace(/<w:tab\s*\/>/giu, "\t")
    .replace(/<w:br\b[^>]*\/>/giu, "\n")
    .replace(/<text:tab\s*\/>/giu, "\t")
    .replace(/<text:line-break\s*\/>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
  return decodeEntities(value)
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function safeZipName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\u0000")
  ) {
    throw new Error(`unsafe archive entry path: ${name}`);
  }
  return normalized;
}

function parseZip(buffer, limits) {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("ZIP central directory was not found");
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count > limits.archiveEntries) throw new Error("archive entry limit exceeded");
  if (centralOffset + centralSize > buffer.length) {
    throw new Error("ZIP central directory exceeds input");
  }
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid ZIP central directory entry");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const encoding = (flags & 0x800) !== 0 ? "utf8" : "latin1";
    const name = safeZipName(
      buffer.subarray(offset + 46, offset + 46 + nameLength).toString(encoding)
    );
    if (
      compressedSize > limits.inputBytes ||
      uncompressedSize > limits.entryBytes ||
      (
        compressedSize > 0 &&
        uncompressedSize / compressedSize > limits.expansionRatio
      )
    ) {
      throw new Error(`unsafe archive expansion for ${name}`);
    }
    entries.set(name, {
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry, name) {
  if ((entry.flags & 0x1) !== 0) throw new Error(`encrypted ZIP entry: ${name}`);
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`invalid ZIP local entry: ${name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`ZIP entry exceeds input: ${name}`);
  const compressed = buffer.subarray(start, end);
  let value;
  if (entry.method === 0) value = compressed;
  else if (entry.method === 8) value = inflateRawSync(compressed);
  else throw new Error(`unsupported ZIP compression method ${entry.method}`);
  if (value.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry size mismatch: ${name}`);
  }
  return value;
}

function selectedZipText(buffer, entries, names, limits) {
  const parts = [];
  let total = 0;
  for (const name of names) {
    const entry = entries.get(name);
    if (!entry) continue;
    const value = readZipEntry(buffer, entry, name);
    total += value.length;
    if (total > limits.outputBytes) throw new Error("selected archive output limit exceeded");
    parts.push({ name, text: value.toString("utf8") });
  }
  return parts;
}

function numericSort(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

function extractDocx(buffer, entries, limits) {
  const names = [...entries.keys()]
    .filter((name) =>
      name === "word/document.xml" ||
      /^word\/(?:header|footer)\d+\.xml$/u.test(name) ||
      /^word\/(?:footnotes|endnotes|comments)\.xml$/u.test(name))
    .sort(numericSort);
  if (!entries.has("word/document.xml")) throw new Error("DOCX document.xml is absent");
  const sections = selectedZipText(buffer, entries, names, limits)
    .map(({ name, text }) => `## ${name}\n\n${xmlText(text)}`)
    .filter((value) => value.trim().length > 0);
  return sections.join("\n\n");
}

function extractPptx(buffer, entries, limits) {
  const names = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort(numericSort);
  if (names.length === 0) throw new Error("PPTX contains no slide XML");
  return selectedZipText(buffer, entries, names, limits)
    .map(({ name, text }, index) => {
      const runs = [...text.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/giu)]
        .map((match) => decodeEntities(match[1]))
        .filter(Boolean);
      return `## Slide ${index + 1} (${name})\n\n${runs.join("\n")}`;
    })
    .join("\n\n");
}

function extractSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)]
    .map((match) =>
      [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)]
        .map((item) => decodeEntities(item[1]))
        .join(""));
}

function extractXlsx(buffer, entries, limits) {
  const sharedEntry = entries.get("xl/sharedStrings.xml");
  const shared = sharedEntry
    ? extractSharedStrings(
        readZipEntry(buffer, sharedEntry, "xl/sharedStrings.xml").toString("utf8")
      )
    : [];
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort(numericSort);
  if (sheets.length === 0) throw new Error("XLSX contains no worksheet XML");
  const selected = selectedZipText(buffer, entries, sheets, limits);
  return selected.map(({ name, text }, sheetIndex) => {
    const rows = [];
    for (const rowMatch of text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/giu)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(
        /<c\b([^>]*)>([\s\S]*?)<\/c>/giu
      )) {
        const attributes = cellMatch[1];
        const body = cellMatch[2];
        const reference = /\br="([^"]+)"/iu.exec(attributes)?.[1] ?? "?";
        const type = /\bt="([^"]+)"/iu.exec(attributes)?.[1] ?? null;
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/iu.exec(body)?.[1] ?? null;
        let value = /<v\b[^>]*>([\s\S]*?)<\/v>/iu.exec(body)?.[1] ?? "";
        if (type === "s" && /^\d+$/u.test(value)) {
          value = shared[Number(value)] ?? `[missing shared string ${value}]`;
        } else if (type === "inlineStr") {
          value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)]
            .map((item) => decodeEntities(item[1]))
            .join("");
        } else {
          value = decodeEntities(value);
        }
        cells.push(
          `${reference}=${JSON.stringify(value)}${formula ? `; formula=${JSON.stringify(decodeEntities(formula))}` : ""}`
        );
      }
      if (cells.length > 0) rows.push(cells.join("\t"));
    }
    return `## Sheet ${sheetIndex + 1} (${name})\n\n${rows.join("\n")}`;
  }).join("\n\n");
}

function extractOdt(buffer, entries, limits) {
  const parts = selectedZipText(buffer, entries, ["content.xml"], limits);
  if (parts.length === 0) throw new Error("ODT content.xml is absent");
  return xmlText(parts[0].text);
}

function extractRtf(buffer) {
  const source = buffer.toString("latin1");
  if (!source.startsWith("{\\rtf")) throw new Error("RTF signature is absent");
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" || character === "}") continue;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const next = source[index + 1];
    if (["\\", "{", "}"].includes(next)) {
      result += next;
      index += 1;
      continue;
    }
    const hex = /^\\'([0-9a-f]{2})/iu.exec(source.slice(index));
    if (hex) {
      result += Buffer.from([Number.parseInt(hex[1], 16)]).toString("latin1");
      index += hex[0].length - 1;
      continue;
    }
    const control = /^\\([a-z]+)(-?\d+)? ?/iu.exec(source.slice(index));
    if (control) {
      if (["par", "line"].includes(control[1].toLowerCase())) result += "\n";
      else if (control[1].toLowerCase() === "tab") result += "\t";
      else if (control[1].toLowerCase() === "u" && control[2]) {
        let point = Number(control[2]);
        if (point < 0) point += 65_536;
        result += String.fromCodePoint(point);
      }
      index += control[0].length - 1;
    }
  }
  return result.replace(/\n{3,}/gu, "\n\n").trim();
}

function decodePdfLiteral(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      output += value[index];
      continue;
    }
    const next = value[++index];
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    if (escapes[next]) output += escapes[next];
    else if (/[0-7]/u.test(next ?? "")) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? "")) {
        octal += value[++index];
      }
      output += String.fromCodePoint(Number.parseInt(octal, 8));
    } else if (next === "\n") {
      // Escaped line continuation.
    } else output += next ?? "";
  }
  return output;
}

function pdfStrings(content) {
  const values = [];
  for (const match of content.matchAll(/\((?:\\.|[^\\()])*\)/gsu)) {
    values.push(decodePdfLiteral(match[0].slice(1, -1)));
  }
  for (const match of content.matchAll(/<([0-9a-f\s]+)>/giu)) {
    const compact = match[1].replace(/\s/gu, "");
    if (compact.length < 2 || compact.length % 2 !== 0) continue;
    const bytes = Buffer.from(compact, "hex");
    values.push(
      bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff
        ? bytes.subarray(2).swap16().toString("utf16le")
        : bytes.toString("latin1")
    );
  }
  return values
    .map((value) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ""))
    .filter((value) => /[\p{L}\p{N}]/u.test(value))
    .join("\n");
}

function extractPdf(buffer, limits) {
  const source = buffer.toString("latin1");
  if (!source.startsWith("%PDF-")) throw new Error("PDF signature is absent");
  if (/\/Encrypt\b/u.test(source)) {
    return {
      status: "unsupported",
      text: "",
      limitations: ["encrypted PDF requires an explicitly approved safe conversion"]
    };
  }
  const parts = [pdfStrings(source)];
  for (const match of source.matchAll(
    /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu
  )) {
    const dictionary = match[1];
    const compressed = Buffer.from(match[2], "latin1");
    let decoded = compressed;
    if (/\/FlateDecode\b/u.test(dictionary)) {
      if (compressed.length > limits.entryBytes) continue;
      try {
        decoded = inflateSync(compressed, {
          maxOutputLength: limits.entryBytes
        });
      } catch {
        continue;
      }
    } else if (/\/Filter\b/u.test(dictionary)) {
      continue;
    }
    parts.push(pdfStrings(decoded.toString("latin1")));
  }
  const text = parts.filter(Boolean).join("\n").trim();
  return text.length > 0
    ? {
        status: "partial",
        text,
        limitations: [
          "bounded PDF extraction may omit custom-font, image-only, or unsupported-filter text"
        ]
      }
    : {
        status: "unsupported",
        text: "",
        limitations: [
          "no safely decodable text was found; the PDF may be image-only or use unsupported encodings"
        ]
      };
}

export async function extractDocumentRepresentation(filePath, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const bytes = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const format = ZIP_FORMATS.get(extension) ?? (extension.slice(1) || "unknown");
  if (bytes.length > limits.inputBytes) {
    return {
      schema: "assistant.document-extraction/v1",
      format,
      status: "limit_exceeded",
      representation: "none",
      text: "",
      limitations: [`input exceeds ${limits.inputBytes} bytes`]
    };
  }
  if (LEGACY_BINARY.has(extension)) {
    return {
      schema: "assistant.document-extraction/v1",
      format,
      status: "unsupported",
      representation: "metadata_only",
      text: "",
      limitations: [
        "legacy Office binary formats are not opened or automated; safe conversion is required"
      ]
    };
  }
  try {
    let extracted;
    if (ZIP_FORMATS.has(extension)) {
      const entries = parseZip(bytes, limits);
      if (extension === ".docx") extracted = extractDocx(bytes, entries, limits);
      else if (extension === ".pptx") extracted = extractPptx(bytes, entries, limits);
      else if (extension === ".xlsx") extracted = extractXlsx(bytes, entries, limits);
      else extracted = extractOdt(bytes, entries, limits);
    } else if (extension === ".rtf") {
      extracted = extractRtf(bytes);
    } else if (extension === ".pdf") {
      const pdf = extractPdf(bytes, limits);
      const bounded = boundedText(pdf.text, limits.outputBytes);
      return {
        schema: "assistant.document-extraction/v1",
        format,
        status: bounded.truncated ? "partial" : pdf.status,
        representation: "bounded_safe_text",
        text: bounded.text,
        limitations: [
          ...pdf.limitations,
          ...(bounded.truncated ? ["extracted text was truncated by output limit"] : [])
        ]
      };
    } else {
      throw new Error(`unsupported document extension ${extension || "(none)"}`);
    }
    const bounded = boundedText(extracted, limits.outputBytes);
    return {
      schema: "assistant.document-extraction/v1",
      format,
      status: bounded.truncated ? "partial" : "extracted",
      representation: "bounded_safe_text",
      text: bounded.text,
      limitations: bounded.truncated
        ? ["extracted text was truncated by output limit"]
        : []
    };
  } catch (error) {
    return {
      schema: "assistant.document-extraction/v1",
      format,
      status: /limit|expansion/iu.test(error.message)
        ? "limit_exceeded"
        : "unsupported",
      representation: "metadata_only",
      text: "",
      limitations: [error.message]
    };
  }
}

export const DOCUMENT_EXTENSIONS = Object.freeze(
  new Set([
    ".doc",
    ".docx",
    ".odt",
    ".pdf",
    ".ppt",
    ".pptx",
    ".rtf",
    ".xls",
    ".xlsx"
  ])
);
