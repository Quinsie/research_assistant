export function renderIndex(nodes) {
  const paths = new Map();
  for (const node of nodes) {
    if (["current", "policy"].includes(node.metadata.type)) continue;
    const records = node.metadata.records ?? [node.metadata];
    paths.set(node.path, {
      path: node.path.replace(/^\.assistant\//u, ""),
      ids: records.map((record) => record.id),
      types: [...new Set(records.map((record) => record.type))]
    });
  }
  const lines = [
    "# Assistant knowledge index",
    "",
    "Generated route view; canonical owners retain semantic authority.",
    "",
    "## Orientation",
    "",
    "- [CURRENT.md](CURRENT.md): current state, authorization, blockers, next route",
    "- [POLICY.md](POLICY.md): task-relevant durable policy",
    "",
    "## Canonical routes"
  ];
  const routeItems = [...paths.values()].sort((a, b) =>
    a.path.localeCompare(b.path, "en")
  );
  if (routeItems.length > 0) lines.push("");
  for (const item of routeItems) {
    lines.push(
      `- [${item.ids.join(", ")}](${item.path}): ${item.types.join(", ")}`
    );
  }
  lines.push(
    "",
    "## Restricted interfaces",
    "",
    "`docs/`, `.assistant/vault/`, project-specific cold document boundaries, and the grant ledger require the restricted gateway. `docs/report/` is the only write interface for Assistant-generated human reports; it is not a readable fallback during normal work."
  );
  return `${lines.join("\n")}\n`;
}
