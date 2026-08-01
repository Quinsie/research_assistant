import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.mjs";

function deferredPath(root) {
  return path.join(
    path.resolve(root),
    ".assistant",
    "internal",
    "bootstrap",
    "deferred-request.json"
  );
}
export async function inspectDeferredRequest(target) {
  const location = deferredPath(target);
  if (!(await pathExists(location))) {
    return {
      schema: "assistant.deferred-request-result/v1",
      status: "none"
    };
  }
  return JSON.parse(await readFile(location, "utf8"));
}

export async function claimDeferredRequest(target) {
  const location = deferredPath(target);
  const record = await inspectDeferredRequest(target);
  if (!["pending", "in_progress"].includes(record.status)) {
    throw new Error(`deferred request cannot be claimed from ${record.status}`);
  }
  if (record.status === "pending") {
    record.status = "in_progress";
    record.claimed_at = new Date().toISOString();
    await writeFile(location, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
  return record;
}

export async function completeDeferredRequest(target) {
  const location = deferredPath(target);
  const record = await inspectDeferredRequest(target);
  if (record.status !== "in_progress") {
    throw new Error(`deferred request cannot complete from ${record.status}`);
  }
  record.status = "completed";
  record.completed_at = new Date().toISOString();
  delete record.prompt;
  await writeFile(location, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return record;
}
