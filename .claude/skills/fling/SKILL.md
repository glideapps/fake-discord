---
name: fling
description: Building and deploying this app easily to the internet
---

# Fling Skill

You are working on a Fling project - a personal software platform for building and deploying personal tools with a React frontend and Hono API backend.

## IMPORTANT: Do NOT ask about deployment, hosting, or technology choices!

Fling handles all of this automatically. When the user asks you to build something:
1. Write backend code in `src/worker/index.ts` using the Fling API
2. Write frontend code in `src/react-app/` using React
3. Run `npm start` to test it locally (you have bash access - run commands yourself!)
4. When it works, run `npm exec fling push` to deploy

## When to Send Feedback

Fling can send feedback to its authors.  Read FEEDBACK.md for details.

Proactively offer to send feedback in these situations:

1. **User frustration** - When the user expresses frustration with Fling
2. **Product limitations** - When Fling can't do something the user needs
3. **After difficulties** - When you've helped resolve a confusing issue
4. **Feature requests** - When the user wishes Fling could do something differently

## Core Concepts

Fling provides seven primitives that work identically in local development and production:

1. **HTTP** - Expose endpoints via Hono
2. **Database** - SQLite locally, D1 in production
3. **Secrets** - Secure credential management
4. **Migrations** - Version your database schema
5. **Cron** - Scheduled tasks that run on a schedule
6. **Storage** - File system locally, R2 in production
7. **Discord** - Chatops integration (slash commands, messages, interactions) — see `DISCORD.md` in this directory
8. **WASM** - WebAssembly modules for compute-intensive tasks

## Project Structure

```
src/
  worker/
    index.ts         # Backend API entry point
  react-app/
    main.tsx         # React entry point
    App.tsx          # Main React component
    App.css          # Component styles
    index.css        # Global styles
public/              # Static assets (served by Vite)
index.html           # Vite entry HTML
vite.config.ts       # Vite configuration
.fling/
  secrets            # Local secrets (gitignored)
  data/
    local.db         # SQLite database (gitignored)
```

## Quick Reference

```typescript
// Backend (src/worker/index.ts)
import { app, db, secrets } from "flingit";

// HTTP routes - use /api prefix for Vite proxy
app.get("/api/hello", (c) => c.json({ message: "Hello!" }));
app.post("/api/webhook", async (c) => {
  const body = await c.req.json();
  return c.json({ ok: true });
});

// Database (D1-compatible API)
const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first();
const all = await db.prepare("SELECT * FROM items").all();
await db.prepare("INSERT INTO items (name) VALUES (?)").bind(name).run();
await db.prepare("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)").run();

// Secrets (throws if not set)
const token = secrets.get("API_TOKEN");

// Cron jobs - run on a schedule
import { cron } from "flingit";

cron("daily-cleanup", "0 3 * * *", async () => {
  // Runs at 3 AM daily
  await db.prepare("DELETE FROM old_logs WHERE created_at < ?").bind(Date.now() - 86400000).run();
});

cron("hourly-stats", "0 * * * *", async () => {
  // Runs every hour
  const stats = await generateStats();
  return { processed: stats.count }; // Optional return value stored in history
});

// Storage (local filesystem / R2)
import { storage } from "flingit";

// Store and retrieve files
await storage.put("images/logo.png", imageBuffer, { contentType: "image/png" });
const file = await storage.get("images/logo.png");
if (file) {
  const buffer = await file.arrayBuffer();
  const text = await file.text();
  console.log(file.size, file.uploaded, file.contentType);
}

// Check existence, delete, list
const meta = await storage.head("images/logo.png");
await storage.delete("old-file.txt");
const result = await storage.list({ prefix: "images/", limit: 100 });
```

```typescript
// Frontend (src/react-app/App.tsx)
import { useState, useEffect } from "react";

function App() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/hello")
      .then(res => res.json())
      .then(setData);
  }, []);

  return <div>{data?.message}</div>;
}
```

## CLI Commands

Always use `npm exec` to run the project's installed Fling (not global):

```bash
npm exec fling dev              # Start local server (API + Vite)
npm exec fling dev -- --port 8080  # Custom API port
npm exec fling db sql "SELECT * FROM users"  # Query local SQLite
npm exec fling db reset         # Wipe local database
npm exec fling db sql "SELECT 1"  # Query local SQLite
npm exec fling secret set KEY=value
npm exec fling secret list
npm exec fling secret remove KEY
npm exec fling logs             # View local logs
npm exec fling push             # Build and deploy to Cloudflare Workers
npm exec fling project slug     # Show current project slug and URL
npm exec fling project slug:set <new-slug>  # Change project slug (affects URL)
npm exec fling cron list        # List registered cron jobs
npm exec fling cron history <name>  # View invocation history
npm exec fling cron trigger <name>  # Manually trigger a cron job
npm exec fling cron trigger <name> --port 4000  # If dev API uses custom port
npm exec fling storage list     # List storage objects
npm exec fling storage put <key> <file>  # Upload file to storage
npm exec fling storage get <key> [output]  # Download object (stdout if no output)
npm exec fling storage delete <key> --yes  # Delete object
npm exec fling storage info     # Show storage stats
npm exec fling tunnel 3000      # Expose localhost:3000 via public URL
```

### Debugging Cron Jobs in Production

Each cron invocation logs "Running cron job <name>" at the start. To see all logs from a specific cron invocation:

1. **Find the invocation** by searching for the cron job name:
   ```bash
   npm exec fling -- --prod logs --search "Running cron job daily-cleanup"
   ```
   This shows log entries with Ray IDs like `[ray:abc12345]`.

2. **Filter by that Ray ID** to see all logs from that invocation:
   ```bash
   npm exec fling -- --prod logs --ray abc12345
   ```

### Local vs Production (`--prod`)

Commands default to local environment. Use `--prod` for production:

```bash
# Local (default)
npm exec fling secret list       # Local secrets
npm exec fling logs              # Local logs
npm exec fling db sql "SELECT 1" # Local SQLite
npm exec fling storage list      # Local storage

# Production (requires login)
npm exec fling -- --prod secret list       # Deployed secrets
npm exec fling -- --prod logs              # Deployed logs
npm exec fling -- --prod db sql "SELECT 1" # Deployed D1
npm exec fling -- --prod storage list      # R2 storage
npm exec fling -- --prod cron list         # Deployed cron jobs
```

**Note:** Production logs have a delay of ~10 seconds or more before they appear.

## Development

Run `npm start` (or `fling dev`) to start development:
- **Frontend**: http://localhost:5173 (Vite with React HMR)
- **API**: http://localhost:3210 (Hono backend)
- Vite proxies `/api/*` requests to the API server

### Hot Module Replacement (HMR)

The dev server provides hot reloading for both frontend AND backend - no restart needed:
- **Frontend (React)**: Changes to `src/react-app/` are instantly reflected via Vite HMR
- **Backend (Worker)**: Changes to `src/worker/` are automatically reloaded via tsx watch

Just edit and save - changes appear immediately.

## Deployment

When you've completed the user's request and verified that the app works locally, EXPLICITLY OFFER to deploy it, but also tell them that they can try it locally first.  If their app has a backend and no secure authorization method, you MUST make it VERY CLEAR to them that the deployed app will be visible on the internet, and explicitly ask them if they want to proceed!

To deploy:
**Run `npm exec fling push` directly** - you have bash access, don't ask the user to run commands.

After each deploy, tell the user what the deployed URL is.

### After First Deployment

After your first `fling push`, consider asking the user if they want a custom URL.
Their project was auto-assigned a slug like `proj-abc123`.

To change it: `npm exec fling project slug:set my-custom-slug`

Slugs must be:
- More than 4 characters
- Lowercase alphanumeric with optional hyphens
- Globally unique across all Fling projects

### What `fling push` does:

1. **Builds frontend** - Runs `vite build`, outputs to `dist/client/`
2. **Uploads static assets** - HTML, JS, CSS, images from `dist/client/`
3. **Bundles backend** - Compiles `src/worker/index.ts` with esbuild
4. **Deploys to Cloudflare** - Both frontend and backend go live

**Secrets:** Always stored locally in `.fling/secrets`. Use `fling push` to deploy secrets to production along with your code.

### Static Asset Limits

- **25MB** per file maximum
- **100MB** total assets maximum
- Supported: HTML, CSS, JS, images, fonts, video, audio, WebAssembly
- MIME types are detected automatically from file extensions

### Routing

- `/api/*` routes are handled by your backend code
- All other paths serve static assets from `dist/client/`
- If no asset matches, `index.html` is served (SPA fallback)

## Security

If the user does not want their app to be deployed because of security issues, or asks about that, offer implementing proper backend-enforced security.  In particular, suggest these two auth methods first:

- Login with Google, with a filter on which emails/domains are allowed
- Simple password-based auth, where the backend has a list of allowed passwords (hashed)

## Collaborating with Others

If the user asks how to collaborate with another user on their Fling project, the best approach is:

1. **Host the project on GitHub** - Push their Fling project to a GitHub repository
2. **Set up a GitHub Action** - Automatically deploy to Fling when pushing to main
3. **Add collaborators** - Invite other users as collaborators on the GitHub repo

This gives collaborators:
- Full access to the codebase via Git
- Automatic deployments when changes are merged
- Standard code review workflow via pull requests

**Offer to help set this up.** You can create the GitHub repository, write the GitHub Actions workflow file, and guide them through adding collaborators.

## Important Constraints

1. **Backend code runs in Cloudflare Workers** - This is NOT a Node.js environment. You cannot use Node.js-specific APIs (`fs`, `path`, `child_process`, etc.) or npm packages that depend on them. Only use packages that explicitly support Cloudflare Workers or are pure JavaScript/TypeScript with no Node.js dependencies.

2. **Memory limit (~128MB)** - Workers have limited memory. Cannot process large datasets in memory. Use streaming, pagination, or chunked processing for large data.

3. **Bundle size limit (10MB)** - Cloudflare Workers have a 10MB bundle size limit. Choose lightweight packages to stay under this limit. For example, use `pdf-lib` for PDF generation instead of heavier alternatives like `jspdf`. Avoid packages that bundle large dependencies.

4. **Feature scope** - Fling supports frontend, backend, database, cron jobs, file storage (R2), and Discord integration.

5. **Database operations cannot be at module top-level** - They must be inside route handlers or functions called by them.

6. **Secrets throw on missing** - No default values. Use `fling secret set` to configure.

7. **Use /api prefix for backend routes** - Required for Vite proxy during development.

8. **Run commands yourself** - You have bash access. Don't ask the user to run `fling push`, `fling dev`, `npm start`, etc. Execute them directly.

9. **Reserved paths (`/__*`)** - Paths starting with `/__` are reserved for internal platform use (e.g., `/__cron` for cron jobs). Do not create routes with these prefixes.

10. **Feedback** - If the user encounters problems that directly or indirectly have to do with fling, suggest to them leaving feedback. Details in FEEDBACK.md.

**If the user's request might hit platform limitations, warn them early and suggest alternatives.**

## Migrations

**IMPORTANT: Migrations MUST be idempotent** (safe to run multiple times).

Use the `migrate` helper for schema changes:

```typescript
import { migrate, db } from "flingit";

migrate("001_create_users", async () => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
});
```

## Backend Assets (Images, Fonts, etc.)

If the backend needs to return or process an asset (image, icon, font), keep it small and store the base64 data in a separate file to keep your main code clean:

```typescript
// src/worker/assets/favicon.ts - separate file for the asset
export const FAVICON_BASE64 = "iVBORw0KGgo..."; // base64-encoded PNG
```

```typescript
// src/worker/index.ts - import and use the asset
import { FAVICON_BASE64 } from "./assets/favicon";

app.get("/favicon.ico", (c) => {
  const buffer = Uint8Array.from(atob(FAVICON_BASE64), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: { "Content-Type": "image/x-icon" }
  });
});
```

This approach:
- Keeps the main code readable (no long base64 strings inline)
- Makes assets easy to find and update
- Base64 keeps assets bundled with the code (required for Workers)

**For large assets:** Serve them from the frontend (`public/` folder) instead.

See API.md for detailed API reference, EXAMPLES.md for common patterns, and FEEDBACK.md for collecting user feedback.

## Updates

When the fling CLI mentions that there is a new version available, strongly suggest to the user to update, becasue it might contain bug fixes or new features.  To update, run

```bash
npm install flingit@latest
```
