import { spawn, type ChildProcess } from "child_process";

const PORT = 3210;
const URL = `http://localhost:${PORT}/_test/browse/tenants`;
const STARTUP_TIMEOUT_MS = 30_000;

let serverProcess: ChildProcess | null = null;

async function isPortOpen(): Promise<boolean> {
  try {
    const resp = await fetch(URL);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForServer(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    if (await isPortOpen()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Server did not start on port ${PORT} within ${STARTUP_TIMEOUT_MS}ms`
  );
}

export async function setup(): Promise<void> {
  if (await isPortOpen()) {
    // Server is already running externally — don't manage it
    return;
  }

  serverProcess = spawn("npx", ["fling", "dev"], {
    stdio: "pipe",
    cwd: import.meta.dirname,
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start fling dev server:", err);
  });

  await waitForServer();
}

export async function teardown(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
