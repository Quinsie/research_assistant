import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export async function setProjectLocale(target, locale, options = {}) {
  const root = path.resolve(target);
  if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
    throw new Error("locale must be a BCP-47 language tag such as ko, en, or pt-BR");
  }
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.project_locale &&
    manifest.project_locale !== locale &&
    options.confirmed !== true
  ) {
    throw new Error(
      `project locale is already ${manifest.project_locale}; changing it requires --confirm`
    );
  }
  const previous = manifest.project_locale ?? null;
  manifest.project_locale = locale;
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return {
    schema: "assistant.locale-result/v1",
    previous,
    project_locale: locale,
    changed: previous !== locale
  };
}
