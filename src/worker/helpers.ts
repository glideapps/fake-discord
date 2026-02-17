import { db } from "flingit";
import type { Context } from "hono";
import * as ed from "@noble/ed25519";

// --- Tenant resolution ---

export interface TenantRow {
  id: string;
  bot_token: string;
  client_id: string;
  client_secret: string;
  public_key: string;
  private_key: string;
  next_id: number;
}

export async function resolveTenantByBotToken(
  token: string
): Promise<TenantRow | null> {
  return (await db
    .prepare("SELECT * FROM tenants WHERE bot_token = ?")
    .bind(token)
    .first()) as TenantRow | null;
}

export async function resolveTenantByClientId(
  clientId: string
): Promise<TenantRow | null> {
  return (await db
    .prepare("SELECT * FROM tenants WHERE client_id = ?")
    .bind(clientId)
    .first()) as TenantRow | null;
}

export async function resolveTenantByAccessToken(
  token: string
): Promise<TenantRow | null> {
  return (await db
    .prepare(
      `SELECT t.* FROM tenants t
       JOIN access_tokens at ON at.tenant_id = t.id
       WHERE at.token = ?`
    )
    .bind(token)
    .first()) as TenantRow | null;
}

export async function resolveTenantById(
  tenantId: string
): Promise<TenantRow | null> {
  return (await db
    .prepare("SELECT * FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first()) as TenantRow | null;
}

// --- ID generation ---

export async function generateId(
  tenantId: string,
  prefix: string
): Promise<string> {
  const row = await db
    .prepare(
      "UPDATE tenants SET next_id = next_id + 1 WHERE id = ? RETURNING next_id"
    )
    .bind(tenantId)
    .first();
  const nextId = (row as { next_id: number }).next_id;
  return `${prefix}-${nextId - 1}`;
}

// --- Auth header parsing ---

export function extractBotToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bot\s+(.+)$/);
  return match ? match[1] : null;
}

export function extractBearerToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

// --- Body parsing with Content-Type validation ---

export async function requireJsonBody(
  c: Context
): Promise<Record<string, unknown> | Response> {
  const ct = c.req.header("Content-Type") || "";
  if (!ct.match(/^application\/json(;|$)/i)) {
    return c.json({ message: "Invalid request body" }, 400);
  }
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ message: "Invalid request body" }, 400);
  }
}

export async function requireFormBody(
  c: Context
): Promise<URLSearchParams | Response> {
  const ct = c.req.header("Content-Type") || "";
  if (!ct.match(/^application\/x-www-form-urlencoded(;|$)/i)) {
    return c.json({ message: "Invalid request body" }, 400);
  }
  try {
    const text = await c.req.text();
    return new URLSearchParams(text);
  } catch {
    return c.json({ message: "Invalid request body" }, 400);
  }
}

// --- Crypto utilities ---

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getPrivateKeyBytes(privateKeyHex: string): Uint8Array {
  const keyBytes = hexToBytes(privateKeyHex);
  if (keyBytes.length === 32) {
    return keyBytes; // 32-byte seed, used directly by @noble/ed25519
  }
  // 64-byte "secret key" (seed + public key concatenated) — extract the seed
  return keyBytes.slice(0, 32);
}

export async function getPublicKey(privateKeyHex: string): Promise<Uint8Array> {
  const seed = getPrivateKeyBytes(privateKeyHex);
  return ed.getPublicKeyAsync(seed);
}

export async function signPayload(
  privateKeyHex: string,
  timestamp: string,
  body: string
): Promise<string> {
  const seed = getPrivateKeyBytes(privateKeyHex);
  const message = new TextEncoder().encode(timestamp + body);
  const signature = await ed.signAsync(message, seed);
  return bytesToHex(signature);
}

export async function verifySignature(
  signatureHex: string,
  message: Uint8Array,
  publicKeyHex: string
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  return ed.verifyAsync(signature, message, publicKey);
}
