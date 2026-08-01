import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "./files.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";

export async function prepareBootstrapRetry(target, reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("bootstrap retry requires a durable reason");
  }
  const root = path.resolve(target);
  const bootstrapRoot = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap"
  );
  const statePath = path.join(bootstrapRoot, "state.json");
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const stateBefore = await readFile(statePath, "utf8");
  const manifestBefore = await readFile(manifestPath, "utf8");
  const currentBefore = await readFile(currentPath, "utf8");
  const state = JSON.parse(stateBefore);
  if (state.closed_book_validated === true) {
    throw new Error("cannot restart a closed-book validated bootstrap");
  }

  const attemptId = `ATT-${randomUUID()}`;
  const attemptRoot = path.join(bootstrapRoot, "attempts", attemptId);
  await mkdir(attemptRoot, { recursive: true });
  const moved = [];
  try {
    const executionPath = path.join(bootstrapRoot, "execution.json");
    if (await pathExists(executionPath)) {
      const execution = JSON.parse(await readFile(executionPath, "utf8"));
      const workspace = path.resolve(execution.workspace ?? "");
      const temporaryRoot = path.resolve(os.tmpdir());
      const relative = path.relative(temporaryRoot, workspace);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        path.basename(workspace).startsWith("assistant-bootstrap-model-")
      ) {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    for (const name of [
      "model-result.json",
      "run.json",
      "resolution.json",
      "staging",
      "selection.json",
      "execution.json",
      "discovery.json",
      "discovery-packet.txt",
      "evidence-packet.txt"
    ]) {
      const source = path.join(bootstrapRoot, name);
      if (!(await pathExists(source))) continue;
      const destination = path.join(attemptRoot, name);
      await rename(source, destination);
      moved.push({ source, destination });
    }
    await writeFile(
      path.join(attemptRoot, "attempt.json"),
      `${JSON.stringify({
        schema: "assistant.bootstrap-attempt/v1",
        id: attemptId,
        previous_status: state.status,
        reason: reason.trim(),
        archived_at: new Date().toISOString()
      }, null, 2)}\n`,
      "utf8"
    );

    state.phase = "bootstrapping";
    state.status = "bootstrap_incomplete";
    state.semantic_survey_complete = false;
    state.closed_book_validated = false;
    state.critical_gap_ids = [];
    state.material_conflict_ids = [];
    state.retry_of = attemptId;
    state.updated_at = new Date().toISOString();
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const manifest = JSON.parse(manifestBefore);
    manifest.initialization_status = "bootstrap_incomplete";
    manifest.activity_status = "paused";
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const current = parseNodeDocument(currentBefore, currentPath);
    current.metadata.initialization_status = "bootstrap_incomplete";
    current.metadata.activity_status = "paused";
    current.metadata.active_work_id = "BOOTSTRAP-EXISTING";
    current.metadata.authorization = "active";
    current.metadata.verified_at = new Date().toISOString();
    await writeFile(
      currentPath,
      serializeNodeDocument(
        current.metadata,
        `# Current state

- Initialization: \`bootstrap_incomplete\`
- Activity: \`paused\`
- Active work: \`BOOTSTRAP-EXISTING\`
- Current authorization: semantic bootstrap retry only
- Archived attempt: \`${attemptId}\`
- Retry reason: ${reason.trim()}
- Last verified: \`${current.metadata.verified_at}\`

The previous candidate survey is preserved as an immutable bootstrap attempt.
Assistant-managed canonical execution remains paused until the revised survey
is validated and activated. Human and non-assistant project work remain
unrestricted.
`
      ),
      "utf8"
    );
    return {
      schema: "assistant.bootstrap-retry/v1",
      status: "prepared",
      attempt_id: attemptId,
      reason: reason.trim()
    };
  } catch (error) {
    await writeFile(statePath, stateBefore, "utf8");
    await writeFile(manifestPath, manifestBefore, "utf8");
    await writeFile(currentPath, currentBefore, "utf8");
    for (const item of moved.reverse()) {
      if (await pathExists(item.destination)) {
        await rename(item.destination, item.source);
      }
    }
    throw error;
  }
}
