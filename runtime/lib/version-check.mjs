import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.mjs";
import { resolvePolicy } from "./policy.mjs";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function versionParts(version) {
  const match = String(version ?? "").match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u
  );
  if (!match) return null;
  return {
    numeric: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? null
  };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numeric[index] !== b.numeric[index]) {
      return a.numeric[index] < b.numeric[index] ? -1 : 1;
    }
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en");
}

export async function checkAvailableUpdate(target, options = {}) {
  if (process.env.ASSISTANT_DISABLE_UPDATE_CHECK === "1") return null;
  const root = path.resolve(target);
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const policyPath = path.join(root, ".assistant", "POLICY.md");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const policy = resolvePolicy(
    await readFile(policyPath, "utf8"),
    "update_check",
    null,
    { profile: manifest.profile }
  );
  if (policy.effective === "disabled") return null;
  const origin = manifest.update_origin;
  if (typeof origin !== "string" || !origin.startsWith("https://")) return null;

  const cachePath = path.join(
    root,
    ".assistant",
    "internal",
    "update-check.json"
  );
  let cache = null;
  if (await pathExists(cachePath)) {
    try {
      cache = JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      cache = null;
    }
  }
  const now = options.now ?? Date.now();
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fresh = cache?.checked_at &&
    now - Date.parse(cache.checked_at) < interval;
  if (!fresh) {
    cache = {
      schema: "assistant.update-check/v1",
      checked_at: new Date(now).toISOString(),
      current_version: manifest.system_version,
      available_version: null,
      notified_version: cache?.notified_version ?? null
    };
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(origin, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "assistant-version-check"
        },
        signal: options.signal ?? AbortSignal.timeout(1500)
      });
      if (response.ok) {
        const release = await response.json();
        const candidate = release.tag_name ?? release.name;
        if (compareVersions(manifest.system_version, candidate) === -1) {
          cache.available_version = candidate;
          cache.release_url = release.html_url ?? null;
        }
      }
    } catch {
      // Offline, timeout, and remote errors never block project or assistant work.
    }
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  }
  if (
    !cache?.available_version ||
    cache.notified_version === cache.available_version
  ) return null;
  cache.notified_version = cache.available_version;
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return {
    available_version: cache.available_version,
    current_version: manifest.system_version,
    release_url: cache.release_url ?? null
  };
}
