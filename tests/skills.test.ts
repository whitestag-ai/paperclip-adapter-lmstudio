import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readRuntimeSkillEntries,
  resolveDesiredSkillKeys,
  loadDesiredSkills,
  parseSkillFrontmatter,
  renderSkillsIndex,
  findSkillByName,
  buildSkillSnapshot,
} from "../src/server/skills.js";

describe("readRuntimeSkillEntries", () => {
  it("normalizes config.paperclipRuntimeSkills into entries", () => {
    const entries = readRuntimeSkillEntries({
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/doc-maintenance", runtimeName: "doc-maintenance", source: "/skills/doc-maintenance", required: true },
        { key: "paperclipai/paperclip/release", runtimeName: "release", source: "/skills/release" },
      ],
    });
    expect(entries).toEqual([
      { key: "paperclipai/paperclip/doc-maintenance", runtimeName: "doc-maintenance", source: "/skills/doc-maintenance", required: true },
      { key: "paperclipai/paperclip/release", runtimeName: "release", source: "/skills/release", required: false },
    ]);
  });

  it("drops entries without key, runtimeName or source", () => {
    const entries = readRuntimeSkillEntries({
      paperclipRuntimeSkills: [
        { key: "", runtimeName: "x", source: "/s" },
        { key: "k", runtimeName: "", source: "/s" },
        { key: "k", runtimeName: "x", source: "" },
        { key: "ok", runtimeName: "ok", source: "/s" },
      ],
    });
    expect(entries.map((e) => e.key)).toEqual(["ok"]);
  });

  it("returns empty array when config has no runtime skills", () => {
    expect(readRuntimeSkillEntries({})).toEqual([]);
    expect(readRuntimeSkillEntries({ paperclipRuntimeSkills: "nope" })).toEqual([]);
  });
});

describe("resolveDesiredSkillKeys", () => {
  const config = (overrides: Record<string, unknown>) => ({
    paperclipRuntimeSkills: [
      { key: "paperclipai/paperclip/required-skill", runtimeName: "required-skill", source: "/s/req", required: true },
      { key: "paperclipai/paperclip/opt-a", runtimeName: "opt-a", source: "/s/a" },
      { key: "local/abc123/opt-b", runtimeName: "opt-b", source: "/s/b" },
    ],
    ...overrides,
  });

  it("returns only required skills when no explicit preference is set", () => {
    expect(resolveDesiredSkillKeys(config({}))).toEqual([
      "paperclipai/paperclip/required-skill",
    ]);
  });

  it("unions required with explicitly desired skills", () => {
    const keys = resolveDesiredSkillKeys(
      config({ paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/opt-a"] } }),
    );
    expect(keys.sort()).toEqual([
      "paperclipai/paperclip/opt-a",
      "paperclipai/paperclip/required-skill",
    ]);
  });

  it("canonicalizes desired references given by runtimeName or slug", () => {
    const keys = resolveDesiredSkillKeys(
      config({ paperclipSkillSync: { desiredSkills: ["opt-a", "opt-b"] } }),
    );
    expect(keys).toContain("paperclipai/paperclip/opt-a");
    expect(keys).toContain("local/abc123/opt-b");
  });

  it("deduplicates", () => {
    const keys = resolveDesiredSkillKeys(
      config({
        paperclipSkillSync: {
          desiredSkills: ["opt-a", "paperclipai/paperclip/opt-a", "required-skill"],
        },
      }),
    );
    expect(keys.filter((k) => k === "paperclipai/paperclip/opt-a")).toHaveLength(1);
  });
});

describe("parseSkillFrontmatter", () => {
  it("extracts inline name and description", () => {
    const fm = parseSkillFrontmatter("---\nname: doc-maintenance\ndescription: Detect drift.\n---\n# Body");
    expect(fm).toEqual({ name: "doc-maintenance", description: "Detect drift." });
  });

  it("extracts a folded (>) multi-line description", () => {
    const content = [
      "---",
      "name: release",
      "description: >",
      "  Audit the changelog against git",
      "  history and open a PR.",
      "---",
      "# Body",
    ].join("\n");
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "release",
      description: "Audit the changelog against git history and open a PR.",
    });
  });

  it("strips surrounding quotes from values", () => {
    const fm = parseSkillFrontmatter('---\nname: "whitestag-brand"\ndescription: "Brand rules."\n---\n');
    expect(fm).toEqual({ name: "whitestag-brand", description: "Brand rules." });
  });

  it("returns nulls when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# Just a heading\nbody")).toEqual({ name: null, description: null });
  });
});

describe("loadDesiredSkills", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lmstudio-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSkill(name: string, body: string): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), body, "utf8");
    return dir;
  }

  it("reads content and parsed description for each desired skill", async () => {
    const docSource = await writeSkill(
      "doc-maintenance",
      "---\nname: doc-maintenance\ndescription: Detect drift.\n---\n# Doc Maintenance\nFull body.",
    );
    const config = {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/doc-maintenance", runtimeName: "doc-maintenance", source: docSource, required: true },
      ],
    };
    const skills = await loadDesiredSkills(config);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      key: "paperclipai/paperclip/doc-maintenance",
      runtimeName: "doc-maintenance",
      description: "Detect drift.",
    });
    expect(skills[0]!.content).toContain("Full body.");
  });

  it("returns no skills when none are desired", async () => {
    const source = await writeSkill("opt-a", "---\nname: opt-a\ndescription: x\n---\nbody");
    const config = {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/opt-a", runtimeName: "opt-a", source },
      ],
    };
    expect(await loadDesiredSkills(config)).toEqual([]);
  });

  it("skips a desired skill whose SKILL.md cannot be read", async () => {
    const config = {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/ghost", runtimeName: "ghost", source: path.join(root, "missing"), required: true },
      ],
    };
    expect(await loadDesiredSkills(config)).toEqual([]);
  });
});

describe("renderSkillsIndex (progressive disclosure)", () => {
  const skills = [
    { key: "k1", runtimeName: "doc-maintenance", description: "Detect drift.", content: "# Doc Maintenance\nFULL_BODY_A" },
    { key: "k2", runtimeName: "release", description: "Cut a release.", content: "# Release\nFULL_BODY_B" },
  ];

  it("returns an empty string when there are no skills", () => {
    expect(renderSkillsIndex([])).toBe("");
  });

  it("lists each skill's name and description", () => {
    const index = renderSkillsIndex(skills);
    expect(index).toContain("## Available Skills");
    expect(index).toContain("doc-maintenance");
    expect(index).toContain("Detect drift.");
    expect(index).toContain("release");
    expect(index).toContain("Cut a release.");
  });

  it("instructs the model to call skill_read instead of embedding full bodies", () => {
    const index = renderSkillsIndex(skills);
    expect(index).toContain("skill_read");
    expect(index).not.toContain("FULL_BODY_A");
    expect(index).not.toContain("FULL_BODY_B");
  });
});

describe("buildSkillSnapshot (UI capability)", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    paperclipRuntimeSkills: [
      { key: "paperclipai/paperclip/required-skill", runtimeName: "required-skill", source: "/s/req", required: true },
      { key: "local/abc123/opt-a", runtimeName: "opt-a", source: "/s/a" },
    ],
    ...overrides,
  });

  it("reports the adapter as supported with ephemeral mode", () => {
    const snap = buildSkillSnapshot(config(), "lmstudio_local");
    expect(snap.adapterType).toBe("lmstudio_local");
    expect(snap.supported).toBe(true);
    expect(snap.mode).toBe("ephemeral");
  });

  it("marks required skills configured and others available", () => {
    const snap = buildSkillSnapshot(config());
    const req = snap.entries.find((e) => e.runtimeName === "required-skill")!;
    const opt = snap.entries.find((e) => e.runtimeName === "opt-a")!;
    expect(req.desired).toBe(true);
    expect(req.state).toBe("configured");
    expect(req.required).toBe(true);
    expect(opt.desired).toBe(false);
    expect(opt.state).toBe("available");
  });

  it("marks an explicitly desired skill as configured", () => {
    const snap = buildSkillSnapshot(config({ paperclipSkillSync: { desiredSkills: ["opt-a"] } }));
    const opt = snap.entries.find((e) => e.runtimeName === "opt-a")!;
    expect(opt.desired).toBe(true);
    expect(opt.state).toBe("configured");
    expect(snap.desiredSkills).toContain("local/abc123/opt-a");
  });

  it("warns and lists a missing entry for a desired skill that is not available", () => {
    const snap = buildSkillSnapshot(config({ paperclipSkillSync: { desiredSkills: ["ghost-skill"] } }));
    expect(snap.warnings.some((w) => w.includes("ghost-skill"))).toBe(true);
    const ghost = snap.entries.find((e) => e.key === "ghost-skill")!;
    expect(ghost.state).toBe("missing");
  });
});

describe("findSkillByName", () => {
  const skills = [
    { key: "paperclipai/paperclip/doc-maintenance", runtimeName: "doc-maintenance", description: "d", content: "A" },
    { key: "local/abc123/whitestag-brand", runtimeName: "whitestag-brand", description: "d", content: "B" },
  ];

  it("matches by runtime name (case-insensitive)", () => {
    expect(findSkillByName(skills, "Doc-Maintenance")?.content).toBe("A");
  });

  it("matches by full key", () => {
    expect(findSkillByName(skills, "local/abc123/whitestag-brand")?.content).toBe("B");
  });

  it("matches by trailing slug", () => {
    expect(findSkillByName(skills, "whitestag-brand")?.content).toBe("B");
  });

  it("returns null for an unknown name", () => {
    expect(findSkillByName(skills, "nope")).toBeNull();
  });
});
