import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.mjs";

export const WINDOWS_RESTRICTED_CANARY =
  ".assistant/internal/restricted/direct-deny-canary.txt";

const STANDARD_RESTRICTED_BOUNDARIES = Object.freeze([
  { relative: "docs", boundary_kind: "directory" },
  { relative: ".assistant/vault", boundary_kind: "directory" },
  {
    relative: ".assistant/internal/restricted",
    boundary_kind: "directory"
  }
]);

let sandboxGroupSidPromise;

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isSandboxIdentityLine(line, sid) {
  const normalized = line.toLowerCase();
  return (
    normalized.includes(`${sid.toLowerCase()}:`) ||
    normalized.includes("codexsandboxusers:")
  );
}

function deniesRead(line) {
  return (
    line.toUpperCase().includes("(DENY)") &&
    /\((?:F|M|RX|R)\)/iu.test(line)
  );
}

export function resolveCodexSandboxGroupSid() {
  if (process.platform !== "win32") return Promise.resolve(null);
  sandboxGroupSidPromise ??= (async () => {
    const script =
      "[System.Security.Principal.NTAccount]::new("
      + "$env:COMPUTERNAME, 'CodexSandboxUsers').Translate("
      + "[System.Security.Principal.SecurityIdentifier]).Value";
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      process.cwd()
    );
    const sid = result.stdout.trim();
    if (
      result.code !== 0 ||
      !/^S-\d+(?:-\d+)+$/u.test(sid)
    ) {
      throw new Error(
        "Codex elevated Windows sandbox group is unavailable; "
        + "complete elevated sandbox setup before installing restricted zones"
      );
    }
    return sid;
  })();
  return sandboxGroupSidPromise;
}

async function denySandboxRead(root, boundary, sid) {
  const absolute = path.resolve(root, ...boundary.relative.split("/"));
  if (!inside(root, absolute)) {
    throw new Error(`restricted ACL boundary escaped project: ${boundary.relative}`);
  }
  if (!(await pathExists(absolute))) {
    throw new Error(`restricted ACL boundary is missing: ${boundary.relative}`);
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    throw new Error(
      `restricted ACL boundary cannot be a symbolic link: ${boundary.relative}`
    );
  }
  const directory =
    boundary.boundary_kind === "directory" || info.isDirectory();
  const prior = await run("icacls.exe", [absolute], root);
  if (prior.code !== 0) {
    throw new Error(`failed to inspect restricted ACL: ${boundary.relative}`);
  }
  const denyLines = prior.stdout
    .split(/\r?\n/u)
    .filter((line) =>
      isSandboxIdentityLine(line, sid) &&
      line.toUpperCase().includes("(DENY)")
    );
  if (denyLines.length > 0) {
    const alreadyDenied = denyLines.some(deniesRead);
    if (!alreadyDenied) {
      throw new Error(
        `pre-existing sandbox deny ACL requires review: ${boundary.relative}`
      );
    }
    return {
      relative: boundary.relative,
      boundary_kind: directory ? "directory" : "file",
      acl_origin: "preexisting"
    };
  }
  const access = directory ? `*${sid}:(OI)(CI)(R)` : `*${sid}:(R)`;
  const result = await run("icacls.exe", [absolute, "/deny", access], root);
  if (result.code !== 0) {
    throw new Error(
      `failed to deny Codex sandbox read for ${boundary.relative}: `
      + (result.stderr || result.stdout).trim()
    );
  }
  return {
    relative: boundary.relative,
    boundary_kind: directory ? "directory" : "file",
    acl_origin: "assistant"
  };
}

export async function enforceWindowsRestrictedAcls(
  target,
  dynamicBoundaries = []
) {
  const root = path.resolve(target);
  const canaryPath = path.join(root, ...WINDOWS_RESTRICTED_CANARY.split("/"));
  await mkdir(path.dirname(canaryPath), { recursive: true });
  await writeFile(
    canaryPath,
    "assistant restricted read denial canary\n",
    "utf8"
  );
  if (process.platform !== "win32") {
    return {
      schema: "assistant.windows-restricted-acl/v1",
      status: "not_applicable",
      boundaries: []
    };
  }
  const sid = await resolveCodexSandboxGroupSid();
  const combined = [
    ...STANDARD_RESTRICTED_BOUNDARIES,
    ...dynamicBoundaries
  ];
  const unique = new Map();
  for (const boundary of combined) {
    if (!boundary?.relative) continue;
    unique.set(boundary.relative.replaceAll("\\", "/"), {
      relative: boundary.relative.replaceAll("\\", "/"),
      boundary_kind: boundary.boundary_kind
    });
  }
  const applied = [];
  try {
    for (const boundary of unique.values()) {
      applied.push(await denySandboxRead(root, boundary, sid));
    }
  } catch (error) {
    for (const boundary of applied.reverse()) {
      if (boundary.acl_origin !== "assistant") continue;
      const absolute = path.resolve(root, ...boundary.relative.split("/"));
      await run("icacls.exe", [absolute, "/remove:d", `*${sid}`], root);
    }
    throw error;
  }
  const ledgerPath = path.join(
    root,
    ".assistant",
    "internal",
    "restricted",
    "windows-acl.json"
  );
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      schema: "assistant.windows-restricted-acl/v1",
      status: "enforced",
      sandbox_group_sid: sid,
      boundaries: applied,
      rollback:
        "remove this SID's deny ACE only where acl_origin is assistant",
      applied_at: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
  return JSON.parse(await readFile(ledgerPath, "utf8"));
}

export async function inspectWindowsRestrictedAcls(target) {
  if (process.platform !== "win32") {
    return { status: "not_applicable", findings: [] };
  }
  const root = path.resolve(target);
  const ledgerPath = path.join(
    root,
    ".assistant",
    "internal",
    "restricted",
    "windows-acl.json"
  );
  if (!(await pathExists(ledgerPath))) {
    return { status: "missing", findings: ["windows ACL ledger is missing"] };
  }
  let ledger;
  try {
    ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch {
    return { status: "invalid", findings: ["windows ACL ledger is invalid"] };
  }
  const findings = [];
  if (
    ledger.schema !== "assistant.windows-restricted-acl/v1" ||
    ledger.status !== "enforced" ||
    !/^S-\d+(?:-\d+)+$/u.test(ledger.sandbox_group_sid ?? "") ||
    !Array.isArray(ledger.boundaries)
  ) {
    findings.push("windows ACL ledger contract is invalid");
  } else {
    for (const boundary of ledger.boundaries) {
      const absolute = path.resolve(root, ...boundary.relative.split("/"));
      if (!inside(root, absolute) || !(await pathExists(absolute))) {
        findings.push(`restricted ACL boundary is missing: ${boundary.relative}`);
        continue;
      }
      const result = await run("icacls.exe", [absolute], root);
      if (
        result.code !== 0 ||
        !result.stdout
          .split(/\r?\n/u)
          .some((line) =>
            isSandboxIdentityLine(line, ledger.sandbox_group_sid) &&
            deniesRead(line)
          )
      ) {
        findings.push(`sandbox read deny ACL is missing: ${boundary.relative}`);
      }
    }
  }
  const canary = path.join(root, ...WINDOWS_RESTRICTED_CANARY.split("/"));
  if (!(await pathExists(canary))) {
    findings.push("restricted direct-deny canary is missing");
  }
  return {
    status: findings.length === 0 ? "enforced" : "invalid",
    sandbox_group_sid: ledger.sandbox_group_sid ?? null,
    boundaries: ledger.boundaries ?? [],
    findings
  };
}

export async function rollbackWindowsRestrictedAcls(target) {
  const root = path.resolve(target);
  if (process.platform !== "win32") {
    return { status: "not_applicable", removed: [] };
  }
  const ledgerPath = path.join(
    root,
    ".assistant",
    "internal",
    "restricted",
    "windows-acl.json"
  );
  if (!(await pathExists(ledgerPath))) {
    return { status: "not_present", removed: [] };
  }
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const sid = ledger.sandbox_group_sid;
  if (!/^S-\d+(?:-\d+)+$/u.test(sid ?? "")) {
    throw new Error("cannot roll back invalid Windows ACL ledger");
  }
  const removed = [];
  for (const boundary of ledger.boundaries ?? []) {
    if (boundary.acl_origin !== "assistant") continue;
    const absolute = path.resolve(root, ...boundary.relative.split("/"));
    if (!inside(root, absolute) || !(await pathExists(absolute))) continue;
    const result = await run("icacls.exe", [absolute, "/remove:d", `*${sid}`], root);
    if (result.code !== 0) {
      throw new Error(
        `failed to remove assistant ACL for ${boundary.relative}: `
        + (result.stderr || result.stdout).trim()
      );
    }
    removed.push(boundary.relative);
  }
  return { status: "rolled_back", sandbox_group_sid: sid, removed };
}
