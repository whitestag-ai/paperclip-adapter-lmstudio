import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Paperclip Skill support for the LM Studio adapter.
 *
 * The Paperclip server delivers the company's runtime skills to every run by
 * injecting two keys into the adapter config (see heartbeat.ts):
 *
 *   - `paperclipRuntimeSkills`: every available skill with an absolute path to
 *     its on-disk directory (which contains a `SKILL.md`).
 *   - `paperclipSkillSync.desiredSkills`: the skills selected for this agent.
 *
 * CLI-backed adapters (codex, cursor, …) symlink the desired skill directories
 * into the CLI's own skills home and let the CLI auto-discover them. The LM
 * Studio adapter runs its own agent loop with a hand-built system prompt and
 * has no such auto-discovery — so it must read the SKILL.md bodies itself and
 * inject them into the system prompt. This module mirrors the resolution
 * contract from `@paperclipai/adapter-utils` so behaviour matches the built-in
 * adapters, without taking an internal Paperclip dependency.
 */

export interface RuntimeSkillEntry {
  key: string;
  runtimeName: string;
  /** Absolute path to the skill directory containing SKILL.md. */
  source: string;
  required: boolean;
}

export interface ResolvedSkill {
  key: string;
  runtimeName: string;
  /** Short description from the SKILL.md frontmatter (for the prompt index). */
  description: string | null;
  /** Full SKILL.md text, loaded on demand by the `skill_read` tool. */
  content: string;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalize `config.paperclipRuntimeSkills` into entries. Anything missing a
 * key, runtimeName or source is dropped so a malformed entry can't poison the
 * run — skill injection simply skips it.
 */
export function readRuntimeSkillEntries(
  config: Record<string, unknown>,
): RuntimeSkillEntry[] {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) return [];

  const out: RuntimeSkillEntry[] = [];
  for (const rawEntry of raw) {
    const entry = asRecord(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({ key, runtimeName, source, required: asBoolean(entry.required, false) });
  }
  return out;
}

function readDesiredPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const sync = raw as Record<string, unknown>;
  const values = sync.desiredSkills;
  const desired = Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(sync, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

/**
 * Resolve a desired-skill reference (canonical key, runtimeName, or trailing
 * slug) to the canonical key of an available entry. Unresolvable references
 * fall through unchanged so they surface as "missing" rather than vanishing.
 */
function canonicalizeReference(
  reference: string,
  entries: RuntimeSkillEntry[],
): string {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return "";

  const byKey = entries.find((e) => e.key.trim().toLowerCase() === normalized);
  if (byKey) return byKey.key;

  const byRuntimeName = entries.filter(
    (e) => e.runtimeName.trim().toLowerCase() === normalized,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const bySlug = entries.filter(
    (e) => e.key.trim().toLowerCase().split("/").pop() === normalized,
  );
  if (bySlug.length === 1) return bySlug[0]!.key;

  return normalized;
}

/**
 * Determine which skill keys are active for this run. Mirrors
 * `resolvePaperclipDesiredSkillNames` from adapter-utils:
 *   - Required skills are always active.
 *   - Without an explicit preference, only required skills are active.
 *   - With an explicit preference, required ∪ canonicalized desired.
 */
export function resolveDesiredSkillKeys(config: Record<string, unknown>): string[] {
  const entries = readRuntimeSkillEntries(config);
  const required = entries.filter((e) => e.required).map((e) => e.key);
  const preference = readDesiredPreference(config);

  if (!preference.explicit) {
    return Array.from(new Set(required));
  }

  const desired = preference.desiredSkills
    .map((reference) => canonicalizeReference(reference, entries))
    .filter(Boolean);
  return Array.from(new Set([...required, ...desired]));
}

/**
 * Parse the `name` and `description` fields out of a SKILL.md YAML frontmatter
 * block. Handles inline values and folded (`>` / `|`) multi-line scalars, and
 * strips surrounding quotes. Returns nulls when there is no frontmatter.
 *
 * Deliberately tiny — we only need two fields and don't want a YAML dependency.
 */
export function parseSkillFrontmatter(content: string): {
  name: string | null;
  description: string | null;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { name: null, description: null };
  const closing = normalized.indexOf("\n---", 3);
  if (closing < 0) return { name: null, description: null };

  const lines = normalized.slice(4, closing).split("\n");
  const result: { name: string | null; description: string | null } = {
    name: null,
    description: null,
  };

  function unquote(value: string): string {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const field = match[1];
    let value = match[2]!.trim();

    // Folded/literal block scalar — collect the indented continuation lines.
    if (value === ">" || value === "|" || value === "") {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s/.test(lines[j]!) && lines[j]!.trim() !== "") {
          collected.push(lines[j]!.trim());
        } else if (/^[A-Za-z0-9_-]+:/.test(lines[j]!)) {
          break;
        }
      }
      if (collected.length > 0) value = collected.join(" ");
    }

    if (field === "name" && result.name === null) result.name = unquote(value) || null;
    if (field === "description" && result.description === null) {
      result.description = unquote(value) || null;
    }
  }

  return result;
}

/**
 * Read the SKILL.md body + description of every desired+available skill. Skills
 * whose file cannot be read are skipped (resilient: a single broken skill never
 * fails the run). Order follows the available-entries order for deterministic
 * prompts.
 */
export async function loadDesiredSkills(
  config: Record<string, unknown>,
): Promise<ResolvedSkill[]> {
  const entries = readRuntimeSkillEntries(config);
  const desired = new Set(resolveDesiredSkillKeys(config));
  if (desired.size === 0) return [];

  const out: ResolvedSkill[] = [];
  for (const entry of entries) {
    if (!desired.has(entry.key)) continue;
    try {
      const content = await readFile(path.join(entry.source, "SKILL.md"), "utf8");
      const { description } = parseSkillFrontmatter(content);
      out.push({ key: entry.key, runtimeName: entry.runtimeName, description, content });
    } catch {
      // Unreadable skill — skip it rather than failing the whole run.
    }
  }
  return out;
}

/**
 * Render a compact skill *index* for the system prompt (progressive
 * disclosure): only each skill's name and description, plus an instruction to
 * pull the full instructions on demand via the `skill_read` tool. This keeps
 * the prompt small even when an agent has many skills — important for local
 * models with tight context windows. Returns "" when there are no skills.
 */
export function renderSkillsIndex(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return "";

  const parts: string[] = [
    "## Available Skills",
    "",
    `You have ${skills.length} skill(s) available — focused playbooks for specific tasks. ` +
      "Only their names and descriptions are listed below. When a task matches a skill, " +
      "call the `skill_read` tool with the skill's name to load its full instructions BEFORE acting on it.",
    "",
  ];

  for (const skill of skills) {
    const desc = skill.description ? `: ${skill.description}` : "";
    parts.push(`- **${skill.runtimeName}**${desc}`);
  }

  return parts.join("\n");
}

// --- UI capability snapshot ----------------------------------------------
// Mirrors the AdapterSkillSnapshot contract from @paperclipai/adapter-utils so
// the Paperclip UI shows skill state for this adapter. We don't depend on that
// package; these local types describe the same shape the server/UI expect.

export type SkillSnapshotState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export interface SkillSnapshotEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  state: SkillSnapshotState;
  origin: "company_managed" | "paperclip_required" | "user_installed" | "external_unknown";
  originLabel: string | null;
  readOnly: boolean;
  sourcePath: string | null;
  targetPath: string | null;
  detail: string | null;
  required: boolean;
  requiredReason: string | null;
}

export interface SkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: "unsupported" | "persistent" | "ephemeral";
  desiredSkills: string[];
  entries: SkillSnapshotEntry[];
  warnings: string[];
}

export interface SkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

/**
 * Build the skill snapshot the Paperclip UI renders for this agent. Mode is
 * "ephemeral": skills aren't installed into a CLI skills-home; they're resolved
 * per run and surfaced via the prompt index + `skill_read` tool.
 */
export function buildSkillSnapshot(
  config: Record<string, unknown>,
  adapterType = "lmstudio_local",
): SkillSnapshot {
  const available = readRuntimeSkillEntries(config);
  const availableByKey = new Map(available.map((entry) => [entry.key, entry]));
  const desiredSkills = resolveDesiredSkillKeys(config);
  const desiredSet = new Set(desiredSkills);

  const entries: SkillSnapshotEntry[] = available.map((entry) => {
    const desired = desiredSet.has(entry.key);
    return {
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Available to the agent via the skill_read tool on the next run."
        : null,
      required: entry.required,
      requiredReason: entry.required
        ? "Bundled Paperclip skills are always available for local adapters."
        : null,
    };
  });

  const warnings: string[] = [];
  for (const key of desiredSkills) {
    if (availableByKey.has(key)) continue;
    warnings.push(`Desired skill "${key}" is not available from the Paperclip skills directory.`);
    entries.push({
      key,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the runtime skills directory.",
      required: false,
      requiredReason: null,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return { adapterType, supported: true, mode: "ephemeral", desiredSkills, entries, warnings };
}

/** Adapter hook: list skills for the agent (UI capability). */
export async function listSkills(ctx: SkillContext): Promise<SkillSnapshot> {
  return buildSkillSnapshot(ctx.config, ctx.adapterType);
}

/**
 * Adapter hook: "sync" skills. Ephemeral adapters have nothing to install —
 * desired skills take effect on the next run — so this just returns the current
 * snapshot, mirroring the codex adapter.
 */
export async function syncSkills(
  ctx: SkillContext,
  _desiredSkills: string[],
): Promise<SkillSnapshot> {
  return buildSkillSnapshot(ctx.config, ctx.adapterType);
}

/**
 * Look up a loaded skill by the reference the model passed to `skill_read`:
 * exact runtime name, full key, or trailing slug — all case-insensitive.
 */
export function findSkillByName(
  skills: ResolvedSkill[],
  name: string,
): ResolvedSkill | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  return (
    skills.find((s) => s.runtimeName.trim().toLowerCase() === normalized) ??
    skills.find((s) => s.key.trim().toLowerCase() === normalized) ??
    skills.find((s) => s.key.trim().toLowerCase().split("/").pop() === normalized) ??
    null
  );
}
