import { db } from "flingit";
import type { Hono } from "hono";
import {
  resolveTenantByBotToken,
  resolveTenantByClientId,
  resolveTenantByAccessToken,
  extractBotToken,
  extractBearerToken,
  requireJsonBody,
  requireFormBody,
  generateId,
} from "./helpers.js";

export function registerDiscordRoutes(app: Hono) {
  // 1.1 OAuth Authorize
  app.get("/oauth2/authorize", async (c) => {
    const clientId = c.req.query("client_id");
    if (!clientId) {
      return c.json({ error: "Unknown client_id" }, 400);
    }

    const tenant = await resolveTenantByClientId(clientId);
    if (!tenant) {
      return c.json({ error: "Unknown client_id" }, 400);
    }

    c.set("tenantId", tenant.id);
    const redirectUri = c.req.query("redirect_uri") || "";
    const state = c.req.query("state") || "";

    // Get first guild deterministically
    const firstGuild = await db
      .prepare(
        "SELECT id FROM guilds WHERE tenant_id = ? ORDER BY id ASC LIMIT 1"
      )
      .bind(tenant.id)
      .first();

    const guildId = firstGuild ? (firstGuild.id as string) : "";

    // Generate auth code
    const code = `fake-code-${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO auth_codes (code, tenant_id, guild_id, redirect_uri) VALUES (?, ?, ?, ?)"
      )
      .bind(code, tenant.id, guildId, redirectUri)
      .run();

    // Build redirect URL
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    url.searchParams.set("guild_id", guildId);

    return c.redirect(url.toString(), 302);
  });

  // 1.2 OAuth Token Exchange
  app.post("/api/v10/oauth2/token", async (c) => {
    const form = await requireFormBody(c);
    if (form instanceof Response) return form;

    const clientId = form.get("client_id") || "";
    const clientSecret = form.get("client_secret") || "";
    const code = form.get("code") || "";
    const redirectUri = form.get("redirect_uri") || "";

    const tenant = await resolveTenantByClientId(clientId);
    if (!tenant) {
      return c.json({ error: "invalid_client" }, 401);
    }

    if (tenant.client_secret !== clientSecret) {
      return c.json({ error: "invalid_client" }, 401);
    }

    c.set("tenantId", tenant.id);

    // Read auth code then delete it (one-time use)
    const authCode = await db
      .prepare(
        "SELECT code, guild_id, redirect_uri FROM auth_codes WHERE code = ? AND tenant_id = ?"
      )
      .bind(code, tenant.id)
      .first() as { code: string; guild_id: string; redirect_uri: string } | null;

    if (!authCode) {
      return c.json({ error: "invalid_grant" }, 401);
    }

    const deleteResult = await db
      .prepare("DELETE FROM auth_codes WHERE code = ? AND tenant_id = ?")
      .bind(code, tenant.id)
      .run();

    if (!deleteResult.meta.changes) {
      return c.json({ error: "invalid_grant" }, 401);
    }

    // Validate redirect_uri
    if (authCode.redirect_uri && authCode.redirect_uri !== redirectUri) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "redirect_uri mismatch",
        },
        400
      );
    }

    // Generate access token
    const accessToken = `fake-at-${tenant.id}-${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO access_tokens (token, tenant_id) VALUES (?, ?)"
      )
      .bind(accessToken, tenant.id)
      .run();

    // Look up guild name
    const guild = await db
      .prepare("SELECT id, name FROM guilds WHERE tenant_id = ? AND id = ?")
      .bind(tenant.id, authCode.guild_id)
      .first();

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 604800,
      refresh_token: `fake-rt-${crypto.randomUUID()}`,
      scope: "identify guilds bot applications.commands",
      guild: {
        id: authCode.guild_id,
        name: guild ? (guild.name as string) : "",
      },
    });
  });

  // 1.3 User Identity
  app.get("/api/v10/users/@me", async (c) => {
    const bearerToken = extractBearerToken(c);
    if (!bearerToken) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    const tenant = await resolveTenantByAccessToken(bearerToken);
    if (!tenant) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    c.set("tenantId", tenant.id);

    return c.json({
      id: `fake-user-${tenant.id}`,
      username: "fakeuser",
      global_name: `Fake User (${tenant.id})`,
      discriminator: "0",
    });
  });

  // 1.4 Get Channel
  app.get("/api/v10/channels/:channelId", async (c) => {
    const botToken = extractBotToken(c);
    if (!botToken) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    const tenant = await resolveTenantByBotToken(botToken);
    if (!tenant) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    c.set("tenantId", tenant.id);
    const channelId = c.req.param("channelId");
    const channel = await db
      .prepare(
        "SELECT id, guild_id, name FROM channels WHERE tenant_id = ? AND id = ?"
      )
      .bind(tenant.id, channelId)
      .first();

    if (!channel) {
      return c.json({ message: "Unknown Channel" }, 404);
    }

    return c.json({
      id: channel.id,
      guild_id: channel.guild_id,
      name: channel.name,
      type: 0,
    });
  });

  // 1.5 Send Message
  app.post("/api/v10/channels/:channelId/messages", async (c) => {
    const botToken = extractBotToken(c);
    if (!botToken) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    const tenant = await resolveTenantByBotToken(botToken);
    if (!tenant) {
      return c.json({ message: "401: Unauthorized" }, 401);
    }

    c.set("tenantId", tenant.id);
    const channelId = c.req.param("channelId");
    const channel = await db
      .prepare(
        "SELECT id FROM channels WHERE tenant_id = ? AND id = ?"
      )
      .bind(tenant.id, channelId)
      .first();

    if (!channel) {
      return c.json({ message: "Unknown Channel" }, 404);
    }

    const body = await requireJsonBody(c);
    if (body instanceof Response) return body;

    const messageId = await generateId(tenant.id, "msg");
    const now = new Date().toISOString();

    await db
      .prepare(
        "INSERT INTO messages (tenant_id, id, channel_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(tenant.id, messageId, channelId, JSON.stringify(body), now)
      .run();

    return c.json({
      id: messageId,
      channel_id: channelId,
      content: (body as Record<string, unknown>).content || "",
    });
  });

  // 1.6 Edit Message
  app.patch(
    "/api/v10/channels/:channelId/messages/:messageId",
    async (c) => {
      const botToken = extractBotToken(c);
      if (!botToken) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      const tenant = await resolveTenantByBotToken(botToken);
      if (!tenant) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      c.set("tenantId", tenant.id);
      const channelId = c.req.param("channelId");
      const messageId = c.req.param("messageId");

      const body = await requireJsonBody(c);
      if (body instanceof Response) return body;

      const now = new Date().toISOString();

      // Atomically copy old payload to edit history and update message in one batch
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO message_edits (tenant_id, message_id, payload, edited_at)
             SELECT tenant_id, id, payload, ?
             FROM messages WHERE tenant_id = ? AND id = ? AND channel_id = ?`
          )
          .bind(now, tenant.id, messageId, channelId),
        db
          .prepare(
            "UPDATE messages SET payload = ? WHERE tenant_id = ? AND id = ? AND channel_id = ?"
          )
          .bind(JSON.stringify(body), tenant.id, messageId, channelId),
      ]);

      // If the UPDATE affected 0 rows, the message doesn't exist
      if (!results[1].meta.changes) {
        return c.json({ message: "Unknown Message" }, 404);
      }

      return c.json({
        id: messageId,
        channel_id: channelId,
        content: (body as Record<string, unknown>).content || "",
      });
    }
  );

  // 1.7 Add Reaction
  app.put(
    "/api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me",
    async (c) => {
      const botToken = extractBotToken(c);
      if (!botToken) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      const tenant = await resolveTenantByBotToken(botToken);
      if (!tenant) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      c.set("tenantId", tenant.id);
      const channelId = c.req.param("channelId");
      const messageId = c.req.param("messageId");
      const emojiRaw = c.req.param("emoji");
      const emoji = decodeURIComponent(emojiRaw);

      // Validate channel exists
      const channel = await db
        .prepare(
          "SELECT id FROM channels WHERE tenant_id = ? AND id = ?"
        )
        .bind(tenant.id, channelId)
        .first();
      if (!channel) {
        return c.json({ message: "Unknown Channel" }, 404);
      }

      // Validate message exists
      const message = await db
        .prepare(
          "SELECT id FROM messages WHERE tenant_id = ? AND id = ? AND channel_id = ?"
        )
        .bind(tenant.id, messageId, channelId)
        .first();
      if (!message) {
        return c.json({ message: "Unknown Message" }, 404);
      }

      const now = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO reactions (tenant_id, channel_id, message_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(tenant.id, channelId, messageId, emoji, now)
        .run();

      return c.body(null, 204);
    }
  );

  // 1.8 Edit Interaction Response
  app.patch(
    "/api/v10/webhooks/:clientId/:interactionToken/messages/@original",
    async (c) => {
      const clientId = c.req.param("clientId");
      const interactionToken = c.req.param("interactionToken");

      const tenant = await resolveTenantByClientId(clientId);
      if (!tenant) {
        return c.json({ message: "Unknown Application" }, 404);
      }

      c.set("tenantId", tenant.id);
      const body = await requireJsonBody(c);
      if (body instanceof Response) return body;

      const responseId = await generateId(tenant.id, "resp");
      const now = new Date().toISOString();

      // Upsert: replace if exists for this token
      await db
        .prepare(
          `INSERT INTO interaction_responses (tenant_id, interaction_token, response_id, payload, responded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, interaction_token) DO UPDATE SET
             response_id = excluded.response_id,
             payload = excluded.payload,
             responded_at = excluded.responded_at`
        )
        .bind(
          tenant.id,
          interactionToken,
          responseId,
          JSON.stringify(body),
          now
        )
        .run();

      return c.json({
        id: responseId,
        content: (body as Record<string, unknown>).content || "",
      });
    }
  );

  // 1.9 Send Followup
  app.post(
    "/api/v10/webhooks/:clientId/:interactionToken",
    async (c) => {
      const clientId = c.req.param("clientId");
      const interactionToken = c.req.param("interactionToken");

      const tenant = await resolveTenantByClientId(clientId);
      if (!tenant) {
        return c.json({ message: "Unknown Application" }, 404);
      }

      c.set("tenantId", tenant.id);
      const body = await requireJsonBody(c);
      if (body instanceof Response) return body;

      const followupId = await generateId(tenant.id, "followup");
      const now = new Date().toISOString();

      await db
        .prepare(
          "INSERT INTO followups (tenant_id, id, interaction_token, payload, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(
          tenant.id,
          followupId,
          interactionToken,
          JSON.stringify(body),
          now
        )
        .run();

      return c.json({
        id: followupId,
        channel_id: "chan-followup",
        content: (body as Record<string, unknown>).content || "",
      });
    }
  );

  // 1.10 Bulk Overwrite Guild Commands
  app.put(
    "/api/v10/applications/:clientId/guilds/:guildId/commands",
    async (c) => {
      const botToken = extractBotToken(c);
      if (!botToken) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      const tenant = await resolveTenantByBotToken(botToken);
      if (!tenant) {
        return c.json({ message: "401: Unauthorized" }, 401);
      }

      c.set("tenantId", tenant.id);
      const clientId = c.req.param("clientId");
      const guildId = c.req.param("guildId");

      // Cross-check clientId
      if (tenant.client_id !== clientId) {
        return c.json({ message: "client_id mismatch" }, 400);
      }

      // Validate guild exists
      const guild = await db
        .prepare(
          "SELECT id FROM guilds WHERE tenant_id = ? AND id = ?"
        )
        .bind(tenant.id, guildId)
        .first();
      if (!guild) {
        return c.json({ message: "Unknown Guild" }, 404);
      }

      const body = await requireJsonBody(c);
      if (body instanceof Response) return body;

      const commands = body as unknown as Array<Record<string, unknown>>;
      const now = new Date().toISOString();

      // Build batch: delete old commands + insert new ones
      const stmts = [
        db
          .prepare(
            "DELETE FROM registered_commands WHERE tenant_id = ? AND guild_id = ?"
          )
          .bind(tenant.id, guildId),
      ];

      const responseCommands = [];

      for (const cmd of commands) {
        const cmdId = await generateId(tenant.id, "cmd");
        const cmdPayload = { ...cmd };
        stmts.push(
          db
            .prepare(
              "INSERT INTO registered_commands (tenant_id, id, guild_id, payload, registered_at) VALUES (?, ?, ?, ?, ?)"
            )
            .bind(
              tenant.id,
              cmdId,
              guildId,
              JSON.stringify(cmdPayload),
              now
            )
        );
        responseCommands.push({
          id: cmdId,
          ...cmdPayload,
          application_id: clientId,
          guild_id: guildId,
        });
      }

      await db.batch(stmts);

      return c.json(responseCommands);
    }
  );
}
