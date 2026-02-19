# Fake Discord Service

A multi-tenant fake Discord API server for integration testing. It impersonates Discord's REST API so that a Discord plugin worker can be tested end-to-end without touching real Discord.

Built on [Fling](https://fling.dev) with D1 (SQLite) for persistent state.

**Live at: https://fake-discord.flingit.run**

## Quick Start

```bash
npm install
npm start          # Start the dev server on http://localhost:3210
npm test           # Run all tests (server must be running)
```

## Architecture

- **Multi-tenant** -- each test suite creates its own isolated tenant with unique credentials, guilds, and channels. Tenants never see each other's data.
- **Two route families** -- Discord API routes (`/api/v10/...`, `/oauth2/...`) that mimic real Discord, and test control routes (`/_test/...`) for setup, teardown, and assertions.
- **D1 (SQLite) storage** -- all state is persisted in the database. State survives server restarts.
- **Ed25519 signing** -- the `send-interaction` endpoint signs payloads with the tenant's private key using `@noble/ed25519` (pure ESM, works in Cloudflare Workers).

### Tenant Resolution

Different endpoints resolve the tenant differently, matching how real Discord clients authenticate:

| Pattern | Resolution Method |
|---------|-------------------|
| `Authorization: Bot <token>` | Look up tenant by `bot_token` |
| `Authorization: Bearer <token>` | Look up tenant via `access_tokens` table |
| `client_id` query/form param | Look up tenant by `client_id` |
| `/webhooks/:clientId/...` path param | Look up tenant by `client_id` |
| `/applications/:clientId/...` path param | Look up tenant by `client_id` (cross-checked with bot token) |
| `/_test/:tenantId/...` path param | Direct lookup by tenant ID |

### State Model

Each tenant has two categories of state:

**Config (preserved across reset):**
- Tenant credentials (bot token, client ID/secret, Ed25519 keys)
- Guilds and channels

**Mutable state (cleared by reset):**
- Authorization codes and access tokens
- Messages and message edit history
- Reactions
- Interaction responses
- Followup messages
- Registered slash commands

### ID Generation

IDs are generated using a monotonic per-tenant counter stored in the `tenants` row (`next_id` column). Each ID has a prefix indicating its type:

| Prefix | Used For |
|--------|----------|
| `msg-N` | Messages |
| `resp-N` | Interaction responses |
| `followup-N` | Followup messages |
| `cmd-N` | Registered commands |

The counter resets to 1 when a tenant is reset via `POST /_test/:tenantId/reset`.

---

## Discord API Endpoints

These routes live under `/api/v10/` and `/oauth2/` to match Discord's URL structure. All responses use `Content-Type: application/json` unless otherwise noted.

### 1.1 OAuth Authorize

Simulates the Discord consent screen. Instead of showing UI, immediately redirects back with an authorization code.

```
GET /oauth2/authorize?client_id=X&redirect_uri=X&response_type=code&scope=X&state=X
```

**Tenant resolution:** `client_id` query parameter.

**Behavior:**
1. Resolve tenant from `client_id`. Return `400` if not found.
2. Generate a random authorization code, store it with `{ guildId: <first guild by ID>, redirectUri }`.
3. Redirect `302` to `<redirect_uri>?code=<code>&state=<state>&guild_id=<first_guild_id>`.

The "first guild" is determined by `ORDER BY id ASC LIMIT 1` for determinism.

**Errors:**
- `400 { "error": "Unknown client_id" }`

---

### 1.2 OAuth Token Exchange

Exchange an authorization code for an access token.

```
POST /api/v10/oauth2/token
Content-Type: application/x-www-form-urlencoded

client_id=X&client_secret=X&grant_type=authorization_code&code=X&redirect_uri=X
```

**Tenant resolution:** `client_id` form field.

**Behavior:**
1. Validate `client_id` and `client_secret`.
2. Look up the authorization code. Codes are one-time use -- they are deleted after consumption.
3. Validate `redirect_uri` matches what was stored with the code.
4. Generate an access token and store it for future Bearer auth.

**Response (200):**
```json
{
  "access_token": "fake-at-<tenantId>-<uuid>",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "fake-rt-<uuid>",
  "scope": "identify guilds bot applications.commands",
  "guild": {
    "id": "<guildId from auth code>",
    "name": "<guild name>"
  }
}
```

**Errors:**
- `401 { "error": "invalid_client" }` -- unknown `client_id` or wrong `client_secret`
- `401 { "error": "invalid_grant" }` -- unknown or already-used code
- `400 { "error": "invalid_request", "error_description": "redirect_uri mismatch" }`

---

### 1.3 User Identity

```
GET /api/v10/users/@me
Authorization: Bearer <access_token>
```

**Tenant resolution:** Bearer access token.

**Response (200):**
```json
{
  "id": "fake-user-<tenantId>",
  "username": "fakeuser",
  "global_name": "Fake User (<tenantId>)",
  "discriminator": "0"
}
```

**Errors:**
- `401 { "message": "401: Unauthorized" }` -- missing or invalid token

---

### 1.4 Get Channel

```
GET /api/v10/channels/:channelId
Authorization: Bot <bot_token>
```

**Tenant resolution:** Bot token.

**Response (200):**
```json
{
  "id": "<channelId>",
  "guild_id": "<guildId>",
  "name": "<channel name>",
  "type": 0
}
```

**Errors:**
- `401 { "message": "401: Unauthorized" }` -- invalid bot token
- `404 { "message": "Unknown Channel" }`

---

### 1.5 Send Message

```
POST /api/v10/channels/:channelId/messages
Authorization: Bot <bot_token>
Content-Type: application/json

{ "content": "Hello!", "embeds": [...], ... }
```

**Tenant resolution:** Bot token.

The full request body is stored as the message payload. It can be retrieved later via the test control endpoint `GET /_test/:tenantId/messages/:channelId`.

**Response (200):**
```json
{
  "id": "msg-1",
  "channel_id": "<channelId>",
  "content": "<content from body, or empty string>"
}
```

**Errors:**
- `401 { "message": "401: Unauthorized" }`
- `404 { "message": "Unknown Channel" }`
- `400 { "message": "Invalid request body" }` -- missing/invalid Content-Type or unparseable JSON

---

### 1.6 Edit Message

```
PATCH /api/v10/channels/:channelId/messages/:messageId
Authorization: Bot <bot_token>
Content-Type: application/json

{ "content": "Updated!", ... }
```

**Tenant resolution:** Bot token.

The old payload is saved to the message's edit history before replacing it with the new body. Edit history is accessible via `GET /_test/:tenantId/messages/:channelId`.

**Response (200):**
```json
{
  "id": "<messageId>",
  "channel_id": "<channelId>",
  "content": "<new content>"
}
```

**Errors:**
- `401 { "message": "401: Unauthorized" }`
- `404 { "message": "Unknown Message" }`

---

### 1.7 Add Reaction

```
PUT /api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me
Authorization: Bot <bot_token>
```

The `:emoji` path segment is URL-encoded (e.g., `%E2%9C%85` for a checkmark). The server URL-decodes it before storing.

**Tenant resolution:** Bot token.

**Response:** `204 No Content` (empty body)

**Errors:**
- `401 { "message": "401: Unauthorized" }`
- `404 { "message": "Unknown Channel" }` or `{ "message": "Unknown Message" }`

---

### 1.8 Edit Interaction Response

```
PATCH /api/v10/webhooks/:clientId/:interactionToken/messages/@original
Content-Type: application/json

{ "content": "Pong!", "embeds": [...], "flags": 64, ... }
```

**No Authorization header.** This matches real Discord behavior for webhook-based interaction responses.

**Tenant resolution:** `clientId` path parameter.

Stores the full request body as the interaction response, keyed by `interactionToken`. If called multiple times with the same token, the response is replaced (upsert).

**Response (200):**
```json
{
  "id": "resp-1",
  "content": "<content from body>"
}
```

**Errors:**
- `404 { "message": "Unknown Application" }`

---

### 1.9 Send Followup

```
POST /api/v10/webhooks/:clientId/:interactionToken
Content-Type: application/json

{ "content": "Additional info", ... }
```

**No Authorization header.**

**Tenant resolution:** `clientId` path parameter.

Multiple followups can be sent for the same interaction token. Each gets a unique ID.

**Response (200):**
```json
{
  "id": "followup-1",
  "channel_id": "chan-followup",
  "content": "<content from body>"
}
```

**Errors:**
- `404 { "message": "Unknown Application" }`

---

### 1.10 Bulk Overwrite Guild Commands

```
PUT /api/v10/applications/:clientId/guilds/:guildId/commands
Authorization: Bot <bot_token>
Content-Type: application/json

[
  { "name": "ping", "description": "Ping the bot", "type": 1, "options": [...] }
]
```

**Tenant resolution:** Bot token. The `clientId` path parameter is cross-checked against the tenant's configured `client_id`.

This **replaces** (not merges) all commands for the guild. Previous commands are deleted before inserting the new set.

**Response (200):** Array of commands with generated IDs:
```json
[
  {
    "id": "cmd-1",
    "name": "ping",
    "description": "Ping the bot",
    "type": 1,
    "application_id": "<clientId>",
    "guild_id": "<guildId>",
    "options": [...]
  }
]
```

**Errors:**
- `401 { "message": "401: Unauthorized" }`
- `400 { "message": "client_id mismatch" }` -- `clientId` param doesn't match tenant
- `404 { "message": "Unknown Guild" }`

---

## Test Control Endpoints

These routes are used by test runners for setup, teardown, and assertions. They are **not** part of the Discord API surface. All routes live under `/_test/`.

> **Note:** The prefix is `/_test/`, not `/__test/`. Fling reserves all `/__*` paths for internal platform use.

### 2.1 Create Tenant

```
POST /_test/tenants
Content-Type: application/json

{
  "botToken": "fake-bot-token-abc123",
  "clientId": "fake-client-id-abc123",
  "clientSecret": "fake-client-secret-abc123",
  "publicKey": "<Ed25519 public key, hex-encoded>",
  "privateKey": "<Ed25519 private key, hex-encoded>",
  "guilds": {
    "guild-abc123": {
      "name": "Test Guild",
      "channels": {
        "chan-abc123": { "name": "general" },
        "chan-abc456": { "name": "bot-commands" }
      }
    }
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `botToken` | string | yes | Unique bot token. Used for `Authorization: Bot` header resolution. |
| `clientId` | string | yes | Unique client ID. Used for OAuth params and webhook path resolution. |
| `clientSecret` | string | yes | Client secret for OAuth token exchange. |
| `publicKey` | string | yes | Ed25519 public key (hex). Set as `DISCORD_PUBLIC_KEY` in the plugin worker. |
| `privateKey` | string | yes | Ed25519 private key (hex, 32-byte seed or 64-byte secret key). Used by `send-interaction` to sign payloads. |
| `guilds` | object | yes | Map of `guildId` to `{ name, channels }`. Channels is a map of `channelId` to `{ name }`. |

**Validation:**
- All fields are required.
- `botToken` must be unique across all tenants.
- `clientId` must be unique across all tenants.
- At least one guild with at least one channel.

**Response (201):**
```json
{
  "tenantId": "<generated UUID>",
  "botToken": "fake-bot-token-abc123",
  "clientId": "fake-client-id-abc123",
  "guilds": ["guild-abc123"]
}
```

**Errors:**
- `400 { "error": "Missing required field: ..." }`
- `409 { "error": "botToken already in use" }`
- `409 { "error": "clientId already in use" }`

---

### 2.2 Delete Tenant

```
DELETE /_test/tenants/:tenantId
```

Removes the tenant and **all** its state (messages, reactions, commands, auth codes, access tokens, guilds, channels).

**Response (200):**
```json
{ "deleted": true }
```

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.3 Get Messages

```
GET /_test/:tenantId/messages/:channelId
```

Returns all messages sent to a channel, in chronological order. Each message includes the full stored payload and its edit history.

**Response (200):**
```json
{
  "messages": [
    {
      "id": "msg-1",
      "channelId": "chan-abc123",
      "payload": { "content": "Hello!", "embeds": [] },
      "editHistory": [
        {
          "payload": { "content": "Helo!" },
          "editedAt": "2026-02-15T10:00:00.000Z"
        }
      ],
      "createdAt": "2026-02-15T09:59:00.000Z"
    }
  ]
}
```

- `payload` -- the full request body from the most recent send/edit
- `editHistory` -- array of previous payloads (empty if never edited), oldest first

Returns `{ "messages": [] }` if the channel has no messages.

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.4 Get Reactions

```
GET /_test/:tenantId/reactions
```

Returns all reactions added by this tenant, in chronological order.

**Response (200):**
```json
{
  "reactions": [
    {
      "channelId": "chan-abc123",
      "messageId": "msg-1",
      "emoji": "\u2705",
      "createdAt": "2026-02-15T10:01:00.000Z"
    }
  ]
}
```

Returns `{ "reactions": [] }` if no reactions have been added.

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.5 Get Interaction Response

```
GET /_test/:tenantId/interaction-responses/:token
```

Returns the response that was sent for a specific interaction token (via `PATCH /api/v10/webhooks/:clientId/:token/messages/@original`).

**Response (200):**
```json
{
  "payload": { "content": "Pong!", "embeds": [], "flags": 64 },
  "respondedAt": "2026-02-15T10:02:00.000Z"
}
```

**Errors:**
- `404 { "error": "Tenant not found" }`
- `404 { "error": "No response for this interaction token" }`

---

### 2.6 Get Followups

```
GET /_test/:tenantId/followups/:token
```

Returns all followup messages for a specific interaction token, in chronological order.

**Response (200):**
```json
{
  "followups": [
    {
      "id": "followup-1",
      "payload": { "content": "Additional info" },
      "createdAt": "2026-02-15T10:03:00.000Z"
    }
  ]
}
```

Returns `{ "followups": [] }` if no followups exist for this token.

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.7 Get Registered Commands

```
GET /_test/:tenantId/commands/:guildId
```

Returns the commands currently registered for a guild (from the most recent bulk overwrite).

**Response (200):**
```json
{
  "commands": [
    {
      "id": "cmd-1",
      "name": "ping",
      "description": "Ping the bot",
      "type": 1,
      "options": [],
      "registeredAt": "2026-02-15T10:04:00.000Z"
    }
  ]
}
```

Returns `{ "commands": [] }` if no commands have been registered for this guild.

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.8 Reset Tenant State

```
POST /_test/:tenantId/reset
```

Clears all mutable state for this tenant but preserves the tenant config (bot token, client ID, guilds, channels). Also resets the ID counter back to 1.

**What gets cleared:** messages, message edits, reactions, interaction responses, followups, registered commands, auth codes, access tokens, audit logs.

**What is preserved:** tenant credentials, guilds, channels.

**Response (200):**
```json
{ "reset": true }
```

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 2.9 Create Authorization Code

Pre-generates an authorization code for programmatic OAuth testing. This bypasses the `/oauth2/authorize` redirect flow.

```
POST /_test/:tenantId/auth-code
Content-Type: application/json

{
  "guildId": "guild-abc123",
  "redirectUri": "https://example.com/callback"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `guildId` | string | yes | Must be a guild that exists in the tenant's config. |
| `redirectUri` | string | no | Stored with the code; validated on token exchange. |

**Response (200):**
```json
{
  "code": "fake-code-<uuid>",
  "guildId": "guild-abc123"
}
```

**Errors:**
- `404 { "error": "Tenant not found" }`
- `400 { "error": "Unknown guild: <guildId>" }`

---

### 2.10 Send Signed Interaction

Convenience endpoint that Ed25519-signs a Discord interaction payload and POSTs it to a webhook URL, simulating Discord sending an interaction to your worker.

```
POST /_test/:tenantId/send-interaction
Content-Type: application/json

{
  "webhookUrl": "https://your-worker.example.com/webhook",
  "interaction": {
    "type": 2,
    "id": "interaction-001",
    "application_id": "fake-client-id-abc123",
    "token": "test-interaction-token-001",
    "guild_id": "guild-abc123",
    "channel_id": "chan-abc123",
    "member": {
      "user": {
        "id": "discord-user-001",
        "username": "testuser",
        "discriminator": "0"
      },
      "roles": [],
      "permissions": "0"
    },
    "data": {
      "id": "cmd-1",
      "name": "ping",
      "type": 1,
      "options": []
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookUrl` | string | yes | Full URL to POST the signed interaction to. |
| `interaction` | object | yes | The Discord interaction payload. |

**Behavior:**
1. Import the tenant's Ed25519 private key.
2. Generate a Unix timestamp.
3. Serialize `interaction` to JSON.
4. Sign `timestamp + body` using Ed25519 (`@noble/ed25519`).
5. POST to `webhookUrl` with headers `X-Signature-Ed25519` and `X-Signature-Timestamp`.
6. Return the webhook's response.

**Response (200):**
```json
{
  "statusCode": 200,
  "body": { "type": 5 }
}
```

The `statusCode` and `body` reflect the response from the webhook URL. If the webhook returns non-JSON, `body` is the raw text string.

**Errors:**
- `404 { "error": "Tenant not found" }`
- `400 { "error": "Missing required field: webhookUrl" }`
- `400 { "error": "Missing required field: interaction" }`
- `502 { "error": "Webhook request failed: <details>" }` -- network error calling webhookUrl

---

### 2.11 Get Audit Logs

```
GET /_test/:tenantId/audit-logs?limit=100&offset=0
```

Returns all audit log entries for this tenant, most recent first. Supports pagination via `limit` (default 100, max 1000) and `offset` (default 0).

**Response (200):**
```json
{
  "logs": [
    {
      "id": 42,
      "tenantId": "<tenantId>",
      "method": "POST",
      "url": "http://localhost:3210/api/v10/channels/chan-1/messages",
      "requestBody": { "content": "Hello!" },
      "responseStatus": 200,
      "responseBody": { "id": "msg-1", "channel_id": "chan-1", "content": "Hello!" },
      "createdAt": "2026-02-19T12:34:56.789Z"
    }
  ],
  "total": 42,
  "limit": 100,
  "offset": 0
}
```

**Errors:**
- `404 { "error": "Tenant not found" }`

---

## Automatic Cleanup

Tenants are automatically cleaned up after 24 hours via a cron job that runs hourly (`0 * * * *`). Each tenant has a `created_at` timestamp set at creation time. The cron job finds all tenants with `created_at` older than 24 hours and deletes them along with all their data.

To manually trigger cleanup: `npx fling cron trigger cleanup-old-tenants`

---

## Audit Logging

Every HTTP request/response is automatically logged to the `audit_logs` table. The middleware captures:
- HTTP method and full URL
- Request body (for non-GET/HEAD requests)
- Response status code and body
- Associated tenant ID (null if auth failed or no tenant context)
- Timestamp

Audit logs are:
- Cleared when a tenant is reset (`POST /_test/:tenantId/reset`)
- Deleted when a tenant is deleted (`DELETE /_test/tenants/:tenantId`)
- Available per-tenant via `GET /_test/:tenantId/audit-logs`
- Available globally via `GET /_test/browse/audit-logs`

---

## Browse API Endpoints

These read-only endpoints power the state browser frontend and allow inspecting all tenant data. They live under `/_test/browse/`.

### 3.1 List Tenants

```
GET /_test/browse/tenants
```

Returns all tenants with guild and channel counts.

**Response (200):**
```json
{
  "tenants": [
    {
      "id": "<tenantId>",
      "botToken": "...",
      "clientId": "...",
      "clientSecret": "...",
      "publicKey": "...",
      "nextId": 1,
      "guildCount": 1,
      "channelCount": 2,
      "createdAt": "2026-02-19T12:34:56.789Z",
      "logCount": 42
    }
  ]
}
```

---

### 3.2 Tenant Detail

```
GET /_test/browse/tenants/:tenantId
```

Returns tenant config with guilds and nested channels.

**Response (200):**
```json
{
  "tenant": { "id": "...", "botToken": "...", "clientId": "...", "clientSecret": "...", "publicKey": "...", "nextId": 1, "createdAt": "2026-02-19T12:34:56.789Z", "logCount": 42 },
  "guilds": [
    {
      "id": "guild-1",
      "name": "Test Guild",
      "channels": [
        { "id": "chan-1", "name": "general" }
      ]
    }
  ]
}
```

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 3.3 Tenant State

```
GET /_test/browse/tenants/:tenantId/state
```

Returns all mutable state for a tenant in one call: messages (with edit history), reactions, interaction responses, followups, commands, auth codes, and access tokens.

**Response (200):**
```json
{
  "messages": [...],
  "reactions": [...],
  "interactionResponses": [...],
  "followups": [...],
  "commands": [...],
  "authCodes": [...],
  "accessTokens": [...],
  "auditLogs": [...]
}
```

**Errors:**
- `404 { "error": "Tenant not found" }`

---

### 3.4 Global Audit Logs

```
GET /_test/browse/audit-logs?limit=100&offset=0
```

Returns audit logs across all tenants, most recent first. Supports pagination.

**Response (200):**
```json
{
  "logs": [
    {
      "id": 42,
      "tenantId": "<tenantId or null>",
      "method": "POST",
      "url": "...",
      "requestBody": {...},
      "responseStatus": 200,
      "responseBody": {...},
      "createdAt": "2026-02-19T12:34:56.789Z"
    }
  ],
  "total": 100,
  "limit": 100,
  "offset": 0
}
```

---

## Frontend

The React frontend at `/` provides a state browser for inspecting all tenants and their data. It uses the browse API endpoints above.

- **Tenant list**: shows all tenants with guild/channel counts; click a row to drill in
- **Tenant detail**: shows config, guilds/channels tree, and collapsible sections for each state type (messages, reactions, commands, etc.)
- **Refresh button**: re-fetches data from the API
- **No auth required**: this is a testing tool

In development, visit `http://localhost:5173`. In production, the frontend is served from the same URL as the API.

---

## Error Handling

### Auth Validation

Auth is validated on every request to catch bugs where a client sends wrong credentials:

- **Bot token:** `Authorization: Bot <token>` must resolve to a valid tenant. Returns `401` otherwise.
- **Bearer token:** `Authorization: Bearer <token>` must match a previously issued access token. Returns `401` otherwise.
- **Client ID cross-check:** Endpoints with both a bot token header and a `clientId` path param (e.g., bulk overwrite commands) verify they belong to the same tenant. Returns `400` on mismatch.

### Content-Type Validation

- `POST`/`PATCH`/`PUT` endpoints that expect JSON require `Content-Type: application/json` (with optional charset suffix like `; charset=utf-8`).
- The OAuth token exchange requires `Content-Type: application/x-www-form-urlencoded`.
- Missing or wrong Content-Type returns `400 { "message": "Invalid request body" }`.
- Unparseable JSON also returns `400 { "message": "Invalid request body" }`.

### Unknown Routes

Any request that doesn't match a known route returns:
```json
404 { "message": "404: Not Found" }
```

---

## Database Schema

All tables are created via a single idempotent migration (`001_fake_discord_schema`).

### Config Tables (preserved across reset)

```sql
tenants (
  id TEXT PRIMARY KEY,
  bot_token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  next_id INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)

guilds (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)

channels (
  tenant_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)
```

### Mutable State Tables (cleared on reset)

```sql
auth_codes (
  code TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL DEFAULT ''
)

access_tokens (
  token TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL
)

messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  payload TEXT NOT NULL,       -- JSON string of the full request body
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)

message_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload TEXT NOT NULL,       -- JSON string of the old payload before edit
  edited_at TEXT NOT NULL
)

reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL
)

interaction_responses (
  tenant_id TEXT NOT NULL,
  interaction_token TEXT NOT NULL,
  response_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, interaction_token)
)

followups (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  interaction_token TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)

registered_commands (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
)
```

### Audit Log Table

```sql
audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,              -- nullable: failed auth = NULL
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_body TEXT,
  response_status INTEGER NOT NULL,
  response_body TEXT,
  created_at TEXT NOT NULL
)
```

### Indexes

```sql
idx_messages_channel       ON messages (tenant_id, channel_id, created_at)
idx_reactions_tenant       ON reactions (tenant_id, created_at)
idx_followups_token        ON followups (tenant_id, interaction_token, created_at)
idx_commands_guild         ON registered_commands (tenant_id, guild_id, registered_at)
idx_auth_codes_tenant      ON auth_codes (tenant_id)
idx_access_tokens_tenant   ON access_tokens (tenant_id)
idx_message_edits_tenant   ON message_edits (tenant_id)
idx_audit_logs_tenant      ON audit_logs (tenant_id, created_at)
idx_tenants_created_at     ON tenants (created_at)
```

---

## File Structure

```
src/worker/
  index.ts              # Migration, route registration, catch-all 404
  helpers.ts            # Tenant resolution, ID gen, body parsing, Ed25519 crypto
  discord-api.ts        # 10 Discord API endpoints (registerDiscordRoutes)
  test-control.ts       # 10 test control endpoints (registerTestRoutes)
  tests/
    setup.ts            # Shared test fixtures (createTestTenant, deleteTenant, etc.)
    helpers.test.ts     # Unit tests for pure helper functions
    test-control.test.ts # Integration tests for test control endpoints
    discord-api.test.ts # Integration tests for Discord API endpoints
    audit-logs.test.ts  # Integration tests for audit logging and log APIs
    cron-cleanup.test.ts # Tests for tenant expiry and created_at
vite.config.ts          # Vite config with proxy entries for /api, /_test, /oauth2
vitest.config.ts        # Vitest configuration
package.json            # Dependencies and scripts
```

---

## Development

### Prerequisites

- Node.js 22+
- npm

### Running Locally

```bash
npm install
npm start
```

This starts the Fling dev server:
- **API server** at `http://localhost:3210` (all backend routes)
- **Frontend dev server** at `http://localhost:5173` (Vite with HMR, proxies `/api`, `/_test`, `/oauth2` to the API server)

### Running Tests

Tests are self-contained — they automatically start and stop the dev server:

```bash
npm test
```

If the server is already running on port 3210 (e.g. from `npm start`), tests will use it and skip lifecycle management.

The test suite has 80 tests across 5 files:
- `helpers.test.ts` -- 7 unit tests for hex encoding, key handling, and Ed25519 signing
- `test-control.test.ts` -- 28 integration tests for all test control endpoints
- `discord-api.test.ts` -- 32 integration tests for all Discord API endpoints
- `audit-logs.test.ts` -- 10 integration tests for audit logging and log retrieval
- `cron-cleanup.test.ts` -- 3 tests for tenant expiry and `created_at`

### Vite Proxy Configuration

The Vite frontend dev server proxies these paths to the API server at `http://localhost:3210`:

- `/api/*`
- `/_test/*`
- `/oauth2/*`

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `flingit` | Fling platform SDK (Hono HTTP, D1 database, migrations) |
| `@noble/ed25519` | Pure ESM Ed25519 signing (no Node.js `crypto` dependency, works in Workers) |
| `@noble/curves` | Peer dependency for `@noble/ed25519` |
| `vitest` (dev) | Test runner |

> **Why `@noble/ed25519` instead of `tweetnacl`?** Fling bundles workers similarly to Cloudflare Workers. Packages that use `require("crypto")` (like `tweetnacl`) crash at startup. `@noble/ed25519` is pure ESM and uses `crypto.subtle` for hashing.

---

## Usage Example

A typical integration test flow:

```typescript
// 1. Create a tenant
const resp = await fetch("http://localhost:3210/_test/tenants", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    botToken: "my-bot-token",
    clientId: "my-client-id",
    clientSecret: "my-client-secret",
    publicKey: "<hex-encoded Ed25519 public key>",
    privateKey: "<hex-encoded Ed25519 private key>",
    guilds: {
      "guild-1": {
        name: "Test Guild",
        channels: {
          "chan-1": { name: "general" }
        }
      }
    }
  })
});
const { tenantId } = await resp.json();

// 2. Point your Discord plugin at this fake server
//    Set DISCORD_API_BASE_URL=http://localhost:3210
//    Set DISCORD_PUBLIC_KEY=<publicKey from above>

// 3. Use the Discord API as normal
await fetch("http://localhost:3210/api/v10/channels/chan-1/messages", {
  method: "POST",
  headers: {
    "Authorization": "Bot my-bot-token",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ content: "Hello from test!" })
});

// 4. Verify via test control
const msgs = await fetch(`http://localhost:3210/_test/${tenantId}/messages/chan-1`);
const { messages } = await msgs.json();
console.log(messages[0].payload.content); // "Hello from test!"

// 5. Run the full OAuth flow
const codeResp = await fetch(`http://localhost:3210/_test/${tenantId}/auth-code`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ guildId: "guild-1", redirectUri: "https://example.com/cb" })
});
const { code } = await codeResp.json();

const tokenResp = await fetch("http://localhost:3210/api/v10/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "client_id=my-client-id&client_secret=my-client-secret&grant_type=authorization_code&code=" + code + "&redirect_uri=https://example.com/cb"
});
const { access_token } = await tokenResp.json();

// 6. Use the access token
const me = await fetch("http://localhost:3210/api/v10/users/@me", {
  headers: { "Authorization": `Bearer ${access_token}` }
});
const user = await me.json();
console.log(user.username); // "fakeuser"

// 7. Send a signed interaction to test your webhook handler
await fetch(`http://localhost:3210/_test/${tenantId}/send-interaction`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    webhookUrl: "http://localhost:3210/webhook",  // your handler
    interaction: {
      type: 2,
      id: "int-1",
      application_id: "my-client-id",
      token: "int-token-1",
      data: { id: "cmd-1", name: "ping", type: 1, options: [] }
    }
  })
});

// 8. Clean up between tests
await fetch(`http://localhost:3210/_test/${tenantId}/reset`, { method: "POST" });

// 9. Delete when done
await fetch(`http://localhost:3210/_test/tenants/${tenantId}`, { method: "DELETE" });
```

---

## Route Map (Quick Reference)

### Discord API Routes

| Method | Path | Auth | Section |
|--------|------|------|---------|
| `GET` | `/oauth2/authorize` | client_id query param | [1.1](#11-oauth-authorize) |
| `POST` | `/api/v10/oauth2/token` | client_id form field | [1.2](#12-oauth-token-exchange) |
| `GET` | `/api/v10/users/@me` | Bearer token | [1.3](#13-user-identity) |
| `GET` | `/api/v10/channels/:channelId` | Bot token | [1.4](#14-get-channel) |
| `POST` | `/api/v10/channels/:channelId/messages` | Bot token | [1.5](#15-send-message) |
| `PATCH` | `/api/v10/channels/:channelId/messages/:messageId` | Bot token | [1.6](#16-edit-message) |
| `PUT` | `/api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me` | Bot token | [1.7](#17-add-reaction) |
| `PATCH` | `/api/v10/webhooks/:clientId/:interactionToken/messages/@original` | None | [1.8](#18-edit-interaction-response) |
| `POST` | `/api/v10/webhooks/:clientId/:interactionToken` | None | [1.9](#19-send-followup) |
| `PUT` | `/api/v10/applications/:clientId/guilds/:guildId/commands` | Bot token | [1.10](#110-bulk-overwrite-guild-commands) |

### Test Control Routes

| Method | Path | Section |
|--------|------|---------|
| `POST` | `/_test/tenants` | [2.1](#21-create-tenant) |
| `DELETE` | `/_test/tenants/:tenantId` | [2.2](#22-delete-tenant) |
| `GET` | `/_test/:tenantId/messages/:channelId` | [2.3](#23-get-messages) |
| `GET` | `/_test/:tenantId/reactions` | [2.4](#24-get-reactions) |
| `GET` | `/_test/:tenantId/interaction-responses/:token` | [2.5](#25-get-interaction-response) |
| `GET` | `/_test/:tenantId/followups/:token` | [2.6](#26-get-followups) |
| `GET` | `/_test/:tenantId/commands/:guildId` | [2.7](#27-get-registered-commands) |
| `POST` | `/_test/:tenantId/reset` | [2.8](#28-reset-tenant-state) |
| `POST` | `/_test/:tenantId/auth-code` | [2.9](#29-create-authorization-code) |
| `POST` | `/_test/:tenantId/send-interaction` | [2.10](#210-send-signed-interaction) |
| `GET` | `/_test/:tenantId/audit-logs` | [2.11](#211-get-audit-logs) |

### Browse Routes

| Method | Path | Section |
|--------|------|---------|
| `GET` | `/_test/browse/tenants` | [3.1](#31-list-tenants) |
| `GET` | `/_test/browse/tenants/:tenantId` | [3.2](#32-tenant-detail) |
| `GET` | `/_test/browse/tenants/:tenantId/state` | [3.3](#33-tenant-state) |
| `GET` | `/_test/browse/audit-logs` | [3.4](#34-global-audit-logs) |
