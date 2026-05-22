import { describe, it, expect } from "vitest";
import { encodeMcpToolName, decodeMcpToolName, McpRegistry } from "../src/server/mcp-client.js";

describe("mcp tool name encoding", () => {
  it("encodes server + tool into a mcp__ prefixed name", () => {
    expect(encodeMcpToolName("paperclip-health", "get_daily")).toBe(
      "mcp__paperclip-health__get_daily",
    );
  });
  it("decodes back to server and tool", () => {
    expect(decodeMcpToolName("mcp__paperclip-health__get_daily")).toEqual({
      server: "paperclip-health", tool: "get_daily",
    });
  });
  it("preserves tool names that themselves contain __", () => {
    const encoded = encodeMcpToolName("srv", "a__b");
    expect(decodeMcpToolName(encoded)).toEqual({ server: "srv", tool: "a__b" });
  });
  it("returns null for non-mcp names", () => {
    expect(decodeMcpToolName("paperclip_get_inbox")).toBeNull();
  });
});

describe("McpRegistry with no connected servers", () => {
  it("has() is false for an unconnected mcp tool", () => {
    const reg = new McpRegistry();
    expect(reg.has("mcp__paperclip-health__get_daily")).toBe(false);
  });

  it("call() returns an error result instead of throwing", async () => {
    const reg = new McpRegistry();
    const result = await reg.call("mcp__paperclip-health__get_daily", {}, 1000);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not connected");
  });

  it("call() rejects a non-mcp name", async () => {
    const reg = new McpRegistry();
    const result = await reg.call("paperclip_get_inbox", {}, 1000);
    expect(result.isError).toBe(true);
  });
});
