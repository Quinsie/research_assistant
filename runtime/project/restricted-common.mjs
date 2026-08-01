import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const GRANT_SCHEMA = "assistant.restricted-grant/v1";
export const LEDGER_RELATIVE = ".assistant/internal/restricted/grants.jsonl";
export const BOUNDARIES_RELATIVE =
  ".assistant/internal/restricted/boundaries.json";
export const RESTRICTED_ZONES = Object.freeze([
  { relative: "docs/report", kind: "report", boundary_kind: "directory" },
  { relative: "docs", kind: "document", boundary_kind: "directory" },
  { relative: ".assistant/vault", kind: "vault" }
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeProjectRoot(cwd) {
  return path.resolve(process.env.ASSISTANT_PROJECT_ROOT || cwd);
}

function configuredZones(projectRoot) {
  const registryPath = path.join(
    projectRoot,
    ...BOUNDARIES_RELATIVE.split("/")
  );
  if (!existsSync(registryPath)) return RESTRICTED_ZONES;
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    throw new Error(`restricted boundary registry is invalid: ${error.message}`);
  }
  if (
    registry.schema !== "assistant.restricted-boundaries/v1" ||
    !Array.isArray(registry.boundaries)
  ) {
    throw new Error("restricted boundary registry has an unsupported schema");
  }
  const dynamic = registry.boundaries.map((boundary) => {
    if (
      typeof boundary.relative !== "string" ||
      boundary.relative.length === 0 ||
      !["source", "document", "report", "vault"].includes(boundary.kind) ||
      !["file", "directory"].includes(boundary.boundary_kind)
    ) {
      throw new Error("restricted boundary registry contains an invalid entry");
    }
    const absolute = path.resolve(
      projectRoot,
      ...boundary.relative.replaceAll("\\", "/").split("/")
    );
    if (!isInside(projectRoot, absolute) || absolute === projectRoot) {
      throw new Error("restricted boundary registry escapes the project root");
    }
    return {
      relative: boundary.relative,
      kind: boundary.kind,
      boundary_kind: boundary.boundary_kind,
      dynamic: true
    };
  });
  return [...RESTRICTED_ZONES, ...dynamic];
}

export function zoneForPath(projectRoot, candidate) {
  const absolute = path.resolve(candidate);
  const zones = configuredZones(projectRoot)
    .map((zone) => ({
      ...zone,
      root: path.resolve(projectRoot, ...zone.relative.split("/"))
    }))
    .sort((left, right) => right.root.length - left.root.length);
  for (const zone of zones) {
    const matches =
      zone.boundary_kind === "file"
        ? zone.root === absolute
        : isInside(zone.root, absolute);
    if (matches) return { ...zone, absolute };
  }
  return null;
}

export async function resolveExistingBoundary(projectRoot, candidate) {
  const zone = zoneForPath(projectRoot, candidate);
  if (!zone) throw new Error("path is outside a restricted zone");
  const info = await lstat(zone.absolute);
  const boundaryReal = await realpath(zone.absolute);
  const zoneReal = await realpath(zone.root);
  if (!isInside(zoneReal, boundaryReal)) {
    throw new Error("restricted path escapes its zone through a link");
  }
  return {
    zone: zone.kind,
    boundary: zone.absolute,
    boundary_real: boundaryReal,
    boundary_kind: info.isDirectory() ? "directory" : "file"
  };
}

export function defaultOperations(zone, prompt) {
  if (zone === "source" || zone === "document") {
    return [
      "source_preflight",
      "source_read_file",
      "source_inventory_directory",
      "source_snapshot"
    ];
  }
  if (zone === "report") {
    return /(edit|modify|rewrite|revise|수정|편집|고쳐|변경)/iu.test(prompt)
      ? ["report_read_exact", "report_edit_exact"]
      : ["report_read_exact"];
  }
  return ["vault_verify"];
}

export async function appendGrant(projectRoot, input, boundary, operations = null) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const record = {
    schema: GRANT_SCHEMA,
    grant_id: `GRT-${randomBytes(8).toString("hex")}`,
    token_hash: sha256(token),
    session_id: String(input.session_id || ""),
    turn_id: String(input.turn_id || ""),
    prompt_hash: sha256(String(input.prompt || "")),
    boundary: boundary.boundary,
    boundary_real: boundary.boundary_real,
    boundary_kind: boundary.boundary_kind,
    zone: boundary.zone,
    operations: operations ?? defaultOperations(boundary.zone, String(input.prompt || "")),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
  };
  const ledger = path.join(projectRoot, ...LEDGER_RELATIVE.split("/"));
  await mkdir(path.dirname(ledger), { recursive: true });
  await appendFile(ledger, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return { token, record };
}

export async function loadGrant(projectRoot, token, operation) {
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("a valid prompt grant token is required");
  }
  const ledger = path.join(projectRoot, ...LEDGER_RELATIVE.split("/"));
  const lines = (await readFile(ledger, "utf8")).split(/\r?\n/u).filter(Boolean);
  const tokenHash = sha256(token);
  const record = lines
    .map((line) => JSON.parse(line))
    .reverse()
    .find((item) => item.token_hash === tokenHash);
  if (!record) throw new Error("prompt grant was not found");
  if (Date.parse(record.expires_at) <= Date.now()) throw new Error("prompt grant has expired");
  if (!record.operations.includes(operation)) {
    throw new Error(`prompt grant does not authorize ${operation}`);
  }
  return record;
}

export async function assertGrantedPath(projectRoot, grant, candidate) {
  const absolute = path.resolve(candidate);
  const zone = zoneForPath(projectRoot, absolute);
  if (!zone || zone.kind !== grant.zone) {
    throw new Error("requested path is outside the granted zone");
  }
  const resolved = await realpath(absolute);
  const allowed = grant.boundary_kind === "file"
    ? resolved === grant.boundary_real
    : isInside(grant.boundary_real, resolved);
  if (!allowed) throw new Error("requested path exceeds the exact prompt boundary");
  return absolute;
}

export async function fileFacts(filePath) {
  const info = await stat(filePath);
  return {
    bytes: info.size,
    modified_at: info.mtime.toISOString(),
    is_file: info.isFile(),
    is_directory: info.isDirectory()
  };
}
