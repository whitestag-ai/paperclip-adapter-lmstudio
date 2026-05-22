import { describe, it, expect, vi } from "vitest";
import { dispatchTool } from "../src/server/tool-executor.js";
import { McpRegistry } from "../src/server/mcp-client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("dispatchTool", () => {
  it("routes paperclip_* tools to paperclip-tools handler", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "agent-1", name: "CEO" }),
    }));

    const result = await dispatchTool({
      name: "paperclip_get_identity",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "http://localhost:3100",
        authToken: "t",
        runId: "r",
        agentId: "a",
        companyId: "c",
      },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("CEO");
  });

  it("routes fs_* tools to fs-tools handler", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
    try {
      const result = await dispatchTool({
        name: "fs_write_file",
        args: { path: "a.txt", content: "hello" },
        cwd,
        paperclipCtx: {
          apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
        },
      });
      expect(result.isError).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns error for unknown tool", async () => {
    const result = await dispatchTool({
      name: "unknown_tool",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});

describe("dispatchTool MCP routing", () => {
  it("routes mcp__ tools to the registry", async () => {
    const registry = { has: () => true, call: vi.fn().mockResolvedValue({ content: "ok", isError: false }) } as unknown as McpRegistry;
    const result = await dispatchTool({
      name: "mcp__paperclip-health__get_daily",
      args: { date: "2026-05-22" },
      cwd: "/tmp",
      paperclipCtx: {} as never,
      mcpRegistry: registry,
      mcpCallTimeoutMs: 30000,
    });
    expect(result).toEqual({ content: "ok", isError: false });
    expect(registry.call).toHaveBeenCalledWith(
      "mcp__paperclip-health__get_daily",
      { date: "2026-05-22" },
      30000,
    );
  });

  it("returns unknown-tool error for mcp__ names when no registry given", async () => {
    const result = await dispatchTool({
      name: "mcp__x__y",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {} as never,
    });
    expect(result.isError).toBe(true);
  });
});
