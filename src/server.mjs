import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { fileStore } from "./file-store.mjs";
import { githubStore } from "./github-store.mjs";
import { createApiHandler } from "./handler.mjs";
import { warmupPasswords } from "./passwords.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function resolveWebFile(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(requested);
  const file = path.resolve(webRoot, `.${decoded}`);
  const relative = path.relative(webRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

async function serveStatic(urlPath) {
  const file = resolveWebFile(urlPath);
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    const body = await readFile(file);
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=300",
    };
    if (path.extname(file) === ".html") {
      headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
      headers["Permissions-Policy"] = "camera=(self)";
    }
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function nodeRequest(req) {
  const host = req.headers.host || "127.0.0.1";
  const protocol = req.socket?.encrypted ? "https:" : "http:";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else if (value != null) headers.set(key, value);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = body;
  return new Request(`${protocol}//${host}${req.url}`, init);
}

async function writeNodeResponse(res, response) {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie?.() || [];
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader("set-cookie", cookies);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

export async function startServer(options = {}) {
  await warmupPasswords();
  const demo = options.demo ?? !options.store;
  const sessionSecret = options.sessionSecret || randomBytes(32).toString("hex");
  const publicPageUrl = options.publicPageUrl || "https://rahiakil.github.io/ticket-tracker/";
  const handler = options.handler || createApiHandler({
    store: options.store,
    sessionSecret,
    allowedOrigins: options.allowedOrigins || ["https://rahiakil.github.io"],
    qrPageUrls: options.qrPageUrls || [publicPageUrl],
    publicPageUrl,
    demo,
    cookieSameSite: options.cookieSameSite || "Lax",
    now: options.now,
    rateLimiter: options.rateLimiter,
    limits: options.limits,
  });

  const server = createServer(async (req, res) => {
    try {
      const request = await nodeRequest(req);
      const url = new URL(request.url);
      const response = url.pathname.startsWith("/api/")
        ? await handler(request, { ip: req.socket.remoteAddress || "" })
        : await serveStatic(url.pathname);
      await writeNodeResponse(res, response);
    } catch {
      res.statusCode = 500;
      res.end("Could not save—retry");
    }
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, options.host || "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    demo,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function storeFromEnv() {
  if (process.env.GITHUB_TOKEN && process.env.DATA_REPO) {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      throw new Error("Set SESSION_SECRET to at least 32 characters before using the GitHub data repository.");
    }
    if ((process.env.COOKIE_SAMESITE || "Lax") === "None" && process.env.COOKIE_SECURE === "false") {
      throw new Error("SameSite=None cookies require HTTPS.");
    }
    return {
      store: githubStore({
        token: process.env.GITHUB_TOKEN,
        repo: process.env.DATA_REPO,
        branch: process.env.DATA_BRANCH || "main",
      }),
      demo: false,
      sessionSecret: process.env.SESSION_SECRET,
    };
  }
  const directory = path.resolve(process.env.DEMO_DIR || "data-local");
  try {
    await access(path.join(directory, "users.json"));
    await access(path.join(directory, "event-state.json"));
  } catch {
    throw new Error("Demo data is missing. From the project folder run: npm run init-demo");
  }
  return {
    store: fileStore(directory),
    demo: true,
    sessionSecret: process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
      ? process.env.SESSION_SECRET
      : randomBytes(32).toString("hex"),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = await storeFromEnv();
  const port = Number(process.env.PORT || 8787);
  const started = await startServer({ ...selected, port, host: process.env.HOST || "127.0.0.1" });
  const mode = started.demo ? "Demo mode — local JSON only, not the live event file." : "GitHub data repository.";
  console.log(`Ticket Tracker listening on ${started.url}`);
  console.log(mode);
}
