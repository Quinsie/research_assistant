const CONTROL_ROLES = Object.freeze([
  ["current", /\b(?:current\s+(?:state|status|work)|active\s+(?:goal|milestone|work))\b/iu],
  ["plan", /\b(?:approved\s+plan|master\s+plan|roadmap|milestones?|execution\s+sequence|next\s+actions?)\b/iu],
  ["policy", /\b(?:policy|durable\s+rules?|governance)\b/iu],
  ["decision", /\b(?:decisions?|decision\s+log|rationale)\b/iu],
  ["authorization", /\b(?:authorization|authorized\s+work|blocked\s+work|approval\s+gate)\b/iu],
  ["router", /\b(?:documentation\s+(?:index|routing)|default\s+reading\s+set|read\s+when|route[sd]?\s+to)\b/iu]
]);

function normalize(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/[),.;:`'"]+$/u, "");
}

function pathsInLine(line) {
  const values = new Set();
  const quoted =
    /[`"']([^`"'\r\n]+\.(?:md|mdx|rst|txt|json|ya?ml|toml))[`"']/giu;
  const bare =
    /(?:^|\s)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:md|mdx|rst|txt|json|ya?ml|toml))(?=$|[\s),.;:])/giu;
  for (const pattern of [quoted, bare]) {
    for (const match of line.matchAll(pattern)) {
      values.add(normalize(match[1]));
    }
  }
  return [...values];
}

export function discoverReferencedControlSurfaces(content, inventoryPaths = []) {
  const known = new Set(
    inventoryPaths.map((value) => normalize(value).toLowerCase())
  );
  const found = new Map();
  let sectionRoles = [];
  for (const line of content.split(/\r?\n/u)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      sectionRoles = CONTROL_ROLES
        .filter(([, pattern]) => pattern.test(heading[1]))
        .map(([role]) => role);
    }
    const lineRoles = CONTROL_ROLES
      .filter(([, pattern]) => pattern.test(line))
      .map(([role]) => role);
    if (
      pathsInLine(line).length > 0 &&
      /\b(?:read|consult|follow|see|refer(?:\s+to)?)\b.*\b(?:before|first|start|work|task)\b/iu.test(
        line
      )
    ) {
      lineRoles.push("router", "instruction");
    }
    const roles = [...new Set([...sectionRoles, ...lineRoles])];
    if (roles.length === 0) continue;
    for (const relative of pathsInLine(line)) {
      const current = found.get(relative) ?? new Set();
      for (const role of roles) current.add(role);
      found.set(relative, current);
    }
  }
  return [...found.entries()]
    .map(([path, roles]) => ({
      path,
      roles: [...roles].sort(),
      exists_in_inventory:
        known.size === 0 ? null : known.has(path.toLowerCase())
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function competingControlPaths(surfaces) {
  return surfaces
    .filter((surface) =>
      surface.roles.some((role) =>
        ["current", "plan", "policy", "decision", "authorization", "router"].includes(role)
      )
    )
    .map((surface) => surface.path);
}
