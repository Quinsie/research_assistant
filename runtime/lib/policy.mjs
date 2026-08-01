import { SIDE_EFFECTS } from "./contract.mjs";
import { parsePolicyRules } from "./meta.mjs";

const SYSTEM_DEFAULTS = Object.freeze({
  canonical_write: "allowed_with_transaction_and_validation",
  project_asset_write: "allowed_within_current_scope",
  report_write: "explicit_user_request_or_validated_terminal_event",
  source_read: "exact_current_prompt_gateway_only",
  report_read: "exact_current_prompt_gateway_only",
  git_commit: "explicit_user_instruction",
  git_push: "explicit_user_instruction",
  network_public: "task_relevant_public_reference_allowed",
  network_private: "explicit_user_authorization",
  external_action: "explicit_user_authorization",
  destructive_action: "explicit_user_authorization"
});

const PROFILE_DEFAULTS = Object.freeze({
  research: Object.freeze({
    canonical_write: "allowed_with_research_schema_transaction_and_validation",
    project_asset_write: "allowed_within_authorized_research_work",
    network_public: "task_relevant_public_research_reference_allowed"
  }),
  software: Object.freeze({
    canonical_write: "allowed_with_software_schema_transaction_and_validation",
    project_asset_write: "allowed_within_authorized_software_work",
    network_public: "task_relevant_public_software_reference_allowed"
  })
});

export function validatePolicyRules(rules) {
  const findings = [];
  const ids = new Set();

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      findings.push({ severity: "error", code: "POLICY_SHAPE", message: "rule is not an object" });
      continue;
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) {
      findings.push({ severity: "error", code: "POLICY_ID", message: "rule has no stable id" });
    } else if (ids.has(rule.id)) {
      findings.push({ severity: "error", code: "POLICY_DUPLICATE_ID", message: `duplicate rule ${rule.id}` });
    } else {
      ids.add(rule.id);
    }

    if (!Array.isArray(rule.side_effects) || rule.side_effects.length === 0) {
      findings.push({ severity: "error", code: "POLICY_SCOPE", message: `${rule.id ?? "<unknown>"} has no side effects` });
    } else {
      for (const sideEffect of rule.side_effects) {
        if (!SIDE_EFFECTS.has(sideEffect)) {
          findings.push({ severity: "error", code: "POLICY_SIDE_EFFECT", message: `${rule.id} uses unknown side effect ${sideEffect}` });
        }
      }
    }
  }
  return findings;
}

export function resolvePolicy(
  content,
  sideEffect,
  instructionOverride = null,
  options = {}
) {
  if (!SIDE_EFFECTS.has(sideEffect)) {
    throw new Error(`unknown side effect: ${sideEffect}`);
  }

  const rules = parsePolicyRules(content);
  const findings = validatePolicyRules(rules);
  if (findings.some((finding) => finding.severity === "error")) {
    return { status: "invalid", sideEffect, findings, effective: null };
  }

  const matches = rules.filter((rule) =>
    rule.enabled !== false && rule.side_effects.includes(sideEffect)
  );

  const durable = matches.at(-1) ?? null;
  const profile = options.profile ?? "research";
  const profileDefault = PROFILE_DEFAULTS[profile]?.[sideEffect] ?? null;
  const systemDefault = SYSTEM_DEFAULTS[sideEffect] ?? null;
  const effective =
    instructionOverride ??
    durable?.value ??
    profileDefault ??
    systemDefault ??
    null;
  return {
    status: effective === null ? "unresolved" : "resolved",
    sideEffect,
    source: instructionOverride !== null
      ? "current_user_instruction"
      : durable
        ? "project_policy"
        : profileDefault !== null
          ? "profile_default"
          : systemDefault !== null
            ? "system_default"
            : null,
    ruleId: instructionOverride !== null ? null : durable?.id ?? null,
    effective,
    findings
  };
}
