/**
 * Populates the fake-discord dev server with a bunch of data
 * so you can visually inspect the UI at http://localhost:5173
 *
 * Usage: npx tsx scripts/populate-ui-data.ts
 */

const API_BASE = "http://localhost:3210";

async function fetchJson(
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

// ── Create two tenants ──────────────────────────────────────────────

async function createTenant(label: string) {
  const suffix = `ui-${label}-${Date.now()}`;
  const resp = await fetchJson("/_test/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botToken: `bot-${suffix}`,
      clientId: `client-${suffix}`,
      clientSecret: `secret-${suffix}`,
      // Use a dummy keypair (the populate script doesn't need real signing)
      publicKey: "a".repeat(64),
      privateKey: "b".repeat(64),
      guilds: {
        [`guild-${suffix}`]: {
          name: `${label} Guild`,
          channels: {
            [`chan-${suffix}-general`]: { name: "general" },
            [`chan-${suffix}-random`]: { name: "random" },
          },
        },
      },
    }),
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`Failed to create tenant ${label}: ${JSON.stringify(resp.body)}`);
  }

  const data = resp.body as { tenantId: string };
  console.log(`✓ Created tenant "${label}" → ${data.tenantId}`);

  return {
    tenantId: data.tenantId,
    botToken: `bot-${suffix}`,
    clientId: `client-${suffix}`,
    clientSecret: `secret-${suffix}`,
    guildId: `guild-${suffix}`,
    channels: [
      `chan-${suffix}-general`,
      `chan-${suffix}-random`,
    ],
  };
}

async function main() {
  console.log("Populating fake-discord with UI test data...\n");

  // Create two tenants for variety
  const alice = await createTenant("alice");
  const bob = await createTenant("bob");

  // ── Alice: lots of messages ───────────────────────────────────────

  console.log("\n— Alice: sending messages —");

  const messages: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const { status, body } = await fetchJson(
      `/api/v10/channels/${alice.channels[0]}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${alice.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `Hello from Alice, message #${i}` }),
      }
    );
    const msg = body as { id: string };
    messages.push(msg.id);
    console.log(`  POST message #${i} → ${status}`);
  }

  // Edit a few messages
  console.log("\n— Alice: editing messages —");
  for (let i = 0; i < 3; i++) {
    const { status } = await fetchJson(
      `/api/v10/channels/${alice.channels[0]}/messages/${messages[i]}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${alice.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `Edited message #${i + 1} (v2)` }),
      }
    );
    console.log(`  PATCH message ${messages[i]} → ${status}`);
  }

  // Add reactions
  console.log("\n— Alice: adding reactions —");
  const emojis = ["👍", "❤️", "🎉", "🚀"];
  for (let i = 0; i < emojis.length; i++) {
    const emoji = encodeURIComponent(emojis[i]);
    const { status } = await fetchJson(
      `/api/v10/channels/${alice.channels[0]}/messages/${messages[i]}/reactions/${emoji}/@me`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${alice.botToken}`,
        },
      }
    );
    console.log(`  PUT reaction ${emojis[i]} on message ${messages[i]} → ${status}`);
  }

  // Get channel info
  console.log("\n— Alice: fetching channels —");
  for (const ch of alice.channels) {
    const { status } = await fetchJson(`/api/v10/channels/${ch}`, {
      headers: { Authorization: `Bot ${alice.botToken}` },
    });
    console.log(`  GET channel ${ch} → ${status}`);
  }

  // Messages in second channel
  console.log("\n— Alice: messages in #random —");
  for (let i = 1; i <= 3; i++) {
    const { status } = await fetchJson(
      `/api/v10/channels/${alice.channels[1]}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${alice.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `Random thought #${i}` }),
      }
    );
    console.log(`  POST message in #random → ${status}`);
  }

  // Simulate slash command interactions (user invokes /command, bot responds)
  // Token format: "cmd:<command-name>:<unique>" so the UI can show what was invoked
  console.log("\n— Alice: simulating slash command interactions —");
  const interactions = [
    { cmd: "ping", token: "cmd:ping:001", response: "Pong! Latency: 42ms", followup: "📊 Average latency over last hour: 38ms" },
    { cmd: "help", token: "cmd:help:002", response: "**Available Commands:**\n• `/ping` — Check bot latency\n• `/help` — Show this message\n• `/roll <sides>` — Roll a die" },
    { cmd: "roll 6", token: "cmd:roll:003", response: "🎲 You rolled a **4** (d6)", followup: "🎲 Rolling again... you got a **2**!" },
  ];
  for (const ix of interactions) {
    // Bot responds to the interaction
    const { status } = await fetchJson(
      `/api/v10/webhooks/${alice.clientId}/${ix.token}/messages/@original`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: ix.response }),
      }
    );
    console.log(`  /${ix.cmd} → bot response ${status}`);

    // Bot sends a followup (if any)
    if (ix.followup) {
      const { status: fStatus } = await fetchJson(
        `/api/v10/webhooks/${alice.clientId}/${ix.token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: ix.followup }),
        }
      );
      console.log(`    ↳ followup ${fStatus}`);
    }
  }

  // Register some slash commands
  console.log("\n— Alice: registering commands —");
  const commands = [
    { name: "ping", description: "Check bot latency", type: 1 },
    { name: "help", description: "Show help info", type: 1 },
    {
      name: "roll",
      description: "Roll dice",
      type: 1,
      options: [
        {
          name: "sides",
          description: "Number of sides",
          type: 4,
          required: false,
        },
      ],
    },
  ];
  const { status: cmdStatus } = await fetchJson(
    `/api/v10/applications/${alice.clientId}/guilds/${alice.guildId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${alice.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    }
  );
  console.log(`  PUT bulk overwrite commands → ${cmdStatus}`);

  // OAuth flow
  console.log("\n— Alice: OAuth flow —");
  const redirectUri = "http://localhost:9999/callback";
  const authResp = await fetch(
    `${API_BASE}/oauth2/authorize?client_id=${alice.clientId}&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(redirectUri)}`,
    { redirect: "manual" }
  );
  console.log(`  GET authorize → ${authResp.status}`);
  if (authResp.status === 302) {
    const location = authResp.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;
    const { status: tokenStatus } = await fetchJson(`/api/v10/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: alice.clientId,
        client_secret: alice.clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });
    console.log(`  POST token exchange → ${tokenStatus}`);
  }

  // ── Bob: fewer calls ──────────────────────────────────────────────

  console.log("\n— Bob: sending messages —");
  for (let i = 1; i <= 4; i++) {
    const { status } = await fetchJson(
      `/api/v10/channels/${bob.channels[0]}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${bob.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `Bob's message #${i}` }),
      }
    );
    console.log(`  POST message #${i} → ${status}`);
  }

  // ── Some failed auth calls (generate null-tenant audit entries) ───

  console.log("\n— Invalid auth calls —");
  for (const path of [
    "/api/v10/channels/nonexistent",
    "/api/v10/channels/fake/messages",
    "/api/v10/applications/nope/commands",
  ]) {
    const { status } = await fetchJson(path, {
      headers: { Authorization: "Bot totally-invalid-token" },
    });
    console.log(`  GET ${path} → ${status}`);
  }

  // No auth at all
  const { status: noAuthStatus } = await fetchJson(
    "/api/v10/channels/whatever/messages",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no auth" }),
    }
  );
  console.log(`  POST (no auth) → ${noAuthStatus}`);

  // ── Summary ───────────────────────────────────────────────────────

  console.log("\n\n=== Done! ===");
  console.log(`\nTenants created:`);
  console.log(`  Alice: ${alice.tenantId}`);
  console.log(`  Bob:   ${bob.tenantId}`);
  console.log(`\nOpen http://localhost:5173 to see the UI.`);
  console.log(
    `Browse audit logs at: ${API_BASE}/_test/browse/audit-logs?limit=100`
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
