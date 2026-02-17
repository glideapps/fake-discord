import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  API_BASE,
  createTestTenant,
  deleteTenant,
  fetchJson,
  TEST_PUBLIC_KEY,
  TEST_PRIVATE_KEY,
  type TestTenantConfig,
} from "./setup.js";

describe("Test Control Endpoints", () => {
  // 2.1 Create Tenant
  describe("POST /_test/tenants", () => {
    let tenantId: string;

    afterAll(async () => {
      if (tenantId) await deleteTenant(tenantId);
    });

    it("creates a tenant successfully (201)", async () => {
      const config = await createTestTenant();
      tenantId = config.tenantId;
      expect(config.tenantId).toBeTruthy();
      expect(config.botToken).toBeTruthy();
    });

    it("returns 400 for missing fields", async () => {
      const { status, body } = await fetchJson("/_test/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: "x" }),
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/Missing required field/);
    });

    it("returns 409 for duplicate botToken", async () => {
      const config = await createTestTenant();
      const dupTenantId = config.tenantId;

      const { status, body } = await fetchJson("/_test/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: config.botToken,
          clientId: "unique-client-dup-test",
          clientSecret: "s",
          publicKey: TEST_PUBLIC_KEY,
          privateKey: TEST_PRIVATE_KEY,
          guilds: {
            "g1": { name: "G", channels: { "c1": { name: "C" } } },
          },
        }),
      });
      expect(status).toBe(409);
      expect((body as { error: string }).error).toBe("botToken already in use");

      await deleteTenant(dupTenantId);
    });

    it("handles concurrent create with same botToken (one 201, one 409)", async () => {
      const sharedBotToken = `concurrent-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const makeBody = (idx: number) =>
        JSON.stringify({
          botToken: sharedBotToken,
          clientId: `concurrent-client-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          clientSecret: "s",
          publicKey: TEST_PUBLIC_KEY,
          privateKey: TEST_PRIVATE_KEY,
          guilds: {
            [`g-${idx}`]: { name: "G", channels: { [`c-${idx}`]: { name: "C" } } },
          },
        });

      const [resp1, resp2] = await Promise.all([
        fetchJson("/_test/tenants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: makeBody(1),
        }),
        fetchJson("/_test/tenants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: makeBody(2),
        }),
      ]);

      const statuses = [resp1.status, resp2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Clean up the one that succeeded
      const winner = resp1.status === 201 ? resp1 : resp2;
      await deleteTenant((winner.body as { tenantId: string }).tenantId);
    });

    it("returns 409 for duplicate clientId", async () => {
      const config = await createTestTenant();
      const dupTenantId = config.tenantId;

      const { status, body } = await fetchJson("/_test/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: "unique-bot-dup-test",
          clientId: config.clientId,
          clientSecret: "s",
          publicKey: TEST_PUBLIC_KEY,
          privateKey: TEST_PRIVATE_KEY,
          guilds: {
            "g1": { name: "G", channels: { "c1": { name: "C" } } },
          },
        }),
      });
      expect(status).toBe(409);
      expect((body as { error: string }).error).toBe("clientId already in use");

      await deleteTenant(dupTenantId);
    });
  });

  // 2.2 Delete Tenant
  describe("DELETE /_test/tenants/:tenantId", () => {
    it("deletes a tenant successfully", async () => {
      const config = await createTestTenant();
      const { status, body } = await fetchJson(
        `/_test/tenants/${config.tenantId}`,
        { method: "DELETE" }
      );
      expect(status).toBe(200);
      expect((body as { deleted: boolean }).deleted).toBe(true);
    });

    it("returns 404 for unknown tenant", async () => {
      const { status } = await fetchJson(
        "/_test/tenants/nonexistent-tenant-id",
        { method: "DELETE" }
      );
      expect(status).toBe(404);
    });
  });

  // 2.3 Get Messages
  describe("GET /_test/:tenantId/messages/:channelId", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns empty messages for a channel with none", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/messages/${t.channelId}`
      );
      expect(status).toBe(200);
      expect((body as { messages: unknown[] }).messages).toEqual([]);
    });

    it("returns messages after sending some", async () => {
      // Send a message via the Discord API
      await fetch(`${API_BASE}/api/v10/channels/${t.channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${t.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Hello!" }),
      });

      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/messages/${t.channelId}`
      );
      expect(status).toBe(200);
      const msgs = (body as { messages: Array<{ payload: { content: string }; editHistory: unknown[] }> }).messages;
      expect(msgs.length).toBe(1);
      expect(msgs[0].payload.content).toBe("Hello!");
      expect(msgs[0].editHistory).toEqual([]);
    });

    it("includes edit history after editing a message", async () => {
      // Send a message
      const sendResp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Original" }),
        }
      );
      const sendData = (await sendResp.json()) as { id: string };

      // Edit the message
      await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/${sendData.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Edited" }),
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/messages/${t.channelId}`
      );
      const msgs = (body as { messages: Array<{ id: string; payload: { content: string }; editHistory: Array<{ payload: { content: string } }> }> }).messages;
      const editedMsg = msgs.find((m) => m.id === sendData.id)!;
      expect(editedMsg.payload.content).toBe("Edited");
      expect(editedMsg.editHistory.length).toBe(1);
      expect(editedMsg.editHistory[0].payload.content).toBe("Original");
    });

    it("returns 404 for unknown tenant", async () => {
      const { status } = await fetchJson(
        "/_test/nonexistent/messages/some-channel"
      );
      expect(status).toBe(404);
    });
  });

  // 2.4 Get Reactions
  describe("GET /_test/:tenantId/reactions", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns empty reactions initially", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/reactions`
      );
      expect(status).toBe(200);
      expect((body as { reactions: unknown[] }).reactions).toEqual([]);
    });

    it("returns reactions after adding some", async () => {
      // Send a message first
      const sendResp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "React to me" }),
        }
      );
      const sendData = (await sendResp.json()) as { id: string };

      // Add a reaction
      await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/${sendData.id}/reactions/%E2%9C%85/@me`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${t.botToken}` },
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/reactions`
      );
      const reactions = (body as { reactions: Array<{ emoji: string; messageId: string }> }).reactions;
      expect(reactions.length).toBe(1);
      expect(reactions[0].emoji).toBe("\u2705");
      expect(reactions[0].messageId).toBe(sendData.id);
    });
  });

  // 2.5 Get Interaction Response
  describe("GET /_test/:tenantId/interaction-responses/:token", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns 404 for unknown token", async () => {
      const { status } = await fetchJson(
        `/_test/${t.tenantId}/interaction-responses/unknown-token`
      );
      expect(status).toBe(404);
    });

    it("returns response after edit-interaction-response", async () => {
      const token = "test-interaction-token-1";
      await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Pong!", flags: 64 }),
        }
      );

      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/interaction-responses/${token}`
      );
      expect(status).toBe(200);
      const data = body as { payload: { content: string; flags: number }; respondedAt: string };
      expect(data.payload.content).toBe("Pong!");
      expect(data.payload.flags).toBe(64);
      expect(data.respondedAt).toBeTruthy();
    });
  });

  // 2.6 Get Followups
  describe("GET /_test/:tenantId/followups/:token", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns empty followups for unknown token", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/followups/unknown-token`
      );
      expect(status).toBe(200);
      expect((body as { followups: unknown[] }).followups).toEqual([]);
    });

    it("returns followups after sending some", async () => {
      const token = "followup-test-token";
      await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Followup 1" }),
        }
      );
      await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Followup 2" }),
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/followups/${token}`
      );
      const followups = (body as { followups: Array<{ payload: { content: string } }> }).followups;
      expect(followups.length).toBe(2);
      expect(followups[0].payload.content).toBe("Followup 1");
      expect(followups[1].payload.content).toBe("Followup 2");
    });
  });

  // 2.7 Get Registered Commands
  describe("GET /_test/:tenantId/commands/:guildId", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns empty commands initially", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/commands/${t.guildId}`
      );
      expect(status).toBe(200);
      expect((body as { commands: unknown[] }).commands).toEqual([]);
    });

    it("returns commands after bulk overwrite", async () => {
      await fetch(
        `${API_BASE}/api/v10/applications/${t.clientId}/guilds/${t.guildId}/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            { name: "ping", description: "Ping the bot", type: 1 },
            { name: "help", description: "Show help", type: 1 },
          ]),
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/commands/${t.guildId}`
      );
      const cmds = (body as { commands: Array<{ name: string }> }).commands;
      expect(cmds.length).toBe(2);
      expect(cmds.map((c) => c.name).sort()).toEqual(["help", "ping"]);
    });
  });

  // 2.8 Reset Tenant State
  describe("POST /_test/:tenantId/reset", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("clears mutable state but preserves config", async () => {
      // Send a message
      await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Before reset" }),
        }
      );

      // Reset
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/reset`,
        { method: "POST" }
      );
      expect(status).toBe(200);
      expect((body as { reset: boolean }).reset).toBe(true);

      // Messages should be cleared
      const { body: msgBody } = await fetchJson(
        `/_test/${t.tenantId}/messages/${t.channelId}`
      );
      expect((msgBody as { messages: unknown[] }).messages).toEqual([]);

      // But channel should still work (config preserved)
      const channelResp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}`,
        { headers: { Authorization: `Bot ${t.botToken}` } }
      );
      expect(channelResp.status).toBe(200);
    });

    it("resets ID counter", async () => {
      // Send a message — should get msg-1 after reset
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "After reset" }),
        }
      );
      const data = (await resp.json()) as { id: string };
      expect(data.id).toBe("msg-1");
    });

    it("returns 404 for unknown tenant", async () => {
      const { status } = await fetchJson("/_test/nonexistent/reset", {
        method: "POST",
      });
      expect(status).toBe(404);
    });
  });

  // 2.9 Create Authorization Code
  describe("POST /_test/:tenantId/auth-code", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("creates an auth code successfully", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guildId: t.guildId,
            redirectUri: "https://example.com/callback",
          }),
        }
      );
      expect(status).toBe(200);
      const data = body as { code: string; guildId: string };
      expect(data.code).toBeTruthy();
      expect(data.guildId).toBe(t.guildId);
    });

    it("returns 400 for unknown guild", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guildId: "nonexistent-guild",
            redirectUri: "https://example.com/callback",
          }),
        }
      );
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/Unknown guild/);
    });

    it("returns 404 for unknown tenant", async () => {
      const { status } = await fetchJson(
        "/_test/nonexistent/auth-code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guildId: "g1",
            redirectUri: "https://example.com/callback",
          }),
        }
      );
      expect(status).toBe(404);
    });
  });

  // 2.10 Send Signed Interaction
  describe("POST /_test/:tenantId/send-interaction", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns 400 for missing webhookUrl", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/send-interaction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interaction: { type: 1 } }),
        }
      );
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/webhookUrl/);
    });

    it("returns 400 for missing interaction", async () => {
      const { status, body } = await fetchJson(
        `/_test/${t.tenantId}/send-interaction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            webhookUrl: "https://example.com/webhook",
          }),
        }
      );
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/interaction/);
    });

    it("returns 404 for unknown tenant", async () => {
      const { status } = await fetchJson(
        "/_test/nonexistent/send-interaction",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            webhookUrl: "https://example.com/webhook",
            interaction: { type: 1 },
          }),
        }
      );
      expect(status).toBe(404);
    });
  });
});
