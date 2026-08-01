import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOUNDEDNESS_DEFAULTS } from "./contract.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";
import { renderIndex } from "./projection.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";
import { loadCanonicalNodes, validateProject } from "./validator.mjs";

const PROFILE_COLLECTIONS = Object.freeze({
  research: Object.freeze({
    question: ["COL-RESEARCH-AGENDA", ".assistant/knowledge/research/AGENDA.md", "Research agenda", "research_agenda"],
    hypothesis: ["COL-RESEARCH-AGENDA", ".assistant/knowledge/research/AGENDA.md", "Research agenda", "research_agenda"],
    literature: ["COL-RESEARCH-AGENDA", ".assistant/knowledge/research/AGENDA.md", "Research agenda", "research_agenda"],
    experiment: ["COL-RESEARCH-EVIDENCE", ".assistant/knowledge/research/EVIDENCE.md", "Research evidence", "research_evidence"],
    evidence: ["COL-RESEARCH-EVIDENCE", ".assistant/knowledge/research/EVIDENCE.md", "Research evidence", "research_evidence"]
  }),
  software: Object.freeze({
    requirement: ["COL-SOFTWARE-ARCHITECTURE", ".assistant/knowledge/software/ARCHITECTURE.md", "Software requirements and design", "software_architecture"],
    design: ["COL-SOFTWARE-ARCHITECTURE", ".assistant/knowledge/software/ARCHITECTURE.md", "Software requirements and design", "software_architecture"],
    task: ["COL-SOFTWARE-DELIVERY", ".assistant/knowledge/software/DELIVERY.md", "Software delivery", "software_delivery"],
    release: ["COL-SOFTWARE-DELIVERY", ".assistant/knowledge/software/DELIVERY.md", "Software delivery", "software_delivery"],
    test: ["COL-SOFTWARE-VERIFICATION", ".assistant/knowledge/software/VERIFICATION.md", "Software verification evidence", "software_verification"],
    evidence: ["COL-SOFTWARE-VERIFICATION", ".assistant/knowledge/software/VERIFICATION.md", "Software verification evidence", "software_verification"],
    issue: ["COL-ACTIVE-OPERATIONS", ".assistant/knowledge/work/ACTIVE.md", "Active operations", "operations"]
  })
});

function profileCollections(profile) {
  return PROFILE_COLLECTIONS[profile] ?? PROFILE_COLLECTIONS.research;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractBlock(body, id) {
  const escaped = escapeRegExp(id);
  const match = body.match(
    new RegExp(
      `\\s*<!-- assistant-record:start ${escaped} -->\\s*([\\s\\S]*?)\\s*<!-- assistant-record:end ${escaped} -->\\s*`,
      "u"
    )
  );
  return match ? { full: match[0], inner: `${match[1].trim()}\n` } : null;
}

function individualPath(type, id, profile) {
  const sharedDirectories = {
    work: "work/items",
    issue: "work/issues",
    risk: "risks",
    decision: "decisions",
    history: "history",
    environment: "environment",
    plan: "plans",
    foundation: "foundations"
  };
  if (sharedDirectories[type]) {
    return `.assistant/knowledge/${sharedDirectories[type]}/${id}.md`;
  }
  if (profile === "software") {
    const directories = {
      requirement: "requirements",
      design: "design",
      task: "tasks",
      test: "tests",
      release: "releases",
      evidence: "evidence"
    };
    return `.assistant/knowledge/software/${directories[type] ?? `${type}s`}/${id}.md`;
  }
  const directory = type === "hypothesis" ? "hypotheses" : `${type}s`;
  return `.assistant/knowledge/research/${directory}/${id}.md`;
}

export async function refreshIndex(target) {
  const root = path.resolve(target);
  const loaded = await loadCanonicalNodes(root);
  if (loaded.findings.some((item) => item.severity === "error")) {
    throw new Error(
      `cannot refresh index for invalid owners: ${JSON.stringify(loaded.findings)}`
    );
  }
  const content = renderIndex(loaded.nodes);
  await writeFile(path.join(root, ".assistant", "INDEX.md"), content, "utf8");
  return {
    path: ".assistant/INDEX.md",
    bytes: Buffer.byteLength(content, "utf8")
  };
}

export async function inspectStructure(target) {
  const root = path.resolve(target);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const collections = profileCollections(manifest.profile);
  const loaded = await loadCanonicalNodes(root);
  const actions = [];
  for (const node of loaded.nodes) {
    if (node.metadata.type === "collection") {
      const records = (node.metadata.records ?? []).map((record) => {
        const block = extractBlock(node.body, record.id);
        return { record, bytes: block ? Buffer.byteLength(block.full, "utf8") : null };
      });
      if (
        node.bytes > BOUNDEDNESS_DEFAULTS.softBytes ||
        records.length > BOUNDEDNESS_DEFAULTS.softChildRecords ||
        records.some((item) => (item.bytes ?? 0) > 6_000)
      ) {
        actions.push({
          action: "promote",
          owner_id: node.metadata.id,
          path: node.path,
          reason: {
            bytes: node.bytes,
            records: records.length
          },
          candidates: records
            .filter((item) => item.bytes !== null)
            .sort((a, b) => b.bytes - a.bytes)
            .map((item) => ({ id: item.record.id, bytes: item.bytes }))
        });
      }
    } else if (
      collections[node.metadata.type] &&
      node.metadata.lifecycle_completed === true &&
      node.metadata.consolidation_candidate === true &&
      node.bytes <= 3_000
    ) {
      actions.push({
        action: "consolidate",
        id: node.metadata.id,
        type: node.metadata.type,
        path: node.path,
        bytes: node.bytes
      });
    }
  }
  return { schema: "assistant.structure-plan/v1", actions, findings: loaded.findings };
}

export async function maintainStructure(target) {
  const root = path.resolve(target);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const profile = manifest.profile ?? "research";
  const collections = profileCollections(profile);
  const plan = await inspectStructure(root);
  if (plan.findings.some((item) => item.severity === "error")) {
    throw new Error(`cannot maintain invalid project: ${JSON.stringify(plan.findings)}`);
  }
  if (plan.actions.length === 0) return { ...plan, applied: false };

  const transactionId = `TXN-${randomUUID()}`;
  const transactionRoot = path.join(
    root,
    ".assistant",
    "internal",
    "transactions",
    transactionId
  );
  await mkdir(transactionRoot, { recursive: true });
  const backups = new Map();
  const created = [];
  const removed = new Map();
  const loaded = await loadCanonicalNodes(root);
  const byPath = new Map(loaded.nodes.map((node) => [node.path, node]));

  async function backup(relative) {
    if (backups.has(relative)) return;
    const absolute = path.join(root, ...relative.split("/"));
    if (await pathExists(absolute)) backups.set(relative, await readFile(absolute, "utf8"));
  }

  try {
    await backup(".assistant/internal/validated-hashes.json");
    for (const action of plan.actions.filter((item) => item.action === "promote")) {
      const node = byPath.get(action.path);
      let body = node.body;
      const records = [...node.metadata.records];
      const promote = [];
      let projectedBytes = node.bytes;
      let projectedCount = records.length;
      for (const candidate of action.candidates) {
        if (
          projectedBytes <= BOUNDEDNESS_DEFAULTS.softBytes &&
          projectedCount <= BOUNDEDNESS_DEFAULTS.softChildRecords &&
          candidate.bytes <= 6_000
        ) break;
        promote.push(candidate.id);
        projectedBytes -= candidate.bytes;
        projectedCount -= 1;
      }
      await backup(action.path);
      for (const id of promote) {
        const record = records.find((item) => item.id === id);
        const block = extractBlock(body, id);
        if (!record || !block) throw new Error(`cannot extract record ${id}`);
        const relative = individualPath(record.type, id, profile);
        const absolute = path.join(root, ...relative.split("/"));
        if (await pathExists(absolute)) throw new Error(`promotion target exists: ${relative}`);
        const metadata = {
          ...record,
          schema: "assistant.node/v1",
          promoted_from: node.metadata.id,
          verified_at: new Date().toISOString()
        };
        await writeUtf8(absolute, serializeNodeDocument(metadata, block.inner));
        created.push(relative);
        body = body.replace(block.full, "\n");
      }
      node.metadata.records = records.filter((record) => !promote.includes(record.id));
      node.metadata.relations = (node.metadata.relations ?? []).filter(
        (relation) => !(relation.type === "contains" && promote.includes(relation.target))
      );
      node.metadata.verified_at = new Date().toISOString();
      const absolute = path.join(root, ...action.path.split("/"));
      if (node.metadata.records.length > 0) {
        await writeFile(absolute, serializeNodeDocument(node.metadata, body), "utf8");
      } else {
        removed.set(action.path, backups.get(action.path));
        await rm(absolute, { force: true });
        const currentPath = ".assistant/CURRENT.md";
        await backup(currentPath);
        const currentAbsolute = path.join(root, ".assistant", "CURRENT.md");
        const current = parseNodeDocument(await readFile(currentAbsolute, "utf8"));
        current.metadata.relations = (current.metadata.relations ?? []).flatMap((relation) =>
          relation.target === node.metadata.id
            ? promote.map((id) => ({ type: relation.type, target: id }))
            : [relation]
        );
        await writeFile(
          currentAbsolute,
          serializeNodeDocument(current.metadata, current.body),
          "utf8"
        );
      }
    }

    for (const action of plan.actions.filter((item) => item.action === "consolidate")) {
      const node = byPath.get(action.path);
      const [ownerId, collectionPath, title, collectionKind] =
        collections[node.metadata.type];
      const collectionAbsolute = path.join(root, ...collectionPath.split("/"));
      await backup(action.path);
      await backup(collectionPath);
      let collection;
      if (await pathExists(collectionAbsolute)) {
        collection = parseNodeDocument(await readFile(collectionAbsolute, "utf8"));
      } else {
        collection = {
          metadata: {
            schema: "assistant.node/v1",
            id: ownerId,
            type: "collection",
            collection_kind: collectionKind,
            status: "active",
            authority: "canonical_agent",
            relations: [],
            records: [],
            verified_at: new Date().toISOString()
          },
          body: `# ${title}\n`
        };
        created.push(collectionPath);
      }
      const record = { ...node.metadata };
      delete record.schema;
      delete record.verified_at;
      collection.metadata.records.push(record);
      collection.metadata.relations.push({ type: "contains", target: record.id });
      collection.metadata.verified_at = new Date().toISOString();
      const block = `\n<!-- assistant-record:start ${record.id} -->\n${node.body.trim()}\n<!-- assistant-record:end ${record.id} -->\n`;
      const serialized = serializeNodeDocument(
        collection.metadata,
        `${collection.body.trimEnd()}\n${block}`
      );
      if (Buffer.byteLength(serialized, "utf8") > BOUNDEDNESS_DEFAULTS.softBytes) {
        continue;
      }
      await writeUtf8(collectionAbsolute, serialized);
      removed.set(action.path, await readFile(path.join(root, ...action.path.split("/")), "utf8"));
      await rm(path.join(root, ...action.path.split("/")), { force: true });
    }

    const indexPath = ".assistant/INDEX.md";
    await backup(indexPath);
    await refreshIndex(root);
    const preliminaryValidation = await validateProject(root);
    if (!preliminaryValidation.valid) {
      throw new Error(`structure validation failed: ${JSON.stringify(preliminaryValidation.findings)}`);
    }
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "structure_maintenance",
        status: "committed",
        actions: plan.actions,
        committed_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    await refreshValidatedHashes(root, `structure_maintenance:${transactionId}`);
    const validation = await validateProject(root);
    return { ...plan, applied: true, transaction_id: transactionId, validation };
  } catch (error) {
    for (const [relative, content] of backups) {
      await writeUtf8(path.join(root, ...relative.split("/")), content);
    }
    for (const relative of created.reverse()) {
      if (!backups.has(relative) && await pathExists(path.join(root, ...relative.split("/")))) {
        await rm(path.join(root, ...relative.split("/")), { force: true });
      }
    }
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "structure_maintenance",
        status: "rolled_back",
        error: error.message,
        rolled_back_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    throw error;
  }
}
