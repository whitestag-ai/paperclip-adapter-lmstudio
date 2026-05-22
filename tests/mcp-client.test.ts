import { describe, it, expect } from "vitest";
import { encodeMcpToolName, decodeMcpToolName } from "../src/server/mcp-client.js";

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
