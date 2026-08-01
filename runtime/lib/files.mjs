import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizeAbsolute(inputPath) {
  return path.resolve(inputPath);
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertInside(parent, child, label = "path") {
  const normalizedParent = normalizeAbsolute(parent);
  const normalizedChild = normalizeAbsolute(child);
  if (!isInside(normalizedParent, normalizedChild)) {
    throw new Error(`${label} escapes boundary: ${normalizedChild}`);
  }
  return normalizedChild;
}

export async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}

export async function writeUtf8(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function listFilesRecursive(root, options = {}) {
  const {
    exclude = () => false,
    followLinks = false,
    prune = () => false
  } = options;
  const output = [];

  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (exclude(relative, entry)) continue;
      if (entry.isSymbolicLink()) {
        output.push({ path: relative, kind: "link" });
        if (followLinks) {
          const resolved = await realpath(absolute);
          if (isInside(root, resolved)) await visit(resolved);
        }
      } else if (entry.isDirectory()) {
        output.push({ path: relative, kind: "directory" });
        if (!prune(relative, entry)) await visit(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        output.push({ path: relative, kind: "file", size: info.size });
      } else {
        output.push({ path: relative, kind: "other" });
      }
    }
  }

  await visit(root);
  return output;
}
