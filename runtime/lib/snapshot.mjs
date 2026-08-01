import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeUtf8 } from "./files.mjs";

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isBootstrapRestrictedPath(relative) {
  const normalized = relative.replaceAll("\\", "/");
  return (
    normalized === "docs" ||
    normalized.startsWith("docs/") ||
    normalized.startsWith(".assistant/vault/intake/")
  );
}

export async function snapshotBootstrapRestrictedInputs(target, inventory) {
  const root = path.resolve(target);
  const records = [];
  const perFileLimit = 64 * 1024 * 1024;
  const totalLimit = 256 * 1024 * 1024;
  let copiedBytes = 0;
  for (const entry of inventory.entries) {
    if (entry.kind !== "file" || !isBootstrapRestrictedPath(entry.path)) {
      continue;
    }
    const source = path.join(root, ...entry.path.split("/"));
    const hash = entry.sha256 ?? await hashFile(source);
    const snapshotId = `snapshot:sha256:${hash}`;
    const explicitIntake = entry.path.startsWith(".assistant/vault/intake/");
    if (
      !explicitIntake &&
      (entry.size > perFileLimit || copiedBytes + entry.size > totalLimit)
    ) {
      records.push({
        original_path: entry.path,
        snapshot_id: null,
        sha256: hash,
        size: entry.size,
        status: "not_snapshotted",
        reason:
          entry.size > perFileLimit
            ? "per_file_snapshot_limit"
            : "total_snapshot_limit"
      });
      continue;
    }
    const destination = path.join(
      root,
      ".assistant",
      "vault",
      "sha256",
      hash.slice(0, 2),
      `${hash}.bin`
    );
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await pathExists(destination))) {
      await copyFile(source, destination);
    } else {
      const destinationInfo = await stat(destination);
      if (destinationInfo.size !== entry.size) {
        throw new Error(`snapshot collision or corruption for ${snapshotId}`);
      }
    }
    records.push({
      original_path: entry.path,
      snapshot_id: snapshotId,
      sha256: hash,
      size: entry.size,
      status: "preserved"
    });
    copiedBytes += entry.size;
  }

  const manifest = {
    schema: "assistant.bootstrap-restricted-snapshots/v1",
    created_at: new Date().toISOString(),
    records
  };
  await writeUtf8(
    path.join(
      root,
      ".assistant",
      "internal",
      "bootstrap",
      "restricted-snapshots.json"
    ),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}
