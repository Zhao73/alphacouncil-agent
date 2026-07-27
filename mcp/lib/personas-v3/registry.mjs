import { existsSync, lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { loadPersonas } from "../personas/registry.mjs";
import { compilePersonaPack } from "./compiler.mjs";
import { loadSoloTestV3Packs, loadV3Packs } from "./loader.mjs";

export const PERSONA_BUILD_PROFILE_ENV = "ALPHACOUNCIL_PERSONA_BUILD_PROFILE";
export const DEFAULT_BUILD_PROFILE_FILE = fileURLToPath(new URL("../../../data/build-profile.v1.json", import.meta.url));
export const DEFAULT_SOLO_TEST_PACK_ROOT = fileURLToPath(new URL("../../../knowledge/solo-test/masters/", import.meta.url));

function readBuildProfile(file = DEFAULT_BUILD_PROFILE_FILE) {
  if (!existsSync(file)) return "production";
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("persona build-profile config must be a plain file");
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`persona build-profile config is invalid JSON (${error.message})`);
  }
  if (value?.schema_version !== 1 || !["production", "solo_test"].includes(value?.channel)) {
    throw new Error("persona build-profile config must declare schema_version=1 and channel=production|solo_test");
  }
  return value.channel;
}

export function resolveRuntimePersonaBuildProfile({ env = process.env, file = DEFAULT_BUILD_PROFILE_FILE } = {}) {
  const overridden = env[PERSONA_BUILD_PROFILE_ENV]?.trim();
  if (overridden && !["production", "solo_test"].includes(overridden)) {
    throw new Error(`${PERSONA_BUILD_PROFILE_ENV} must be production or solo_test`);
  }
  return overridden || readBuildProfile(file);
}

export function loadCompiledPersonaPacks({
  knowledgeDir,
  personaDir,
  buildProfile = "production",
  soloTestDir = DEFAULT_SOLO_TEST_PACK_ROOT,
} = {}) {
  if (!["production", "solo_test"].includes(buildProfile)) {
    throw new Error("buildProfile must be production or solo_test");
  }
  const prompts = loadPersonas(personaDir ? { dir: personaDir } : {});
  const loaded = buildProfile === "solo_test"
    ? loadSoloTestV3Packs({ dir: resolve(soloTestDir) })
    : loadV3Packs(knowledgeDir ? { dir: knowledgeDir } : {});
  const compiled = [];
  for (const pack of loaded.packs) {
    const id = pack.manifest.identity.persona_id;
    const persona = prompts.get(id);
    if (!persona || persona.kind !== "master" || persona.enabled === false) {
      throw new Error(`PersonaPack v3 ${id} has no enabled canonical master persona`);
    }
    compiled.push(compilePersonaPack(pack, { promptFile: join(prompts.dir, persona.file) }));
  }
  compiled.sort((a, b) => a.persona_id.localeCompare(b.persona_id));
  const byId = new Map(compiled.map((pack) => [pack.persona_id, pack]));
  return Object.freeze({
    build_profile: buildProfile,
    provisional: buildProfile === "solo_test",
    packs: Object.freeze(compiled),
    legacy_ids: loaded.legacy_ids,
    get: (id) => byId.get(id),
    ids: () => compiled.map((pack) => pack.persona_id),
  });
}

let cached = null;

export function compiledPersonaPacks() {
  if (!cached) {
    const buildProfile = resolveRuntimePersonaBuildProfile();
    cached = loadCompiledPersonaPacks({ buildProfile });
  }
  return cached;
}

export function resetCompiledPersonaPacks() {
  cached = null;
}
