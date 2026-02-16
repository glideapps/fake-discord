import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  API_BASE,
  createTestTenant,
  deleteTenant,
  fetchJson,
  type TestTenantConfig,
} from "./setup.js";

describe("Discord API Endpoints", () => {
  // 1.1 OAuth Authorize
  describe("GET /oauth2/authorize", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("redirects with code and state (302)", async () => {
      const redirectUri = "https://example.com/callback";
      const state = "test-state-123";
      const url = `${API_BASE}/oauth2/authorize?client_id=${t.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;

      const resp = await fetch(url, { redirect: "manual" });
      expect(resp.status).toBe(302);

      const location = resp.headers.get("Location")!;
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get("state")).toBe(state);
      expect(redirectUrl.searchParams.get("code")).toBeTruthy();
      expect(redirectUrl.searchParams.get("guild_id")).toBe(t.guildId);
    });

    it("returns 400 for unknown client_id", async () => {
      const { status } = await fetchJson(
        "/oauth2/authorize?client_id=nonexistent"
      );
      expect(status).toBe(400);
    });
  });

  // 1.2 OAuth Token Exchange
  describe("POST /api/v10/oauth2/token", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("exchanges auth code for access token (full flow)", async () => {
      const redirectUri = "https://example.com/callback";

      // Create auth code via test control
      const { body: codeBody } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guildId: t.guildId, redirectUri }),
        }
      );
      const code = (codeBody as { code: string }).code;

      // Exchange code for token
      const resp = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: t.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as {
        access_token: string;
        token_type: string;
        guild: { id: string; name: string };
      };
      expect(data.access_token).toBeTruthy();
      expect(data.token_type).toBe("Bearer");
      expect(data.guild.id).toBe(t.guildId);
      expect(data.guild.name).toBe("Test Guild");
    });

    it("returns 401 for wrong client_secret", async () => {
      const { body: codeBody } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guildId: t.guildId,
            redirectUri: "https://example.com/cb",
          }),
        }
      );
      const code = (codeBody as { code: string }).code;

      const resp = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: "wrong-secret",
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.com/cb",
        }).toString(),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 401 for invalid code", async () => {
      const resp = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: t.clientSecret,
          grant_type: "authorization_code",
          code: "nonexistent-code",
          redirect_uri: "https://example.com/cb",
        }).toString(),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 400 for redirect_uri mismatch", async () => {
      const { body: codeBody } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guildId: t.guildId,
            redirectUri: "https://example.com/correct",
          }),
        }
      );
      const code = (codeBody as { code: string }).code;

      const resp = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: t.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://example.com/wrong",
        }).toString(),
      });
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as { error: string; error_description: string };
      expect(data.error).toBe("invalid_request");
      expect(data.error_description).toBe("redirect_uri mismatch");
    });

    it("returns 401 for code replay (one-time use)", async () => {
      const redirectUri = "https://example.com/replay-test";
      const { body: codeBody } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guildId: t.guildId, redirectUri }),
        }
      );
      const code = (codeBody as { code: string }).code;

      // First use — should succeed
      const params = new URLSearchParams({
        client_id: t.clientId,
        client_secret: t.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString();

      const resp1 = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
      expect(resp1.status).toBe(200);

      // Second use — should fail
      const resp2 = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
      expect(resp2.status).toBe(401);
    });
  });

  // 1.3 User Identity
  describe("GET /api/v10/users/@me", () => {
    let t: TestTenantConfig;
    let accessToken: string;

    beforeAll(async () => {
      t = await createTestTenant();

      // Get an access token through the OAuth flow
      const redirectUri = "https://example.com/cb";
      const { body: codeBody } = await fetchJson(
        `/_test/${t.tenantId}/auth-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guildId: t.guildId, redirectUri }),
        }
      );
      const code = (codeBody as { code: string }).code;

      const tokenResp = await fetch(`${API_BASE}/api/v10/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: t.clientId,
          client_secret: t.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      const tokenData = (await tokenResp.json()) as { access_token: string };
      accessToken = tokenData.access_token;
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns fake user with valid token", async () => {
      const { status, body } = await fetchJson("/api/v10/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(status).toBe(200);
      const data = body as { id: string; username: string; global_name: string };
      expect(data.id).toBe(`fake-user-${t.tenantId}`);
      expect(data.username).toBe("fakeuser");
      expect(data.global_name).toContain(t.tenantId);
    });

    it("returns 401 for missing auth", async () => {
      const { status } = await fetchJson("/api/v10/users/@me");
      expect(status).toBe(401);
    });

    it("returns 401 for invalid token", async () => {
      const { status } = await fetchJson("/api/v10/users/@me", {
        headers: { Authorization: "Bearer invalid-token" },
      });
      expect(status).toBe(401);
    });
  });

  // 1.4 Get Channel
  describe("GET /api/v10/channels/:channelId", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("returns channel info", async () => {
      const { status, body } = await fetchJson(
        `/api/v10/channels/${t.channelId}`,
        { headers: { Authorization: `Bot ${t.botToken}` } }
      );
      expect(status).toBe(200);
      const data = body as { id: string; name: string; type: number; guild_id: string };
      expect(data.id).toBe(t.channelId);
      expect(data.name).toBe("general");
      expect(data.type).toBe(0);
      expect(data.guild_id).toBe(t.guildId);
    });

    it("returns 404 for unknown channel", async () => {
      const { status } = await fetchJson(
        "/api/v10/channels/nonexistent-channel",
        { headers: { Authorization: `Bot ${t.botToken}` } }
      );
      expect(status).toBe(404);
    });

    it("returns 401 for invalid bot token", async () => {
      const { status } = await fetchJson(
        `/api/v10/channels/${t.channelId}`,
        { headers: { Authorization: "Bot invalid-token" } }
      );
      expect(status).toBe(401);
    });
  });

  // 1.5 Send Message
  describe("POST /api/v10/channels/:channelId/messages", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("sends a message successfully", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Test message" }),
        }
      );
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { id: string; channel_id: string; content: string };
      expect(data.id).toMatch(/^msg-/);
      expect(data.channel_id).toBe(t.channelId);
      expect(data.content).toBe("Test message");
    });

    it("returns 404 for unknown channel", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/nonexistent/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Test" }),
        }
      );
      expect(resp.status).toBe(404);
    });

    it("returns 401 for invalid auth", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: "Bot invalid",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Test" }),
        }
      );
      expect(resp.status).toBe(401);
    });

    it("returns 400 for invalid JSON", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: "not json",
        }
      );
      expect(resp.status).toBe(400);
    });
  });

  // 1.6 Edit Message
  describe("PATCH /api/v10/channels/:channelId/messages/:messageId", () => {
    let t: TestTenantConfig;
    let messageId: string;

    beforeAll(async () => {
      t = await createTestTenant();
      const resp = await fetch(
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
      const data = (await resp.json()) as { id: string };
      messageId = data.id;
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("edits a message successfully", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Edited" }),
        }
      );
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { id: string; content: string };
      expect(data.id).toBe(messageId);
      expect(data.content).toBe("Edited");
    });

    it("returns 404 for unknown message", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/nonexistent`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Edit" }),
        }
      );
      expect(resp.status).toBe(404);
    });
  });

  // 1.7 Add Reaction
  describe("PUT /api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me", () => {
    let t: TestTenantConfig;
    let messageId: string;

    beforeAll(async () => {
      t = await createTestTenant();
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "React to this" }),
        }
      );
      const data = (await resp.json()) as { id: string };
      messageId = data.id;
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("adds a reaction (204)", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/${messageId}/reactions/%E2%9C%85/@me`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${t.botToken}` },
        }
      );
      expect(resp.status).toBe(204);
    });

    it("handles URL-encoded emoji", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/${messageId}/reactions/%F0%9F%91%8D/@me`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${t.botToken}` },
        }
      );
      expect(resp.status).toBe(204);

      // Verify the decoded emoji was stored
      const { body } = await fetchJson(
        `/_test/${t.tenantId}/reactions`
      );
      const reactions = (body as { reactions: Array<{ emoji: string }> }).reactions;
      const thumbsUp = reactions.find((r) => r.emoji === "\u{1F44D}");
      expect(thumbsUp).toBeTruthy();
    });

    it("returns 404 for unknown message", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/channels/${t.channelId}/messages/nonexistent/reactions/%E2%9C%85/@me`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${t.botToken}` },
        }
      );
      expect(resp.status).toBe(404);
    });
  });

  // 1.8 Edit Interaction Response
  describe("PATCH /api/v10/webhooks/:clientId/:interactionToken/messages/@original", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("stores interaction response", async () => {
      const token = "ir-test-token-1";
      const resp = await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Response!" }),
        }
      );
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { id: string; content: string };
      expect(data.id).toMatch(/^resp-/);
      expect(data.content).toBe("Response!");
    });

    it("returns 404 for unknown application", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/webhooks/nonexistent/token/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Test" }),
        }
      );
      expect(resp.status).toBe(404);
    });
  });

  // 1.9 Send Followup
  describe("POST /api/v10/webhooks/:clientId/:interactionToken", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("sends a followup message", async () => {
      const token = "followup-api-test";
      const resp = await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Followup!" }),
        }
      );
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { id: string; content: string; channel_id: string };
      expect(data.id).toMatch(/^followup-/);
      expect(data.content).toBe("Followup!");
      expect(data.channel_id).toBe("chan-followup");
    });

    it("allows multiple followups for the same token", async () => {
      const token = "multi-followup-test";
      await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "First" }),
        }
      );
      await fetch(
        `${API_BASE}/api/v10/webhooks/${t.clientId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Second" }),
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/followups/${token}`
      );
      const followups = (body as { followups: Array<{ payload: { content: string } }> }).followups;
      expect(followups.length).toBe(2);
    });
  });

  // 1.10 Bulk Overwrite Guild Commands
  describe("PUT /api/v10/applications/:clientId/guilds/:guildId/commands", () => {
    let t: TestTenantConfig;

    beforeAll(async () => {
      t = await createTestTenant();
    });
    afterAll(async () => {
      await deleteTenant(t.tenantId);
    });

    it("registers commands successfully", async () => {
      const commands = [
        { name: "ping", description: "Ping", type: 1 },
        { name: "help", description: "Help", type: 1, options: [] },
      ];

      const resp = await fetch(
        `${API_BASE}/api/v10/applications/${t.clientId}/guilds/${t.guildId}/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(commands),
        }
      );
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as Array<{
        id: string;
        name: string;
        application_id: string;
        guild_id: string;
      }>;
      expect(data.length).toBe(2);
      expect(data[0].id).toMatch(/^cmd-/);
      expect(data[0].application_id).toBe(t.clientId);
      expect(data[0].guild_id).toBe(t.guildId);
    });

    it("replaces existing commands", async () => {
      // First overwrite
      await fetch(
        `${API_BASE}/api/v10/applications/${t.clientId}/guilds/${t.guildId}/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            { name: "old", description: "Old command", type: 1 },
          ]),
        }
      );

      // Second overwrite
      await fetch(
        `${API_BASE}/api/v10/applications/${t.clientId}/guilds/${t.guildId}/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            { name: "new", description: "New command", type: 1 },
          ]),
        }
      );

      const { body } = await fetchJson(
        `/_test/${t.tenantId}/commands/${t.guildId}`
      );
      const cmds = (body as { commands: Array<{ name: string }> }).commands;
      expect(cmds.length).toBe(1);
      expect(cmds[0].name).toBe("new");
    });

    it("returns 400 for client_id mismatch", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/applications/wrong-client/guilds/${t.guildId}/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([]),
        }
      );
      expect(resp.status).toBe(400);
    });

    it("returns 404 for unknown guild", async () => {
      const resp = await fetch(
        `${API_BASE}/api/v10/applications/${t.clientId}/guilds/nonexistent/commands`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${t.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([]),
        }
      );
      expect(resp.status).toBe(404);
    });
  });
});
