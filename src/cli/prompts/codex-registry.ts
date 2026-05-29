import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Reference counting for the user-level Codex skill.
 *
 * The Codex runtime skill installs to `~/.codex/skills/gojaja-runtime/`,
 * which is shared by EVERY project on the machine that activated a Codex
 * agent. Deleting it during one project's `reset` would silently break
 * the others. To avoid that we keep a registry of project roots that
 * have installed the skill, and only physically remove the skill dir
 * when the last project drops out.
 *
 * The registry lives inside the skill dir, so removing the skill removes
 * the registry with it. fs access is local to this module (the skill is
 * user-level, outside any project's `.gojaja/` Store).
 */

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function codexSkillDir(): string {
  return path.join(codexHome(), "skills", "gojaja-runtime");
}

function registryFile(): string {
  return path.join(codexSkillDir(), "installed-projects.json");
}

interface Registry {
  projects: string[];
}

async function readRegistry(): Promise<string[]> {
  try {
    const raw = await fsp.readFile(registryFile(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (!parsed || !Array.isArray(parsed.projects)) return [];
    return parsed.projects.filter((p) => typeof p === "string");
  } catch {
    // Missing or corrupt registry → treat as empty. The skill may
    // predate ref-counting; first register/unregister rebuilds it.
    return [];
  }
}

async function writeRegistry(projects: string[]): Promise<void> {
  const sorted = [...new Set(projects)].sort();
  await fsp.mkdir(codexSkillDir(), { recursive: true });
  await fsp.writeFile(
    registryFile(),
    JSON.stringify({ projects: sorted }, null, 2) + "\n",
  );
}

/** Record that `projectRoot` uses the Codex skill. Idempotent. */
export async function registerCodexProject(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const current = await readRegistry();
  if (current.includes(root)) return;
  await writeRegistry([...current, root]);
}

/**
 * Drop `projectRoot` from the registry and return the roots that still
 * use the skill. Safe to call even if the project was never registered.
 */
export async function unregisterCodexProject(
  projectRoot: string,
): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const current = await readRegistry();
  const remaining = current.filter((p) => p !== root);
  // Only rewrite when something actually changed AND the skill dir still
  // exists (don't recreate a dir the caller is about to delete).
  if (remaining.length !== current.length) {
    try {
      await fsp.access(codexSkillDir());
      await writeRegistry(remaining);
    } catch {
      // Skill dir gone already — nothing to persist.
    }
  }
  return remaining;
}

/**
 * Project roots OTHER than `projectRoot` that still use the skill, read
 * WITHOUT mutating the registry (for reset preview / dry-run).
 */
export async function otherCodexProjects(
  projectRoot: string,
): Promise<string[]> {
  const root = path.resolve(projectRoot);
  return (await readRegistry()).filter((p) => p !== root);
}
