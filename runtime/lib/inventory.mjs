import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { listFilesRecursive } from "./files.mjs";

const GENERATED_SEGMENTS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  "target",
  "submodules"
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".odt",
  ".txt",
  ".rst",
  ".rtf",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx"
]);

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".lua", ".m", ".mjs", ".php", ".ps1",
  ".py", ".r", ".rb", ".rs", ".scala", ".sh", ".sql", ".swift", ".ts",
  ".tsx", ".vue"
]);

const CONFIG_EXTENSIONS = new Set([
  ".cfg", ".conf", ".ini", ".json", ".properties", ".toml", ".xml", ".yaml", ".yml"
]);

const DATA_EXTENSIONS = new Set([
  ".arrow", ".csv", ".feather", ".h5", ".hdf5", ".jsonl", ".npy", ".npz",
  ".parquet", ".sav", ".tsv"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z", ".bin", ".bmp", ".dll", ".dylib", ".exe", ".gif", ".gz", ".ico",
  ".jar", ".jpeg", ".jpg", ".mp3", ".mp4", ".mov", ".png", ".so", ".tar",
  ".tif", ".tiff", ".wav", ".webp", ".zip"
]);

function classify(relative, kind) {
  const normalized = relative.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  const name = segments.at(-1);
  const extension = path.extname(name);

  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return "generated_or_dependency";
  }
  if (kind !== "file") return kind;
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.includes("credential") ||
    name.includes("secret") ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  ) {
    return "secret_candidate";
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (CONFIG_EXTENSIONS.has(extension)) return "config";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  return "unknown_file";
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function inventoryProject(target, options = {}) {
  const root = path.resolve(target);
  const hashLimitBytes = options.hashLimitBytes ?? 16 * 1024 * 1024;
  const entries = await listFilesRecursive(root, {
    exclude: (relative) =>
      relative === ".assistant" ||
      relative.startsWith(".assistant/") ||
      relative === ".assistant-install-staging" ||
      relative.startsWith(".assistant-install-staging/"),
    prune: (relative) =>
      relative
        .toLowerCase()
        .split("/")
        .some((segment) => GENERATED_SEGMENTS.has(segment))
  });

  const records = [];
  const counts = {};
  let totalBytes = 0;
  let unhashedBytes = 0;

  for (const entry of entries) {
    const category = classify(entry.path, entry.kind);
    counts[category] = (counts[category] ?? 0) + 1;
    const record = { ...entry, category };
    if (entry.kind === "file") {
      totalBytes += entry.size;
      if (entry.size <= hashLimitBytes) {
        record.sha256 = await hashFile(path.join(root, ...entry.path.split("/")));
      } else {
        record.sha256 = null;
        record.hash_omitted_reason = "preflight_size_limit";
        unhashedBytes += entry.size;
      }
    }
    records.push(record);
  }

  return {
    schema: "assistant.inventory/v1",
    root,
    generated_at: new Date().toISOString(),
    representation: {
      hash_limit_bytes: hashLimitBytes,
      links_followed: false
    },
    summary: {
      paths: records.length,
      files: records.filter((entry) => entry.kind === "file").length,
      total_bytes: totalBytes,
      unhashed_bytes: unhashedBytes,
      categories: counts
    },
    entries: records
  };
}
