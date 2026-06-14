import { executePaperclipTool, PaperclipContext, ToolResult } from "./paperclip-tools.js";
import { executeFsTool } from "./fs-tools.js";
import { executeShellTool } from "./shell-tools.js";
import type { McpRegistry } from "./mcp-client.js";
import { findSkillByName, type ResolvedSkill } from "./skills.js";

export interface DispatchParams {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  paperclipCtx: PaperclipContext;
  allowedWriteRoots?: string[];
  mcpRegistry?: McpRegistry;
  mcpCallTimeoutMs?: number;
  /** Skills loaded for this run, used to serve `skill_read` on demand. */
  skills?: ResolvedSkill[];
}

export async function dispatchTool(params: DispatchParams): Promise<ToolResult> {
  const {
    name,
    args,
    cwd,
    paperclipCtx,
    allowedWriteRoots = [],
    mcpRegistry,
    mcpCallTimeoutMs = 30000,
    skills = [],
  } = params;

  if (name === "skill_read") {
    const requested = typeof args.name === "string" ? args.name : "";
    if (!requested) {
      return { content: "skill_read requires a 'name' argument.", isError: true };
    }
    const skill = findSkillByName(skills, requested);
    if (!skill) {
      const available = skills.map((s) => s.runtimeName).join(", ") || "(none)";
      return {
        content: `Unknown skill "${requested}". Available skills: ${available}.`,
        isError: true,
      };
    }
    return { content: skill.content, isError: false };
  }

  if (name.startsWith("mcp__")) {
    if (mcpRegistry && mcpRegistry.has(name)) {
      return mcpRegistry.call(name, args, mcpCallTimeoutMs);
    }
    return { content: `Unknown MCP tool: ${name}`, isError: true };
  }
  if (name.startsWith("paperclip_")) {
    return executePaperclipTool(name, args, paperclipCtx);
  }
  if (name.startsWith("fs_")) {
    return executeFsTool(name, args, cwd, allowedWriteRoots);
  }
  if (name.startsWith("shell_") || name.startsWith("git_")) {
    return executeShellTool(name, args, cwd);
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}
