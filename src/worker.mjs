import { handleLive } from "./live-door.mjs";
import { githubStore } from "./github-store.mjs";
import { createApiHandler } from "./handler.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { warmupPasswords } from "./passwords.mjs";

const rateLimiter = createRateLimiter();
let warmed = false;

function handlerFor(env) {
  const configured = Boolean(env.SESSION_SECRET && env.GITHUB_TOKEN && env.DATA_REPO);
  const publicPageUrl = env.PUBLIC_PAGE_URL || "https://rahiakil.github.io/ticket-tracker/";
  return createApiHandler({
    store: configured
      ? githubStore({
          token: env.GITHUB_TOKEN,
          repo: env.DATA_REPO,
          branch: env.DATA_BRANCH || "main",
        })
      : null,
    sessionSecret: env.SESSION_SECRET || "",
    allowedOrigins: (env.ALLOWED_ORIGINS || "https://rahiakil.github.io")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    qrPageUrls: [publicPageUrl],
    publicPageUrl,
    demo: false,
    cookieSameSite: env.COOKIE_SAMESITE || "Lax",
    rateLimiter,
  });
}

export default {
  async fetch(request, env) {
    if (!warmed) {
      warmed = true;
      await warmupPasswords();
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/live") return handleLive(request, env);
    if (url.pathname.startsWith("/api/") || request.method === "OPTIONS") {
      const ip = request.headers.get("cf-connecting-ip") || "";
      return handlerFor(env)(request, { ip });
    }
    if (!env.ASSETS) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
