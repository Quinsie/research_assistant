import path from "node:path";
import { activateBootstrap } from "./activation.mjs";
import { doctorProject } from "./doctor.mjs";
import { inspectStructure, maintainStructure } from "./structure.mjs";
import { validateProject } from "./validator.mjs";

function readiness(initializationStatus, doctorStatus) {
  if (doctorStatus === "failed") return "failed";
  if (doctorStatus === "blocked") return "environment_setup_required";
  return initializationStatus;
}

export async function finalizeInstalledProject(target, options = {}) {
  const root = path.resolve(target);
  const initializationStatus = options.initializationStatus ?? "ready";
  let activation = null;
  let structure = null;

  if (initializationStatus === "bootstrap_incomplete") {
    activation = await activateBootstrap(root);
    const plan = await inspectStructure(root);
    if (plan.actions.length > 0) {
      try {
        structure = await maintainStructure(root);
      } catch (error) {
        structure = {
          ...plan,
          applied: false,
          status: "maintenance_required",
          error: error.message
        };
      }
    } else {
      structure = { ...plan, applied: false };
    }
  }

  const validation = await validateProject(root);
  if (!validation.valid) {
    throw new Error(
      `post-initialization validation failed: ${JSON.stringify(validation.findings)}`
    );
  }

  const doctor = await doctorProject(root, {
    probeSandbox: options.probeSandbox
  });
  const finalInitializationStatus =
    activation?.status ?? initializationStatus;
  const maintenanceRequired =
    structure?.status === "maintenance_required";

  return {
    schema: "assistant.initialization-completion/v1",
    initialization_status: finalInitializationStatus,
    readiness: maintenanceRequired
      ? "maintenance_required"
      : readiness(finalInitializationStatus, doctor.status),
    activation,
    structure,
    validation,
    doctor,
    next:
      maintenanceRequired
        ? "repair the structure maintenance finding before normal project work"
        : doctor.status === "ready"
        ? "open Codex in the project root and provide the first project instruction"
        : doctor.status === "blocked"
          ? "complete the environment action reported by doctor, then rerun assistant doctor"
          : "repair the failed doctor check before normal project work"
  };
}
