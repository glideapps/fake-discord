import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  API_BASE,
  createTestTenant,
  deleteTenant,
  fetchJson,
  type TestTenantConfig,
} from "./setup.js";

describe("Audit Logging", () => {
  let tenant: TestTenantConfig;

  beforeAll(async () => {
    tenant = await createTestTenant();
    // Reset to clear any audit logs from setup
    await fetchJson(`/_test/${tenant.tenantId}/reset`, { method: "POST" });
  });

  afterAll(async () => {
    await deleteTenant(tenant.tenantId);
  });

  it("records audit trail for Discord API calls", async () => {
    // Make a Discord API call
    await fetch(`${API_BASE}/api/v10/channels/${tenant.channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${tenant.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "audit test message" }),
    });

    // Check audit logs
    const { status, body } = await fetchJson(
      `/_test/${tenant.tenantId}/audit-logs`
    );
    expect(status).toBe(200);
    const data = body as {
      logs: Array<{
        id: number;
        tenantId: string;
        method: string;
        url: string;
        requestBody: unknown;
        responseStatus: number;
        responseBody: unknown;
        createdAt: string;
      }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(data.total).toBeGreaterThanOrEqual(1);

    // Find the POST message log entry
    const postLog = data.logs.find(
      (l) => l.method === "POST" && l.url.includes("/messages")
    );
    expect(postLog).toBeDefined();
    expect(postLog!.responseStatus).toBe(200);
    expect(postLog!.tenantId).toBe(tenant.tenantId);
    expect(postLog!.requestBody).toEqual({ content: "audit test message" });
    expect(postLog!.createdAt).toBeTruthy();
  });

  it("logs include correct tenant association", async () => {
    // Make a bot-token-authenticated call
    await fetch(`${API_BASE}/api/v10/channels/${tenant.channelId}`, {
      headers: {
        Authorization: `Bot ${tenant.botToken}`,
      },
    });

    const { body } = await fetchJson(
      `/_test/${tenant.tenantId}/audit-logs`
    );
    const data = body as {
      logs: Array<{ tenantId: string; method: string; url: string }>;
    };

    const getLog = data.logs.find(
      (l) => l.method === "GET" && l.url.includes(`/channels/${tenant.channelId}`) && !l.url.includes("audit-logs")
    );
    expect(getLog).toBeDefined();
    expect(getLog!.tenantId).toBe(tenant.tenantId);
  });

  it("failed auth logs have null tenant in global logs", async () => {
    // Make a call with an invalid bot token
    await fetch(`${API_BASE}/api/v10/channels/fake-chan`, {
      headers: {
        Authorization: "Bot invalid-token-for-audit-test",
      },
    });

    const { body } = await fetchJson("/_test/browse/audit-logs?limit=50");
    const data = body as {
      logs: Array<{
        tenantId: string | null;
        method: string;
        url: string;
        responseStatus: number;
      }>;
    };

    const failedLog = data.logs.find(
      (l) =>
        l.method === "GET" &&
        l.url.includes("/channels/fake-chan") &&
        l.responseStatus === 401
    );
    expect(failedLog).toBeDefined();
    expect(failedLog!.tenantId).toBeNull();
  });

  it("pagination works on per-tenant audit logs", async () => {
    // Make a few more calls to ensure enough logs
    for (let i = 0; i < 3; i++) {
      await fetch(`${API_BASE}/api/v10/channels/${tenant.channelId}`, {
        headers: { Authorization: `Bot ${tenant.botToken}` },
      });
    }

    // Get with limit=2
    const { body: pageBody } = await fetchJson(
      `/_test/${tenant.tenantId}/audit-logs?limit=2&offset=0`
    );
    const pageData = pageBody as {
      logs: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(pageData.logs.length).toBe(2);
    expect(pageData.limit).toBe(2);
    expect(pageData.offset).toBe(0);
    expect(pageData.total).toBeGreaterThanOrEqual(4);

    // Get page 2
    const { body: page2Body } = await fetchJson(
      `/_test/${tenant.tenantId}/audit-logs?limit=2&offset=2`
    );
    const page2Data = page2Body as { logs: unknown[]; offset: number };
    expect(page2Data.logs.length).toBeGreaterThanOrEqual(1);
    expect(page2Data.offset).toBe(2);
  });

  it("logs are deleted when tenant is deleted", async () => {
    const tmpTenant = await createTestTenant();

    // Make a call
    await fetch(`${API_BASE}/api/v10/channels/${tmpTenant.channelId}`, {
      headers: { Authorization: `Bot ${tmpTenant.botToken}` },
    });

    // Verify log exists
    const { body: before } = await fetchJson(
      `/_test/${tmpTenant.tenantId}/audit-logs`
    );
    expect((before as { total: number }).total).toBeGreaterThanOrEqual(1);

    // Delete tenant
    await deleteTenant(tmpTenant.tenantId);

    // Verify pre-existing logs are gone from global endpoint.
    // The DELETE request itself generates one last audit log entry
    // (middleware runs after handler), so we allow at most 1 remaining.
    const { body: after } = await fetchJson("/_test/browse/audit-logs?limit=1000");
    const afterData = after as {
      logs: Array<{ tenantId: string | null; method: string }>;
    };
    const remaining = afterData.logs.filter(
      (l) => l.tenantId === tmpTenant.tenantId
    );
    expect(remaining.length).toBeLessThanOrEqual(1);
    if (remaining.length === 1) {
      expect(remaining[0].method).toBe("DELETE");
    }
  });

  it("logs are cleared on reset", async () => {
    const tmpTenant = await createTestTenant();

    // Make some API calls
    await fetch(`${API_BASE}/api/v10/channels/${tmpTenant.channelId}`, {
      headers: { Authorization: `Bot ${tmpTenant.botToken}` },
    });

    // Verify logs exist
    const { body: before } = await fetchJson(
      `/_test/${tmpTenant.tenantId}/audit-logs`
    );
    expect((before as { total: number }).total).toBeGreaterThanOrEqual(1);

    // Reset
    await fetchJson(`/_test/${tmpTenant.tenantId}/reset`, { method: "POST" });

    // Verify pre-reset API logs are cleared.
    // The reset POST itself may generate a new audit entry, but
    // none of the pre-reset /api/ channel GET logs should remain.
    const { body: after } = await fetchJson(
      `/_test/${tmpTenant.tenantId}/audit-logs`
    );
    const afterData = after as {
      logs: Array<{ url: string }>;
      total: number;
    };
    const channelLogs = afterData.logs.filter(
      (l) => l.url.includes(`/api/v10/channels/${tmpTenant.channelId}`)
    );
    expect(channelLogs.length).toBe(0);

    await deleteTenant(tmpTenant.tenantId);
  });

  it("browse state includes auditLogs array", async () => {
    const { status, body } = await fetchJson(
      `/_test/browse/tenants/${tenant.tenantId}/state`
    );
    expect(status).toBe(200);
    const data = body as { auditLogs: unknown[] };
    expect(Array.isArray(data.auditLogs)).toBe(true);
  });

  it("browse tenant list includes createdAt and logCount", async () => {
    const { status, body } = await fetchJson("/_test/browse/tenants");
    expect(status).toBe(200);
    const data = body as {
      tenants: Array<{
        id: string;
        createdAt: string;
        logCount: number;
      }>;
    };
    const t = data.tenants.find((t) => t.id === tenant.tenantId);
    expect(t).toBeDefined();
    expect(t!.createdAt).toBeTruthy();
    expect(typeof t!.logCount).toBe("number");
  });

  it("browse tenant detail includes createdAt and logCount", async () => {
    const { status, body } = await fetchJson(
      `/_test/browse/tenants/${tenant.tenantId}`
    );
    expect(status).toBe(200);
    const data = body as {
      tenant: { createdAt: string; logCount: number };
    };
    expect(data.tenant.createdAt).toBeTruthy();
    expect(typeof data.tenant.logCount).toBe("number");
  });

  it("global browse audit-logs endpoint works with pagination", async () => {
    const { status, body } = await fetchJson(
      "/_test/browse/audit-logs?limit=5&offset=0"
    );
    expect(status).toBe(200);
    const data = body as {
      logs: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(data.limit).toBe(5);
    expect(data.offset).toBe(0);
    expect(typeof data.total).toBe("number");
    expect(Array.isArray(data.logs)).toBe(true);
  });
});
