import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTenant,
  deleteTenant,
  fetchJson,
  type TestTenantConfig,
} from "./setup.js";

describe("Cron Cleanup & Tenant Expiry", () => {
  const tenantsToClean: string[] = [];

  afterAll(async () => {
    for (const id of tenantsToClean) {
      await deleteTenant(id);
    }
  });

  it("tenant has createdAt after creation", async () => {
    const tenant = await createTestTenant();
    tenantsToClean.push(tenant.tenantId);

    const { status, body } = await fetchJson(
      `/_test/browse/tenants/${tenant.tenantId}`
    );
    expect(status).toBe(200);
    const data = body as {
      tenant: { createdAt: string };
    };
    expect(data.tenant.createdAt).toBeTruthy();
    // Should be a valid ISO 8601 date
    const parsed = new Date(data.tenant.createdAt);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("createdAt is recent (within 30 seconds of now)", async () => {
    const tenant = await createTestTenant();
    tenantsToClean.push(tenant.tenantId);

    const { body } = await fetchJson(
      `/_test/browse/tenants/${tenant.tenantId}`
    );
    const data = body as {
      tenant: { createdAt: string };
    };
    const createdAt = new Date(data.tenant.createdAt).getTime();
    const now = Date.now();
    const diffMs = Math.abs(now - createdAt);
    expect(diffMs).toBeLessThan(30000); // within 30 seconds
  });

  it("createdAt appears in tenant list", async () => {
    const tenant = await createTestTenant();
    tenantsToClean.push(tenant.tenantId);

    const { body } = await fetchJson("/_test/browse/tenants");
    const data = body as {
      tenants: Array<{ id: string; createdAt: string }>;
    };
    const found = data.tenants.find((t) => t.id === tenant.tenantId);
    expect(found).toBeDefined();
    expect(found!.createdAt).toBeTruthy();
    const parsed = new Date(found!.createdAt);
    expect(parsed.getTime()).not.toBeNaN();
  });
});
