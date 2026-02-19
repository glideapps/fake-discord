/**
 * Fling Backend Worker — Fake Discord Service
 *
 * Multi-tenant fake Discord API for integration testing.
 */

import { app, migrate, db, cron } from "flingit";
import { registerDiscordRoutes } from "./discord-api.js";
import { registerTestRoutes } from "./test-control.js";
import { deleteTenantData } from "./helpers.js";

// Hono type augmentation for per-request tenant context
declare module "hono" {
  interface ContextVariableMap {
    tenantId: string;
  }
}

// Database migration — all tables and indexes
migrate("001_fake_discord_schema", async () => {
  // Config tables (preserved across reset)
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        bot_token TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL UNIQUE,
        client_secret TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        next_id INTEGER NOT NULL DEFAULT 1
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS guilds (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS channels (
        tenant_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `),
    // Mutable state tables (cleared on reset)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL DEFAULT ''
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS access_tokens (
        token TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS message_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        edited_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS interaction_responses (
        tenant_id TEXT NOT NULL,
        interaction_token TEXT NOT NULL,
        response_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        responded_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, interaction_token)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS followups (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        interaction_token TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS registered_commands (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `),
  ]);

  // Indexes
  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (tenant_id, channel_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_reactions_tenant ON reactions (tenant_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_followups_token ON followups (tenant_id, interaction_token, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_commands_guild ON registered_commands (tenant_id, guild_id, registered_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_auth_codes_tenant ON auth_codes (tenant_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_access_tokens_tenant ON access_tokens (tenant_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_message_edits_tenant ON message_edits (tenant_id)`),
  ]);
});

// Migration 002: Add created_at to tenants, add audit_logs table
migrate("002_audit_logs_and_tenant_expiry", async () => {
  // Wipe all data (destructive — service has minimal usage)
  await db.batch([
    db.prepare("DELETE FROM followups"),
    db.prepare("DELETE FROM interaction_responses"),
    db.prepare("DELETE FROM registered_commands"),
    db.prepare("DELETE FROM reactions"),
    db.prepare("DELETE FROM message_edits"),
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM access_tokens"),
    db.prepare("DELETE FROM auth_codes"),
    db.prepare("DELETE FROM channels"),
    db.prepare("DELETE FROM guilds"),
  ]);

  // Drop and recreate tenants with created_at default
  await db.prepare("DROP TABLE IF EXISTS tenants").run();
  await db.prepare(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      bot_token TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL UNIQUE,
      client_secret TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      next_id INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run();

  // Create audit_logs table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_body TEXT,
      response_status INTEGER NOT NULL,
      response_body TEXT,
      created_at TEXT NOT NULL
    )
  `).run();

  // Indexes
  await db.batch([
    db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs (tenant_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_tenants_created_at ON tenants (created_at)"),
  ]);
});

// Audit logging middleware — captures all requests except audit-log reads
app.use("*", async (c, next) => {
  const method = c.req.method;
  const url = c.req.url;
  const path = new URL(url).pathname;

  // Skip audit-log endpoints to prevent recursive response body explosion
  if (path.endsWith("/audit-logs")) {
    return next();
  }

  // Capture request body for non-GET/HEAD methods
  let requestBody: string | null = null;
  if (method !== "GET" && method !== "HEAD") {
    try {
      requestBody = await c.req.raw.clone().text();
    } catch {
      // Ignore body read failures
    }
  }

  await next();

  // Log after response is generated
  try {
    const tenantId = c.get("tenantId") as string | undefined;
    const responseStatus = c.res.status;

    let responseBody: string | null = null;
    try {
      responseBody = await c.res.clone().text();
    } catch {
      // Ignore response read failures
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO audit_logs (tenant_id, method, url, request_body, response_status, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        tenantId || null,
        method,
        url,
        requestBody,
        responseStatus,
        responseBody,
        now
      )
      .run();
  } catch {
    // Never let audit logging break requests
  }
});

// Register route handlers
registerTestRoutes(app);
registerDiscordRoutes(app);

// Catch-all for unknown routes
app.all("*", (c) => {
  return c.json({ message: "404: Not Found" }, 404);
});

// Cron: clean up tenants older than 24 hours
cron("cleanup-old-tenants", "0 * * * *", async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare("SELECT id FROM tenants WHERE created_at < ?")
    .bind(cutoff)
    .all();

  for (const row of results) {
    await deleteTenantData(row.id as string);
  }

  return { deleted: results.length, checked: true };
});
