/**
 * Fling Backend Worker — Fake Discord Service
 *
 * Multi-tenant fake Discord API for integration testing.
 */

import { app, migrate, db } from "flingit";
import { registerDiscordRoutes } from "./discord-api.js";
import { registerTestRoutes } from "./test-control.js";

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

// Register route handlers
registerTestRoutes(app);
registerDiscordRoutes(app);

// Catch-all for unknown routes
app.all("*", (c) => {
  return c.json({ message: "404: Not Found" }, 404);
});
