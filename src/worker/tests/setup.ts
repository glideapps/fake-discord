import * as ed from "@noble/ed25519";

export const API_BASE = "http://localhost:3210";

// Deterministic 32-byte seed for tests
const seed = new Uint8Array(32);
seed[0] = 1;

export const TEST_PRIVATE_KEY = bytesToHex(seed);

// Public key derived lazily (async)
let _testPublicKey: string | null = null;
export async function getTestPublicKey(): Promise<string> {
  if (!_testPublicKey) {
    const pubKey = await ed.getPublicKeyAsync(seed);
    _testPublicKey = bytesToHex(pubKey);
  }
  return _testPublicKey;
}

// Pre-compute for module-level export (tests will await getTestPublicKey)
export let TEST_PUBLIC_KEY = "";

// Initialize at module load time using top-level await
const _pubKey = await ed.getPublicKeyAsync(seed);
TEST_PUBLIC_KEY = bytesToHex(_pubKey);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let tenantCounter = 0;

export interface TestTenantConfig {
  tenantId: string;
  botToken: string;
  clientId: string;
  clientSecret: string;
  publicKey: string;
  privateKey: string;
  guildId: string;
  channelId: string;
  channelId2: string;
}

export async function createTestTenant(
  overrides: Partial<{
    botToken: string;
    clientId: string;
    clientSecret: string;
  }> = {}
): Promise<TestTenantConfig> {
  tenantCounter++;
  const suffix = `${Date.now()}-${tenantCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const botToken = overrides.botToken || `test-bot-${suffix}`;
  const clientId = overrides.clientId || `test-client-${suffix}`;
  const clientSecret = overrides.clientSecret || `test-secret-${suffix}`;
  const guildId = `guild-${suffix}`;
  const channelId = `chan-${suffix}-1`;
  const channelId2 = `chan-${suffix}-2`;

  const resp = await fetch(`${API_BASE}/_test/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botToken,
      clientId,
      clientSecret,
      publicKey: TEST_PUBLIC_KEY,
      privateKey: TEST_PRIVATE_KEY,
      guilds: {
        [guildId]: {
          name: "Test Guild",
          channels: {
            [channelId]: { name: "general" },
            [channelId2]: { name: "bot-commands" },
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to create tenant (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { tenantId: string };
  return {
    tenantId: data.tenantId,
    botToken,
    clientId,
    clientSecret,
    publicKey: TEST_PUBLIC_KEY,
    privateKey: TEST_PRIVATE_KEY,
    guildId,
    channelId,
    channelId2,
  };
}

export async function deleteTenant(tenantId: string): Promise<void> {
  await fetch(`${API_BASE}/_test/tenants/${tenantId}`, {
    method: "DELETE",
  });
}

export async function fetchJson(
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${API_BASE}${path}`, options);
  const text = await resp.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}
