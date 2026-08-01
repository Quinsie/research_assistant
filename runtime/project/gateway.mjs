import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  assertGrantedPath,
  fileFacts,
  isInside,
  loadGrant,
  normalizeProjectRoot,
  sha256,
  zoneForPath
} from "./restricted-common.mjs";

const projectRoot = normalizeProjectRoot(process.cwd());
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_INVENTORY_ENTRIES = 10_000;

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function tool(name, description, properties, required = [], readOnly = false) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: false
    }
  };
}

const grantProperties = {
  grant_token: { type: "string", description: "Token supplied by the current prompt hook." },
  path: { type: "string", description: "Exact absolute or project-relative path." }
};

const TOOLS = [
  tool("source_preflight", "Inspect metadata for an exact granted source path without reading content.", grantProperties, ["grant_token", "path"], true),
  tool("source_read_file", "Read one text file inside an exact granted source boundary.", grantProperties, ["grant_token", "path"], true),
  tool("source_inventory_directory", "Inventory an exact granted source directory recursively without reading content.", grantProperties, ["grant_token", "path"], true),
  tool("source_snapshot", "Preserve one granted source file in the immutable assistant vault.", grantProperties, ["grant_token", "path"]),
  tool("report_write_new", "Create a new non-authoritative report without overwrite.", {
    grant_token: {
      type: "string",
      description: "Required for requested reports; omitted for a validated terminal event."
    },
    relative_path: { type: "string" },
    content: { type: "string" },
    work_id: { type: "string" },
    episode_id: { type: "string" },
    report_kind: { type: "string", enum: ["terminal", "requested"] }
  }, ["relative_path", "content", "work_id", "report_kind"]),
  tool("report_read_exact", "Read one exact report named in the current prompt.", grantProperties, ["grant_token", "path"], true),
  tool("report_edit_exact", "Replace one exact report named for editing in the current prompt.", {
    ...grantProperties,
    content: { type: "string" }
  }, ["grant_token", "path", "content"]),
  tool("vault_verify", "Verify a vault object by SHA-256 without returning bytes.", {
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
  }, ["sha256"], true)
];

async function audit(operation, details) {
  const logPath = path.join(projectRoot, ".assistant", "internal", "restricted", "access.jsonl");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({
    schema: "assistant.restricted-access/v1",
    access_id: `ACC-${randomUUID()}`,
    operation,
    at: new Date().toISOString(),
    ...details
  })}\n`, "utf8");
}

async function authorizeGrant(args, operation) {
  const grant = await loadGrant(projectRoot, args.grant_token, operation);
  const candidate = path.isAbsolute(args.path)
    ? args.path
    : path.resolve(projectRoot, args.path);
  const absolute = await assertGrantedPath(projectRoot, grant, candidate);
  return { grant, absolute };
}

async function readGrantedFile(args, operation) {
  const { grant, absolute } = await authorizeGrant(args, operation);
  const facts = await fileFacts(absolute);
  if (!facts.is_file) throw new Error("requested path is not a file");
  if (facts.bytes > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES} byte gate`);
  const bytes = await readFile(absolute);
  if (bytes.includes(0)) throw new Error("binary file content is not returned as text");
  await audit(operation, {
    grant_id: grant.grant_id,
    path: absolute,
    bytes: bytes.length,
    sha256: sha256(bytes)
  });
  return { grant, absolute, bytes, content: bytes.toString("utf8") };
}

async function sourcePreflight(args) {
  const { grant, absolute } = await authorizeGrant(args, "source_preflight");
  const facts = await fileFacts(absolute);
  await audit("source_preflight", { grant_id: grant.grant_id, path: absolute });
  return textResult({
    path: absolute,
    boundary_kind: grant.boundary_kind,
    ...facts,
    readable_as_text: facts.is_file && facts.bytes <= MAX_READ_BYTES
  });
}

async function sourceReadFile(args) {
  const read = await readGrantedFile(args, "source_read_file");
  return textResult({
    path: read.absolute,
    bytes: read.bytes.length,
    sha256: sha256(read.bytes),
    content: read.content
  });
}

async function sourceInventoryDirectory(args) {
  const { grant, absolute } = await authorizeGrant(args, "source_inventory_directory");
  const facts = await fileFacts(absolute);
  if (!facts.is_directory) throw new Error("requested path is not a directory");
  const rootReal = await realpath(absolute);
  const entries = [];
  async function visit(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      if (entries.length >= MAX_INVENTORY_ENTRIES) {
        throw new Error(`directory exceeds ${MAX_INVENTORY_ENTRIES} entry gate`);
      }
      const candidate = path.join(current, child.name);
      const childReal = await realpath(candidate);
      if (!isInside(rootReal, childReal)) {
        throw new Error("directory contains a link that escapes the granted boundary");
      }
      const info = await stat(candidate);
      entries.push({
        path: path.relative(absolute, candidate).replaceAll(path.sep, "/"),
        kind: child.isDirectory() ? "directory" : child.isFile() ? "file" : "other",
        bytes: child.isFile() ? info.size : null
      });
      if (child.isDirectory()) await visit(candidate);
    }
  }
  await visit(absolute);
  await audit("source_inventory_directory", {
    grant_id: grant.grant_id,
    path: absolute,
    entries: entries.length
  });
  return textResult({ path: absolute, entries });
}

async function sourceSnapshot(args) {
  const { grant, absolute } = await authorizeGrant(args, "source_snapshot");
  const facts = await fileFacts(absolute);
  if (!facts.is_file) throw new Error("snapshot target is not a file");
  if (facts.bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`file exceeds ${MAX_SNAPSHOT_BYTES} byte snapshot gate`);
  }
  const bytes = await readFile(absolute);
  const digest = sha256(bytes);
  const objectPath = path.join(
    projectRoot,
    ".assistant",
    "vault",
    "sha256",
    digest.slice(0, 2),
    digest
  );
  await mkdir(path.dirname(objectPath), { recursive: true });
  try {
    await writeFile(objectPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (sha256(await readFile(objectPath)) !== digest) throw new Error("vault identity collision");
  }
  await audit("source_snapshot", {
    grant_id: grant.grant_id,
    path: absolute,
    bytes: bytes.length,
    sha256: digest
  });
  return textResult({ identity: `snapshot:sha256:${digest}`, bytes: bytes.length });
}

function terminalReportAllowed(policyText) {
  return /"side_effects"\s*:\s*\[\s*"report_write"\s*\][\s\S]*?"value"\s*:\s*"automatic_on_terminal_event"/u.test(policyText);
}

async function terminalEvent(workId, episodeId) {
  if (!episodeId) throw new Error("terminal report requires episode_id");
  const ledgerPath = path.join(
    projectRoot,
    ".assistant",
    "internal",
    "work",
    "terminal-events.jsonl"
  );
  const records = (await readFile(ledgerPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(JSON.parse);
  const authorized = records.find(
    (item) =>
      item.event === "authorized" &&
      item.work_id === workId &&
      item.episode_id === episodeId
  );
  if (!authorized) throw new Error("terminal episode is not authorized");
  const reported = records.find(
    (item) =>
      item.event === "reported" &&
      item.work_id === workId &&
      item.episode_id === episodeId
  );
  return { ledgerPath, reported };
}

async function reportWriteNew(args) {
  const reportRoot = path.resolve(projectRoot, "docs", "report");
  const destination = path.resolve(reportRoot, args.relative_path);
  if (!isInside(reportRoot, destination) || destination === reportRoot) {
    throw new Error("report path escapes docs/report");
  }
  if (!destination.toLowerCase().endsWith(".md")) throw new Error("new reports must use .md");
  const content = Buffer.from(args.content, "utf8");
  if (content.length > MAX_REPORT_BYTES) throw new Error("report exceeds size gate");
  const policyText = await readFile(path.join(projectRoot, ".assistant", "POLICY.md"), "utf8");
  let terminal = null;
  if (args.report_kind === "terminal" && !terminalReportAllowed(policyText)) {
    throw new Error("project policy does not allow automatic terminal reports");
  }
  if (args.report_kind === "terminal") {
    terminal = await terminalEvent(args.work_id, args.episode_id);
  }
  let grant = null;
  if (args.report_kind === "requested") {
    grant = await loadGrant(projectRoot, args.grant_token, "report_write_new");
    if (grant.zone !== "report") {
      throw new Error("prompt grant does not authorize report creation");
    }
  }
  const relativeDestination = path
    .relative(projectRoot, destination)
    .replaceAll(path.sep, "/");
  if (
    terminal?.reported &&
    (terminal.reported.report_sha256 !== sha256(content) ||
      terminal.reported.report_path !== relativeDestination)
  ) {
    throw new Error("terminal episode already has a different report");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  let idempotent = false;
  try {
    await writeFile(destination, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (sha256(existing) !== sha256(content)) throw error;
    idempotent = true;
  }
  if (terminal && !terminal.reported) {
    await appendFile(
      terminal.ledgerPath,
      `${JSON.stringify({
        schema: "assistant.terminal-event/v1",
        event: "reported",
        work_id: args.work_id,
        episode_id: args.episode_id,
        report_path: relativeDestination,
        report_sha256: sha256(content),
        reported_at: new Date().toISOString()
      })}\n`,
      "utf8"
    );
  }
  await audit("report_write_new", {
    path: destination,
    work_id: args.work_id,
    report_kind: args.report_kind,
    grant_id: grant?.grant_id ?? null,
    bytes: content.length,
    sha256: sha256(content)
  });
  return textResult({
    path: destination,
    bytes: content.length,
    sha256: sha256(content),
    idempotent
  });
}

async function reportReadExact(args) {
  const read = await readGrantedFile(args, "report_read_exact");
  return textResult({
    path: read.absolute,
    bytes: read.bytes.length,
    sha256: sha256(read.bytes),
    content: read.content
  });
}

async function reportEditExact(args) {
  const { grant, absolute } = await authorizeGrant(args, "report_edit_exact");
  if (zoneForPath(projectRoot, absolute)?.kind !== "report") {
    throw new Error("report edit target is not a report");
  }
  const content = Buffer.from(args.content, "utf8");
  if (content.length > MAX_REPORT_BYTES) throw new Error("report exceeds size gate");
  const before = await readFile(absolute);
  await writeFile(absolute, content);
  await audit("report_edit_exact", {
    grant_id: grant.grant_id,
    path: absolute,
    before_sha256: sha256(before),
    after_sha256: sha256(content)
  });
  return textResult({
    path: absolute,
    before_sha256: sha256(before),
    after_sha256: sha256(content)
  });
}

async function vaultVerify(args) {
  const objectPath = path.join(
    projectRoot,
    ".assistant",
    "vault",
    "sha256",
    args.sha256.slice(0, 2),
    args.sha256
  );
  const bytes = await readFile(objectPath);
  const verified = sha256(bytes) === args.sha256;
  await audit("vault_verify", { sha256: args.sha256, bytes: bytes.length, verified });
  return textResult({ sha256: args.sha256, bytes: bytes.length, verified });
}

const HANDLERS = {
  source_preflight: sourcePreflight,
  source_read_file: sourceReadFile,
  source_inventory_directory: sourceInventoryDirectory,
  source_snapshot: sourceSnapshot,
  report_write_new: reportWriteNew,
  report_read_exact: reportReadExact,
  report_edit_exact: reportEditExact,
  vault_verify: vaultVerify
};

async function respond(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "assistant-restricted", version: "0.1.0-dev" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "tools/call") {
    const handler = HANDLERS[request.params?.name];
    if (!handler) throw new Error(`unknown tool ${request.params?.name}`);
    return handler(request.params.arguments || {});
  }
  if (request.method?.startsWith("notifications/")) return undefined;
  throw new Error(`unsupported method ${request.method}`);
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
      const result = await respond(request);
      if (request.id !== undefined && result !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    } catch (error) {
      if (request?.id !== undefined) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: error.message }
        })}\n`);
      }
    }
  }
});
