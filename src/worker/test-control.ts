import { db } from "flingit";
import type { Hono } from "hono";
import {
  resolveTenantById,
  requireJsonBody,
  signPayload,
} from "./helpers.js";

export function registerTestRoutes(app: Hono) {
  // Browse API: List all tenants with counts
  app.get("/_test/browse/tenants", async (c) => {
    const { results: tenants } = await db
      .prepare("SELECT id, bot_token, client_id, client_secret, public_key, next_id FROM tenants ORDER BY id")
      .all();

    const { results: guildCounts } = await db
      .prepare("SELECT tenant_id, COUNT(*) as cnt FROM guilds GROUP BY tenant_id")
      .all();

    const { results: channelCounts } = await db
      .prepare("SELECT tenant_id, COUNT(*) as cnt FROM channels GROUP BY tenant_id")
      .all();

    const guildMap = new Map(guildCounts.map((r) => [r.tenant_id as string, r.cnt as number]));
    const channelMap = new Map(channelCounts.map((r) => [r.tenant_id as string, r.cnt as number]));

    return c.json({
      tenants: tenants.map((t) => ({
        id: t.id as string,
        botToken: t.bot_token as string,
        clientId: t.client_id as string,
        clientSecret: t.client_secret as string,
        publicKey: t.public_key as string,
        nextId: t.next_id as number,
        guildCount: guildMap.get(t.id as string) || 0,
        channelCount: channelMap.get(t.id as string) || 0,
      })),
    });
  });

  // Browse API: Tenant detail with guilds and channels
  app.get("/_test/browse/tenants/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await db
      .prepare("SELECT id, bot_token, client_id, client_secret, public_key, next_id FROM tenants WHERE id = ?")
      .bind(tenantId)
      .first();
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results: guilds } = await db
      .prepare("SELECT id, name FROM guilds WHERE tenant_id = ? ORDER BY id")
      .bind(tenantId)
      .all();

    const { results: channels } = await db
      .prepare("SELECT guild_id, id, name FROM channels WHERE tenant_id = ? ORDER BY id")
      .bind(tenantId)
      .all();

    const channelsByGuild = new Map<string, Array<{ id: string; name: string }>>();
    for (const ch of channels) {
      const gid = ch.guild_id as string;
      if (!channelsByGuild.has(gid)) channelsByGuild.set(gid, []);
      channelsByGuild.get(gid)!.push({ id: ch.id as string, name: ch.name as string });
    }

    return c.json({
      tenant: {
        id: tenant.id as string,
        botToken: tenant.bot_token as string,
        clientId: tenant.client_id as string,
        clientSecret: tenant.client_secret as string,
        publicKey: tenant.public_key as string,
        nextId: tenant.next_id as number,
      },
      guilds: guilds.map((g) => ({
        id: g.id as string,
        name: g.name as string,
        channels: channelsByGuild.get(g.id as string) || [],
      })),
    });
  });

  // Browse API: Full mutable state for a tenant
  app.get("/_test/browse/tenants/:tenantId/state", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await db
      .prepare("SELECT id FROM tenants WHERE id = ?")
      .bind(tenantId)
      .first();
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results: msgRows } = await db
      .prepare("SELECT id, channel_id, payload, created_at FROM messages WHERE tenant_id = ? ORDER BY created_at ASC")
      .bind(tenantId)
      .all();

    const { results: editRows } = await db
      .prepare("SELECT message_id, payload, edited_at FROM message_edits WHERE tenant_id = ? ORDER BY edited_at ASC")
      .bind(tenantId)
      .all();

    const editsByMessage = new Map<string, Array<{ payload: unknown; editedAt: string }>>();
    for (const edit of editRows) {
      const msgId = edit.message_id as string;
      if (!editsByMessage.has(msgId)) editsByMessage.set(msgId, []);
      editsByMessage.get(msgId)!.push({
        payload: JSON.parse(edit.payload as string),
        editedAt: edit.edited_at as string,
      });
    }

    const messages = msgRows.map((row) => ({
      id: row.id as string,
      channelId: row.channel_id as string,
      payload: JSON.parse(row.payload as string),
      editHistory: editsByMessage.get(row.id as string) || [],
      createdAt: row.created_at as string,
    }));

    const { results: reactionRows } = await db
      .prepare("SELECT channel_id, message_id, emoji, created_at FROM reactions WHERE tenant_id = ? ORDER BY created_at ASC")
      .bind(tenantId)
      .all();

    const { results: irRows } = await db
      .prepare("SELECT interaction_token, response_id, payload, responded_at FROM interaction_responses WHERE tenant_id = ? ORDER BY responded_at ASC")
      .bind(tenantId)
      .all();

    const { results: followupRows } = await db
      .prepare("SELECT id, interaction_token, payload, created_at FROM followups WHERE tenant_id = ? ORDER BY created_at ASC")
      .bind(tenantId)
      .all();

    const { results: cmdRows } = await db
      .prepare("SELECT id, guild_id, payload, registered_at FROM registered_commands WHERE tenant_id = ? ORDER BY registered_at ASC")
      .bind(tenantId)
      .all();

    const { results: authCodeRows } = await db
      .prepare("SELECT code, guild_id, redirect_uri FROM auth_codes WHERE tenant_id = ?")
      .bind(tenantId)
      .all();

    const { results: tokenRows } = await db
      .prepare("SELECT token FROM access_tokens WHERE tenant_id = ?")
      .bind(tenantId)
      .all();

    return c.json({
      messages,
      reactions: reactionRows.map((r) => ({
        channelId: r.channel_id as string,
        messageId: r.message_id as string,
        emoji: r.emoji as string,
        createdAt: r.created_at as string,
      })),
      interactionResponses: irRows.map((r) => ({
        interactionToken: r.interaction_token as string,
        responseId: r.response_id as string,
        payload: JSON.parse(r.payload as string),
        respondedAt: r.responded_at as string,
      })),
      followups: followupRows.map((r) => ({
        id: r.id as string,
        interactionToken: r.interaction_token as string,
        payload: JSON.parse(r.payload as string),
        createdAt: r.created_at as string,
      })),
      commands: cmdRows.map((r) => ({
        id: r.id as string,
        guildId: r.guild_id as string,
        ...JSON.parse(r.payload as string),
        registeredAt: r.registered_at as string,
      })),
      authCodes: authCodeRows.map((r) => ({
        code: r.code as string,
        guildId: r.guild_id as string,
        redirectUri: r.redirect_uri as string,
      })),
      accessTokens: tokenRows.map((r) => ({
        token: r.token as string,
      })),
    });
  });

  // 2.1 Create Tenant
  app.post("/_test/tenants", async (c) => {
    const body = await requireJsonBody(c);
    if (body instanceof Response) return body;

    const { botToken, clientId, clientSecret, publicKey, privateKey, guilds } =
      body as {
        botToken?: string;
        clientId?: string;
        clientSecret?: string;
        publicKey?: string;
        privateKey?: string;
        guilds?: Record<
          string,
          { name: string; channels: Record<string, { name: string }> }
        >;
      };

    // Validate required fields
    for (const [field, value] of Object.entries({
      botToken,
      clientId,
      clientSecret,
      publicKey,
      privateKey,
      guilds,
    })) {
      if (!value) {
        return c.json({ error: `Missing required field: ${field}` }, 400);
      }
    }

    // Validate guilds structure
    const guildEntries = Object.entries(guilds!);
    if (guildEntries.length === 0) {
      return c.json(
        { error: "Missing required field: guilds (must have at least one)" },
        400
      );
    }
    for (const [guildId, guild] of guildEntries) {
      if (
        !guild.channels ||
        Object.keys(guild.channels).length === 0
      ) {
        return c.json(
          {
            error: `Missing required field: guild ${guildId} must have at least one channel`,
          },
          400
        );
      }
    }

    // Check uniqueness
    const existingBot = await db
      .prepare("SELECT id FROM tenants WHERE bot_token = ?")
      .bind(botToken!)
      .first();
    if (existingBot) {
      return c.json({ error: "botToken already in use" }, 409);
    }

    const existingClient = await db
      .prepare("SELECT id FROM tenants WHERE client_id = ?")
      .bind(clientId!)
      .first();
    if (existingClient) {
      return c.json({ error: "clientId already in use" }, 409);
    }

    // Generate tenant ID
    const tenantId = crypto.randomUUID();

    // Build batch: insert tenant + guilds + channels
    const stmts = [
      db
        .prepare(
          `INSERT INTO tenants (id, bot_token, client_id, client_secret, public_key, private_key, next_id)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          tenantId,
          botToken!,
          clientId!,
          clientSecret!,
          publicKey!,
          privateKey!
        ),
    ];

    for (const [guildId, guild] of guildEntries) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO guilds (tenant_id, id, name) VALUES (?, ?, ?)"
          )
          .bind(tenantId, guildId, guild.name)
      );
      for (const [channelId, channel] of Object.entries(guild.channels)) {
        stmts.push(
          db
            .prepare(
              "INSERT INTO channels (tenant_id, guild_id, id, name) VALUES (?, ?, ?, ?)"
            )
            .bind(tenantId, guildId, channelId, channel.name)
        );
      }
    }

    await db.batch(stmts);

    return c.json(
      {
        tenantId,
        botToken: botToken!,
        clientId: clientId!,
        guilds: guildEntries.map(([id]) => id),
      },
      201
    );
  });

  // 2.2 Delete Tenant
  app.delete("/_test/tenants/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    await db.batch([
      db.prepare("DELETE FROM followups WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM interaction_responses WHERE tenant_id = ?")
        .bind(tenantId),
      db
        .prepare("DELETE FROM registered_commands WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM reactions WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM message_edits WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM messages WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM access_tokens WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM auth_codes WHERE tenant_id = ?").bind(tenantId),
      db.prepare("DELETE FROM channels WHERE tenant_id = ?").bind(tenantId),
      db.prepare("DELETE FROM guilds WHERE tenant_id = ?").bind(tenantId),
      db.prepare("DELETE FROM tenants WHERE id = ?").bind(tenantId),
    ]);

    return c.json({ deleted: true });
  });

  // 2.3 Get Messages
  app.get("/_test/:tenantId/messages/:channelId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const channelId = c.req.param("channelId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results: msgRows } = await db
      .prepare(
        `SELECT id, channel_id, payload, created_at
         FROM messages
         WHERE tenant_id = ? AND channel_id = ?
         ORDER BY created_at ASC`
      )
      .bind(tenantId, channelId)
      .all();

    const { results: editRows } = await db
      .prepare(
        `SELECT me.message_id, me.payload, me.edited_at
         FROM message_edits me
         JOIN messages m ON me.tenant_id = m.tenant_id AND me.message_id = m.id
         WHERE me.tenant_id = ? AND m.channel_id = ?
         ORDER BY me.edited_at ASC`
      )
      .bind(tenantId, channelId)
      .all();

    // Group edits by message ID
    const editsByMessage = new Map<
      string,
      Array<{ payload: unknown; editedAt: string }>
    >();
    for (const edit of editRows) {
      const msgId = edit.message_id as string;
      if (!editsByMessage.has(msgId)) {
        editsByMessage.set(msgId, []);
      }
      editsByMessage.get(msgId)!.push({
        payload: JSON.parse(edit.payload as string),
        editedAt: edit.edited_at as string,
      });
    }

    const messages = msgRows.map((row) => ({
      id: row.id as string,
      channelId: row.channel_id as string,
      payload: JSON.parse(row.payload as string),
      editHistory: editsByMessage.get(row.id as string) || [],
      createdAt: row.created_at as string,
    }));

    return c.json({ messages });
  });

  // 2.4 Get Reactions
  app.get("/_test/:tenantId/reactions", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results } = await db
      .prepare(
        `SELECT channel_id, message_id, emoji, created_at
         FROM reactions
         WHERE tenant_id = ?
         ORDER BY created_at ASC`
      )
      .bind(tenantId)
      .all();

    return c.json({
      reactions: results.map((r) => ({
        channelId: r.channel_id as string,
        messageId: r.message_id as string,
        emoji: r.emoji as string,
        createdAt: r.created_at as string,
      })),
    });
  });

  // 2.5 Get Interaction Response
  app.get("/_test/:tenantId/interaction-responses/:token", async (c) => {
    const tenantId = c.req.param("tenantId");
    const token = c.req.param("token");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const row = await db
      .prepare(
        `SELECT payload, responded_at
         FROM interaction_responses
         WHERE tenant_id = ? AND interaction_token = ?`
      )
      .bind(tenantId, token)
      .first();

    if (!row) {
      return c.json(
        { error: "No response for this interaction token" },
        404
      );
    }

    return c.json({
      payload: JSON.parse(row.payload as string),
      respondedAt: row.responded_at as string,
    });
  });

  // 2.6 Get Followups
  app.get("/_test/:tenantId/followups/:token", async (c) => {
    const tenantId = c.req.param("tenantId");
    const token = c.req.param("token");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results } = await db
      .prepare(
        `SELECT id, payload, created_at
         FROM followups
         WHERE tenant_id = ? AND interaction_token = ?
         ORDER BY created_at ASC`
      )
      .bind(tenantId, token)
      .all();

    return c.json({
      followups: results.map((r) => ({
        id: r.id as string,
        payload: JSON.parse(r.payload as string),
        createdAt: r.created_at as string,
      })),
    });
  });

  // 2.7 Get Registered Commands
  app.get("/_test/:tenantId/commands/:guildId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const guildId = c.req.param("guildId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const { results } = await db
      .prepare(
        `SELECT id, payload, registered_at
         FROM registered_commands
         WHERE tenant_id = ? AND guild_id = ?
         ORDER BY registered_at ASC`
      )
      .bind(tenantId, guildId)
      .all();

    return c.json({
      commands: results.map((r) => {
        const payload = JSON.parse(r.payload as string);
        return {
          id: r.id as string,
          ...payload,
          registeredAt: r.registered_at as string,
        };
      }),
    });
  });

  // 2.8 Reset Tenant State
  app.post("/_test/:tenantId/reset", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    await db.batch([
      db.prepare("DELETE FROM followups WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM interaction_responses WHERE tenant_id = ?")
        .bind(tenantId),
      db
        .prepare("DELETE FROM registered_commands WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM reactions WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM message_edits WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM messages WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("DELETE FROM access_tokens WHERE tenant_id = ?")
        .bind(tenantId),
      db.prepare("DELETE FROM auth_codes WHERE tenant_id = ?").bind(tenantId),
      db
        .prepare("UPDATE tenants SET next_id = 1 WHERE id = ?")
        .bind(tenantId),
    ]);

    return c.json({ reset: true });
  });

  // 2.9 Create Authorization Code
  app.post("/_test/:tenantId/auth-code", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const body = await requireJsonBody(c);
    if (body instanceof Response) return body;

    const { guildId, redirectUri } = body as {
      guildId?: string;
      redirectUri?: string;
    };

    if (!guildId) {
      return c.json({ error: "Missing required field: guildId" }, 400);
    }

    // Validate guild exists
    const guild = await db
      .prepare(
        "SELECT id FROM guilds WHERE tenant_id = ? AND id = ?"
      )
      .bind(tenantId, guildId)
      .first();
    if (!guild) {
      return c.json({ error: `Unknown guild: ${guildId}` }, 400);
    }

    const code = `fake-code-${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO auth_codes (code, tenant_id, guild_id, redirect_uri) VALUES (?, ?, ?, ?)"
      )
      .bind(code, tenantId, guildId, redirectUri || "")
      .run();

    return c.json({ code, guildId });
  });

  // 2.10 Send Signed Interaction
  app.post("/_test/:tenantId/send-interaction", async (c) => {
    const tenantId = c.req.param("tenantId");
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) {
      return c.json({ error: "Tenant not found" }, 404);
    }

    const body = await requireJsonBody(c);
    if (body instanceof Response) return body;

    const { webhookUrl, interaction } = body as {
      webhookUrl?: string;
      interaction?: Record<string, unknown>;
    };

    if (!webhookUrl) {
      return c.json({ error: "Missing required field: webhookUrl" }, 400);
    }
    if (!interaction) {
      return c.json({ error: "Missing required field: interaction" }, 400);
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const interactionBody = JSON.stringify(interaction);
    const signature = await signPayload(
      tenant.private_key,
      timestamp,
      interactionBody
    );

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": signature,
          "X-Signature-Timestamp": timestamp,
        },
        body: interactionBody,
      });

      let responseBody: unknown;
      const respText = await resp.text();
      try {
        responseBody = JSON.parse(respText);
      } catch {
        responseBody = respText;
      }

      return c.json({
        statusCode: resp.status,
        body: responseBody,
      });
    } catch (err) {
      return c.json(
        {
          error: `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        502
      );
    }
  });
}
