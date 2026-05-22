import { describe, it, expect, vi, beforeEach } from "vitest";
import { executePaperclipTool } from "../src/server/paperclip-tools.js";

const CTX = {
  apiUrl: "http://localhost:3100",
  authToken: "test-token",
  runId: "run-1",
  agentId: "agent-1",
  companyId: "company-1",
};

describe("executePaperclipTool", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("paperclip_get_identity calls /api/agents/me", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "agent-1", name: "CEO" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePaperclipTool("paperclip_get_identity", {}, CTX);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/agents/me",
      expect.objectContaining({
        headers: expect.objectContaining({ "Authorization": "Bearer test-token" }),
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("CEO");
  });

  it("paperclip_checkout_issue includes X-Paperclip-Run-Id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool("paperclip_checkout_issue", { issueId: "iss-1" }, CTX);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Paperclip-Run-Id"]).toBe("run-1");
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("paperclip_update_issue sends status and comment as PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool("paperclip_update_issue", {
      issueId: "iss-1",
      status: "done",
      comment: "Task completed",
    }, CTX);

    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("PATCH");
    const body = JSON.parse(call[1].body);
    expect(body.status).toBe("done");
    expect(body.comment).toBe("Task completed");
  });

  it("returns error on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: async () => "Already checked out",
    }));

    const result = await executePaperclipTool("paperclip_checkout_issue", { issueId: "iss-1" }, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("409");
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await executePaperclipTool("paperclip_get_identity", {}, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("paperclip_list_documents calls GET /api/issues/{id}/documents", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ key: "plan", title: "Plan" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePaperclipTool(
      "paperclip_list_documents",
      { issueId: "iss-1" },
      CTX,
    );

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("http://localhost:3100/api/issues/iss-1/documents");
    expect(call[1].method).toBe("GET");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("plan");
  });

  it("paperclip_put_document PUTs markdown body to /documents/{key} with run-id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "doc-1", key: "finanzplan", latestRevisionNumber: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePaperclipTool(
      "paperclip_put_document",
      {
        issueId: "iss-1",
        key: "finanzplan",
        title: "Finanzplan Q2",
        body: "# Finanzplan\n\nZahlen folgen.",
      },
      CTX,
    );

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("http://localhost:3100/api/issues/iss-1/documents/finanzplan");
    expect(call[1].method).toBe("PUT");
    expect(call[1].headers["X-Paperclip-Run-Id"]).toBe("run-1");
    const body = JSON.parse(call[1].body);
    expect(body.format).toBe("markdown");
    expect(body.body).toContain("Finanzplan");
    expect(body.title).toBe("Finanzplan Q2");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("finanzplan");
  });

  it("paperclip_put_document defaults format to markdown when omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "doc-1", key: "analyse" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool(
      "paperclip_put_document",
      { issueId: "iss-1", key: "analyse", body: "## Ergebnis" },
      CTX,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.format).toBe("markdown");
  });

  it("paperclip_put_document forwards baseRevisionId for optimistic concurrency", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "doc-1", key: "plan", latestRevisionNumber: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool(
      "paperclip_put_document",
      {
        issueId: "iss-1",
        key: "plan",
        body: "v2",
        baseRevisionId: "11111111-1111-1111-1111-111111111111",
      },
      CTX,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.baseRevisionId).toBe("11111111-1111-1111-1111-111111111111");
  });
});
