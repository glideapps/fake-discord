# Fake Discord Service Specification

A multi-tenant fake Discord API server for integration testing. Deployed as a Cloudflare Worker alongside the real platform workers, it impersonates Discord's API so the Discord plugin worker can be tested end-to-end without touching real Discord.

## Architecture

The fake is a single Cloudflare Worker backed by a Durable Object (`FakeDiscordState`) that holds all state in memory. Every request is routed to the same DO instance, ensuring consistent state across concurrent requests.

The Discord plugin worker is configured to point at this fake via a `DISCORD_API_BASE_URL` environment variable that overrides the default `https://discord.com/api/v10`.

## Route Map

### Discord API Routes (impersonate Discord)

These routes are called by the Discord plugin worker. They live under `/api/v10/` and `/oauth2/` to match Discord's URL structure.

| Method | Path | Section |
|--------|------|---------|
| `GET` | `/oauth2/authorize` | [1.1](#11-oauth-authorize) |
| `POST` | `/api/v10/oauth2/token` | [1.2](#12-oauth-token-exchange) |
| `GET` | `/api/v10/users/@me` | [1.3](#13-user-identity) |
| `GET` | `/api/v10/channels/:channelId` | [1.4](#14-get-channel) |
| `POST` | `/api/v10/channels/:channelId/messages` | [1.5](#15-send-message) |
| `PATCH` | `/api/v10/channels/:channelId/messages/:messageId` | [1.6](#16-edit-message) |
| `PUT` | `/api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me` | [1.7](#17-add-reaction) |
| `PATCH` | `/api/v10/webhooks/:clientId/:interactionToken/messages/@original` | [1.8](#18-edit-interaction-response) |
| `POST` | `/api/v10/webhooks/:clientId/:interactionToken` | [1.9](#19-send-followup) |
| `PUT` | `/api/v10/applications/:clientId/guilds/:guildId/commands` | [1.10](#110-bulk-overwrite-guild-commands) |

### Test Control Routes

These routes are called by the smoke test runner. They are **not** part of the Discord API.

| Method | Path | Section |
|--------|------|---------|
| `POST` | `/__test/tenants` | [2.1](#21-create-tenant) |
| `DELETE` | `/__test/tenants/:tenantId` | [2.2](#22-delete-tenant) |
| `GET` | `/__test/:tenantId/messages/:channelId` | [2.3](#23-get-messages) |
| `GET` | `/__test/:tenantId/reactions` | [2.4](#24-get-reactions) |
| `GET` | `/__test/:tenantId/interaction-responses/:token` | [2.5](#25-get-interaction-response) |
| `GET` | `/__test/:tenantId/followups/:token` | [2.6](#26-get-followups) |
| `GET` | `/__test/:tenantId/commands/:guildId` | [2.7](#27-get-registered-commands) |
| `POST` | `/__test/:tenantId/reset` | [2.8](#28-reset-tenant-state) |
| `POST` | `/__test/:tenantId/auth-code` | [2.9](#29-create-authorization-code) |
| `POST` | `/__test/:tenantId/send-interaction` | [2.10](#210-send-signed-interaction) |
| `GET` | `/__test/:tenantId/audit-logs` | [2.11](#211-get-audit-logs) |
| `GET` | `/__test/browse/audit-logs` | [3.4](#34-global-audit-logs) |

---

## 1. Discord API Endpoints

All responses use `Content-Type: application/json` unless otherwise noted.

### 1.1 OAuth Authorize

Simulates the Discord consent screen. Instead of showing UI, immediately redirects back with an authorization code.

**Request:**

```
GET /oauth2/authorize?client_id=X&redirect_uri=X&response_type=code&scope=X&state=X&permissions=X
```

All query parameters are accepted; unknown ones are ignored.

**Tenant resolution:** Look up tenant by `client_id` query parameter.

**Behavior:**
1. Resolve tenant from `client_id`. Return `400` if no tenant found.
2. Generate a random authorization code, store it in tenant state with `{ guildId: <first guild in tenant config>, redirectUri: <from query> }`.
3. Return `302` redirect:

```
Location: <redirect_uri>?code=<code>&state=<state>&guild_id=<first_guild_id>
```

**Error responses:**
- `400 { "error": "Unknown client_id" }` — no tenant has this client ID

### 1.2 OAuth Token Exchange

**Request:**

```
POST /api/v10/oauth2/token
Content-Type: application/x-www-form-urlencoded

client_id=X&client_secret=X&grant_type=authorization_code&code=X&redirect_uri=X
```

**Tenant resolution:** Look up tenant by `client_id` form field.

**Behavior:**
1. Resolve tenant from `client_id`. Return `401` if not found.
2. Validate `client_secret` matches tenant config. Return `401` if mismatch.
3. Look up `code` in tenant's authorization codes. Return `401` if not found or expired.
4. Validate `redirect_uri` matches the stored redirect URI. Return `400` if mismatch.
5. Delete the authorization code (one-time use).
6. Generate a unique access token (e.g., `fake-at-<tenantId>-<random>`).
7. Store access token in a global map: `accessToken → tenantId` (for `/users/@me` resolution).
8. Look up the guild ID that was stored with the auth code.

**Response (200):**

```json
{
  "access_token": "<generated>",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "fake-rt-<random>",
  "scope": "identify guilds bot applications.commands",
  "guild": {
    "id": "<guildId from auth code>",
    "name": "<guild name from tenant config>"
  }
}
```

**Error responses:**
- `401 { "error": "invalid_client" }` — unknown `client_id` or wrong `client_secret`
- `401 { "error": "invalid_grant" }` — unknown or already-used `code`
- `400 { "error": "invalid_request", "error_description": "redirect_uri mismatch" }` — redirect URI doesn't match

### 1.3 User Identity

**Request:**

```
GET /api/v10/users/@me
Authorization: Bearer <access_token>
```

**Tenant resolution:** Look up tenant by access token (from the global access token → tenant map).

**Behavior:**
1. Extract Bearer token from Authorization header. Return `401` if missing.
2. Look up tenant from access token. Return `401` if not found.

**Response (200):**

```json
{
  "id": "fake-user-<tenantId>",
  "username": "fakeuser",
  "global_name": "Fake User (<tenantId>)",
  "discriminator": "0"
}
```

**Error responses:**
- `401 { "message": "401: Unauthorized" }` — missing or invalid token

### 1.4 Get Channel

**Request:**

```
GET /api/v10/channels/:channelId
Authorization: Bot <bot_token>
```

**Tenant resolution:** Look up tenant by bot token from `Authorization: Bot <token>` header.

**Behavior:**
1. Resolve tenant from bot token. Return `401` if not found.
2. Look up `channelId` in tenant's channel map. Return `404` if not found.

**Response (200):**

```json
{
  "id": "<channelId>",
  "guild_id": "<guildId>",
  "name": "<channel name>",
  "type": 0
}
```

**Error responses:**
- `401 { "message": "401: Unauthorized" }` — invalid bot token
- `404 { "message": "Unknown Channel" }` — channel not in tenant config

### 1.5 Send Message

**Request:**

```
POST /api/v10/channels/:channelId/messages
Authorization: Bot <bot_token>
Content-Type: application/json

{ "content": "...", "embeds": [...], ... }
```

**Tenant resolution:** Bot token.

**Behavior:**
1. Resolve tenant, validate channel exists. Return `404` if channel unknown.
2. Generate a unique message ID (e.g., `msg-<counter>`).
3. Store the **full request body** in tenant's messages list for `channelId`.

**Response (200):**

```json
{
  "id": "<generated_message_id>",
  "channel_id": "<channelId>",
  "content": "<content from body, or empty string>"
}
```

**Error responses:**
- `401` — invalid bot token
- `404 { "message": "Unknown Channel" }` — channel not found

### 1.6 Edit Message

**Request:**

```
PATCH /api/v10/channels/:channelId/messages/:messageId
Authorization: Bot <bot_token>
Content-Type: application/json

{ "content": "...", "embeds": [...], ... }
```

**Tenant resolution:** Bot token.

**Behavior:**
1. Resolve tenant, validate channel exists.
2. Find message by `messageId` in tenant's messages for `channelId`. Return `404` if not found.
3. Append the old payload to the message's `editHistory` array.
4. Replace the message's current payload with the new request body.

**Response (200):**

```json
{
  "id": "<messageId>",
  "channel_id": "<channelId>",
  "content": "<new content>"
}
```

**Error responses:**
- `401` — invalid bot token
- `404 { "message": "Unknown Message" }` — message not found

### 1.7 Add Reaction

**Request:**

```
PUT /api/v10/channels/:channelId/messages/:messageId/reactions/:emoji/@me
Authorization: Bot <bot_token>
```

The `:emoji` segment is URL-encoded (e.g., `%E2%9C%85` for a checkmark). The fake must URL-decode it before storing.

**Tenant resolution:** Bot token.

**Behavior:**
1. Resolve tenant, validate channel and message exist.
2. URL-decode the emoji.
3. Append `{ channelId, messageId, emoji }` to tenant's reactions list.

**Response:** `204 No Content` (empty body)

**Error responses:**
- `401` — invalid bot token
- `404` — unknown channel or message

### 1.8 Edit Interaction Response

**Request:**

```
PATCH /api/v10/webhooks/:clientId/:interactionToken/messages/@original
Content-Type: application/json

{ "content": "...", "embeds": [...], "flags": 64, ... }
```

**No Authorization header.** This matches real Discord behavior.

**Tenant resolution:** Look up tenant by `clientId` path parameter.

**Behavior:**
1. Resolve tenant from `clientId`. Return `404` if not found.
2. Store the **full request body** in tenant's interaction responses map, keyed by `interactionToken`.

**Response (200):**

```json
{
  "id": "resp-<counter>",
  "content": "<content from body>"
}
```

**Error responses:**
- `404 { "message": "Unknown Application" }` — no tenant with this client ID

### 1.9 Send Followup

**Request:**

```
POST /api/v10/webhooks/:clientId/:interactionToken
Content-Type: application/json

{ "content": "...", "embeds": [...], "flags": 64, ... }
```

**No Authorization header.**

**Tenant resolution:** Look up tenant by `clientId` path parameter.

**Behavior:**
1. Resolve tenant from `clientId`.
2. Generate a unique followup ID.
3. Append the **full request body** (plus generated ID) to tenant's followups list, keyed by `interactionToken`.

**Response (200):**

```json
{
  "id": "followup-<counter>",
  "channel_id": "chan-followup",
  "content": "<content from body>"
}
```

**Error responses:**
- `404 { "message": "Unknown Application" }` — no tenant with this client ID

### 1.10 Bulk Overwrite Guild Commands

**Request:**

```
PUT /api/v10/applications/:clientId/guilds/:guildId/commands
Authorization: Bot <bot_token>
Content-Type: application/json

[
  {
    "name": "ping",
    "description": "Ping the bot",
    "type": 1,
    "options": [
      { "name": "target", "type": 3, "description": "Who to ping", "required": true }
    ]
  }
]
```

**Tenant resolution:** Bot token. Cross-check that `clientId` matches tenant's configured `clientId`.

**Behavior:**
1. Resolve tenant, validate `clientId` matches, validate `guildId` is in tenant's guilds.
2. **Replace** (not merge) the command list for this guild.
3. Assign each command a generated ID.

**Response (200):** Array of commands with IDs:

```json
[
  {
    "id": "cmd-<counter>",
    "name": "ping",
    "description": "Ping the bot",
    "type": 1,
    "application_id": "<clientId>",
    "guild_id": "<guildId>",
    "options": [...]
  }
]
```

**Error responses:**
- `401` — invalid bot token
- `400 { "message": "client_id mismatch" }` — `clientId` param doesn't match tenant
- `404 { "message": "Unknown Guild" }` — guild not in tenant config

---

## 2. Test Control Endpoints

These are used by the smoke test runner for setup, teardown, and assertions. They are **not** part of the Discord API surface.

### 2.1 Create Tenant

**Request:**

```
POST /__test/tenants
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
| `botToken` | string | yes | Unique bot token for this tenant. Used to resolve tenant from `Authorization: Bot` headers. |
| `clientId` | string | yes | Unique client ID. Used to resolve tenant from OAuth params and webhook paths. |
| `clientSecret` | string | yes | Client secret for OAuth token exchange validation. |
| `publicKey` | string | yes | Ed25519 public key (hex). Set as `DISCORD_PUBLIC_KEY` in the plugin worker. |
| `privateKey` | string | yes | Ed25519 private key (hex). Used by `send-interaction` to sign payloads. |
| `guilds` | object | yes | Map of guild ID → `{ name, channels }`. Channels is a map of channel ID → `{ name }`. |

**Validation:**
- `botToken` must be unique across all tenants
- `clientId` must be unique across all tenants
- At least one guild with at least one channel

**Response (201):**

```json
{
  "tenantId": "<generated UUID>",
  "botToken": "fake-bot-token-abc123",
  "clientId": "fake-client-id-abc123",
  "guilds": ["guild-abc123"]
}
```

**Error responses:**
- `400 { "error": "Missing required field: ..." }` — validation failure
- `409 { "error": "botToken already in use" }` — duplicate bot token
- `409 { "error": "clientId already in use" }` — duplicate client ID

### 2.2 Delete Tenant

```
DELETE /__test/tenants/:tenantId
```

Removes the tenant and all its state (messages, reactions, commands, auth codes, access tokens).

**Response (200):**

```json
{ "deleted": true }
```

**Error responses:**
- `404 { "error": "Tenant not found" }`

### 2.3 Get Messages

```
GET /__test/:tenantId/messages/:channelId
```

Returns all messages sent to a channel by this tenant, in chronological order.

**Response (200):**

```json
{
  "messages": [
    {
      "id": "msg-1",
      "channelId": "chan-abc123",
      "payload": { "content": "Hello!", "embeds": [] },
      "editHistory": [
        { "payload": { "content": "Helo!" }, "editedAt": "2026-02-15T10:00:00Z" }
      ],
      "createdAt": "2026-02-15T09:59:00Z"
    }
  ]
}
```

Each message includes:
- `id` — generated message ID
- `channelId` — the channel
- `payload` — the **full** request body from the most recent send/edit
- `editHistory` — array of previous payloads (empty if never edited), each with `editedAt` timestamp
- `createdAt` — when the message was originally sent

**Error responses:**
- `404 { "error": "Tenant not found" }`

Returns `{ "messages": [] }` if the channel exists but has no messages.

### 2.4 Get Reactions

```
GET /__test/:tenantId/reactions
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
      "createdAt": "2026-02-15T10:01:00Z"
    }
  ]
}
```

**Error responses:**
- `404 { "error": "Tenant not found" }`

### 2.5 Get Interaction Response

```
GET /__test/:tenantId/interaction-responses/:token
```

Returns the reply that was sent for a specific interaction token.

**Response (200):**

```json
{
  "payload": { "content": "Pong!", "embeds": [], "flags": 0 },
  "respondedAt": "2026-02-15T10:02:00Z"
}
```

**Error responses:**
- `404 { "error": "Tenant not found" }`
- `404 { "error": "No response for this interaction token" }` — interaction token not found

### 2.6 Get Followups

```
GET /__test/:tenantId/followups/:token
```

Returns all followup messages for a specific interaction token, in order.

**Response (200):**

```json
{
  "followups": [
    {
      "id": "followup-1",
      "payload": { "content": "Additional info", "embeds": [] },
      "createdAt": "2026-02-15T10:03:00Z"
    }
  ]
}
```

**Error responses:**
- `404 { "error": "Tenant not found" }`

Returns `{ "followups": [] }` if the token exists but has no followups.

### 2.7 Get Registered Commands

```
GET /__test/:tenantId/commands/:guildId
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
      "registeredAt": "2026-02-15T10:04:00Z"
    }
  ]
}
```

**Error responses:**
- `404 { "error": "Tenant not found" }`

Returns `{ "commands": [] }` if no commands have been registered for this guild.

### 2.8 Reset Tenant State

```
POST /__test/:tenantId/reset
```

Clears all mutable state for this tenant (messages, reactions, interaction responses, followups, registered commands, auth codes, access tokens) but preserves the tenant config (bot token, client ID, guild topology).

**Response (200):**

```json
{ "reset": true }
```

**Error responses:**
- `404 { "error": "Tenant not found" }`

### 2.9 Create Authorization Code

Pre-generates an authorization code for programmatic OAuth testing. This bypasses the `/oauth2/authorize` redirect flow.

**Request:**

```
POST /__test/:tenantId/auth-code
Content-Type: application/json

{
  "guildId": "guild-abc123",
  "redirectUri": "https://discord-plugin.workers.dev/oauth/callback"
}
```

**Behavior:**
1. Validate `guildId` is in tenant's guilds.
2. Generate a random code.
3. Store it in tenant's auth codes map: `code → { guildId, redirectUri }`.

**Response (200):**

```json
{
  "code": "<generated code>",
  "guildId": "guild-abc123"
}
```

**Error responses:**
- `404 { "error": "Tenant not found" }`
- `400 { "error": "Unknown guild: ..." }` — guild not in tenant config

### 2.10 Send Signed Interaction

Convenience endpoint that signs a Discord interaction payload and POSTs it to a webhook URL, simulating Discord sending an interaction to the platform.

**Request:**

```
POST /__test/:tenantId/send-interaction
Content-Type: application/json

{
  "webhookUrl": "https://discord-plugin.workers.dev/webhook",
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

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookUrl` | string | yes | The full URL to POST the signed interaction to (the plugin worker's `/webhook` endpoint). |
| `interaction` | object | yes | The Discord interaction payload. Must include at minimum: `type`, `id`, `application_id`, `token`. |

**Behavior:**
1. Resolve tenant. Return `404` if not found.
2. Import the tenant's Ed25519 private key.
3. Generate a timestamp: `String(Math.floor(Date.now() / 1000))`.
4. Serialize `interaction` to JSON string (`body`).
5. Sign `timestamp + body` using Ed25519, producing a hex-encoded signature.
6. POST to `webhookUrl` with headers:
   - `Content-Type: application/json`
   - `X-Signature-Ed25519: <signature hex>`
   - `X-Signature-Timestamp: <timestamp>`
7. Return the webhook's response.

**Response (200):**

```json
{
  "statusCode": 200,
  "body": { "type": 5 }
}
```

The `statusCode` and `body` reflect the response from the webhook URL. If the webhook returns a non-JSON response, `body` is the raw text.

**Error responses:**
- `404 { "error": "Tenant not found" }`
- `400 { "error": "Missing required field: webhookUrl" }`
- `400 { "error": "Missing required field: interaction" }`
- `502 { "error": "Webhook request failed: <details>" }` — network error calling the webhook URL

---

## 3. State Model

### Per-Tenant State

Each tenant holds isolated state. No state is shared between tenants.

```
TenantState {
  // Immutable config (set at creation)
  config: {
    botToken: string
    clientId: string
    clientSecret: string
    publicKey: string     // Ed25519 public key hex
    privateKey: string    // Ed25519 private key hex
    guilds: Map<guildId, {
      name: string
      channels: Map<channelId, { name: string }>
    }>
  }

  createdAt: string  // ISO 8601 timestamp, set at creation

  // Mutable state (cleared by reset)
  authCodes: Map<code, { guildId: string, redirectUri: string }>
  messages: Map<channelId, Message[]>
  reactions: Array<{ channelId, messageId, emoji, createdAt }>
  interactionResponses: Map<interactionToken, { payload, respondedAt }>
  followups: Map<interactionToken, Array<{ id, payload, createdAt }>>
  registeredCommands: Map<guildId, Array<{ id, payload, registeredAt }>>
  auditLogs: Array<{ id, method, url, requestBody, responseStatus, responseBody, createdAt }>
  nextId: number  // monotonic counter for generating unique IDs
}

Message {
  id: string
  channelId: string
  payload: object       // full request body
  editHistory: Array<{ payload: object, editedAt: string }>
  createdAt: string
}
```

### Global State (Cross-Tenant Indexes)

These indexes enable tenant resolution from Discord API requests:

```
GlobalState {
  tenants: Map<tenantId, TenantState>
  botTokenIndex: Map<botToken, tenantId>       // for Authorization: Bot
  clientIdIndex: Map<clientId, tenantId>        // for OAuth + webhook paths
  accessTokenIndex: Map<accessToken, tenantId>  // for Authorization: Bearer
}
```

### Tenant Resolution Table

| Endpoint Pattern | Resolution Method |
|------------------|-------------------|
| `Authorization: Bot <token>` | `botTokenIndex[token]` |
| `client_id` query/form param | `clientIdIndex[clientId]` |
| `Authorization: Bearer <token>` | `accessTokenIndex[token]` |
| `/webhooks/:clientId/...` path | `clientIdIndex[clientId]` |
| `/applications/:clientId/...` path | `clientIdIndex[clientId]` (cross-checked with bot token) |
| `/__test/:tenantId/...` path | Direct lookup in `tenants[tenantId]` |

---

## 4. Error Handling

### Auth Validation

The fake validates auth on every request to catch bugs where the plugin sends wrong credentials:

- **Bot token validation:** If `Authorization: Bot <token>` is present, it must resolve to a valid tenant. Return `401` otherwise.
- **Bearer token validation:** If `Authorization: Bearer <token>` is present, it must be a token previously issued by `/oauth2/token`. Return `401` otherwise.
- **Client ID cross-check:** On endpoints that have both a bot token header and a `clientId` path param (e.g., bulk overwrite commands), the fake verifies they belong to the same tenant. Return `400` on mismatch.

### Unknown Routes

Any request that doesn't match a known route returns:

```
404 { "message": "404: Not Found" }
```

### Malformed Requests

Missing `Content-Type: application/json` on POST/PATCH/PUT bodies, or unparseable JSON:

```
400 { "message": "Invalid request body" }
```
