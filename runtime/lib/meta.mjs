import { createHash } from "node:crypto";

const META_PATTERN =
  /^\uFEFF?<!-- assistant-meta\r?\n([\s\S]*?)\r?\n-->\r?\n?/;
const POLICY_PATTERN =
  /<!-- assistant-policy\r?\n([\s\S]*?)\r?\n-->/g;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseNodeDocument(content, filePath = "<memory>") {
  const match = content.match(META_PATTERN);
  if (!match) {
    throw new Error(`missing assistant metadata envelope: ${filePath}`);
  }

  let metadata;
  try {
    metadata = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`invalid assistant metadata JSON in ${filePath}: ${error.message}`);
  }

  return {
    metadata,
    body: content.slice(match[0].length),
    contentHash: sha256(content)
  };
}

export function serializeNodeDocument(metadata, body) {
  const json = JSON.stringify(metadata, null, 2);
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `<!-- assistant-meta\n${json}\n-->\n${normalizedBody}`;
}

export function parsePolicyRules(content, filePath = "<memory>") {
  const rules = [];
  for (const match of content.matchAll(POLICY_PATTERN)) {
    try {
      rules.push(JSON.parse(match[1]));
    } catch (error) {
      throw new Error(`invalid assistant policy JSON in ${filePath}: ${error.message}`);
    }
  }
  return rules;
}
