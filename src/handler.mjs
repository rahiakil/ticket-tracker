import QRCode from "qrcode";
import { commitJson } from "./commit.mjs";
import {
  MESSAGES,
  REQUEST_ID_RE,
  applyEventStatus,
  applyIssue,
  applyScan,
  applyUnsee,
  codeUrl,
  dashboard,
  extractCode,
  generateCodes,
  replacePassword,
  reportCsv,
} from "./logic.mjs";
import { authenticate, hashPassword, verifyPassword } from "./passwords.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import {
  SESSION_MAX_AGE,
  clearSessionCookie,
  createSession,
  csrfMatches,
  readCookie,
  readSession,
  sessionCookie,
} from "./sessions.mjs";

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;

async function defaultSvg(value) {
  return QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

function clientIp(ip) {
  return String(ip || "unknown").replace(/^::ffff:/, "");
}

export function createApiHandler(options) {
  const {
    store,
    sessionSecret,
    allowedOrigins = [],
    qrPageUrls = ["https://rahiakil.github.io/ticket-tracker/"],
    publicPageUrl = "https://rahiakil.github.io/ticket-tracker/",
    demo = false,
    cookieSameSite = "Lax",
    now = () => Date.now(),
    rateLimiter = createRateLimiter(),
    limits = {
      loginUser: 8,
      loginIp: 30,
      loginWindowMs: 15 * 60 * 1000,
      scan: 40,
      scanWindowMs: 60 * 1000,
    },
    svgFor = defaultSvg,
  } = options;

  function cors(request) {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    const selfOrigin = new URL(request.url).origin;
    if (origin !== selfOrigin && !allowedOrigins.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    };
  }

  function json(request, body, status = 200, extra = {}) {
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...cors(request),
      ...extra,
    });
    return new Response(JSON.stringify(body), { status, headers });
  }

  function originAllowed(request) {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    const selfOrigin = new URL(request.url).origin;
    return origin === selfOrigin || allowedOrigins.includes(origin);
  }

  function secureCookie(request) {
    return new URL(request.url).protocol === "https:";
  }

  function cookieOptions(request, maxAge) {
    return { maxAge, secure: secureCookie(request), sameSite: cookieSameSite };
  }

  async function sessionFrom(request) {
    if (!sessionSecret) return null;
    const token = readCookie(request.headers.get("cookie"), "tt_session");
    return readSession(sessionSecret, token, now());
  }

  async function readJson(request) {
    const type = request.headers.get("content-type") || "";
    if (!type.includes("application/json")) return { error: "bad_type" };
    const text = await request.text();
    if (text.length > 8192) return { error: "too_large" };
    try {
      const value = text ? JSON.parse(text) : {};
      if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "bad_json" };
      return { value };
    } catch {
      return { error: "bad_json" };
    }
  }

  function pageUrls(request) {
    const urls = [...qrPageUrls];
    if (demo) urls.push(`${new URL(request.url).origin}/`);
    return urls;
  }

  async function requireUser(request, roles) {
    const session = await sessionFrom(request);
    if (!session) return { error: json(request, { ok: false, message: "Not signed in." }, 401) };
    if (!roles.includes(session.role)) return { error: json(request, { ok: false, message: "Not allowed." }, 403) };
    if (!csrfMatches(session, request.headers.get("x-csrf-token"))) {
      return { error: json(request, { ok: false, message: "Session check failed. Refresh and try again." }, 403) };
    }
    if (session.mustChangePassword && new URL(request.url).pathname !== "/api/password") {
      return { error: json(request, { ok: false, message: "Change the setup password before using Ticket Tracker." }, 403) };
    }
    return { session };
  }

  function iso() {
    return new Date(now()).toISOString();
  }

  async function mutateState(mutate) {
    return commitJson((...args) => store.readState(...args), (...args) => store.writeState(...args), mutate);
  }

  return async function handle(request, context = {}) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "OPTIONS") {
        if (!originAllowed(request)) return json(request, { ok: false, message: "Not allowed." }, 403);
        return new Response(null, { status: 204, headers: cors(request) });
      }
      if (!originAllowed(request)) return json(request, { ok: false, message: "Not allowed." }, 403);

      if (request.method === "GET" && path === "/api/health") {
        const configured = Boolean(store && sessionSecret);
        return json(request, { ok: configured, mode: configured ? (demo ? "demo" : "github") : "unconfigured", demo: Boolean(demo) });
      }

      if (request.method === "GET" && path === "/api/session") {
        const session = await sessionFrom(request);
        if (!session) return json(request, { authenticated: false, demo: Boolean(demo) });
        return json(request, {
          authenticated: true,
          username: session.username,
          role: session.role,
          csrfToken: session.csrfToken,
          mustChangePassword: Boolean(session.mustChangePassword),
          demo: Boolean(demo),
        });
      }

      if (request.method === "POST" && path === "/api/login") {
        if (!store || !sessionSecret) {
          return json(request, { ok: false, message: "The sign-in service is not connected yet." }, 503);
        }
        const body = await readJson(request);
        if (body.error) return json(request, { ok: false, message: "Incorrect username or password." }, 400);
        const username = typeof body.value.username === "string" ? body.value.username.trim() : "";
        const password = body.value.password;
        const ip = clientIp(context.ip);
        const windowMs = limits.loginWindowMs;
        if (rateLimiter.tooMany(`login-ip:${ip}`, limits.loginIp, windowMs, now()) || rateLimiter.tooMany(`login-user:${ip}:${username.toLowerCase()}`, limits.loginUser, windowMs, now())) {
          return json(request, { ok: false, message: "Too many attempts. Wait and try again." }, 429);
        }
        let usersDoc;
        try {
          usersDoc = await store.readUsers();
        } catch {
          return json(request, { ok: false, message: "The sign-in service is not connected yet." }, 503);
        }
        const validName = USER_RE.test(username) ? username : "";
        const user = await authenticate(usersDoc.data, validName, password);
        if (!user) {
          rateLimiter.hit(`login-ip:${ip}`, windowMs, now());
          rateLimiter.hit(`login-user:${ip}:${username.toLowerCase()}`, windowMs, now());
          return json(request, { ok: false, message: "Incorrect username or password." }, 401);
        }
        const session = await createSession(sessionSecret, user, now());
        return json(
          request,
          { ok: true, username: user.username, role: user.role, csrfToken: session.csrfToken, mustChangePassword: user.mustChangePassword, expiresAt: new Date(session.expiresAt).toISOString(), demo: Boolean(demo) },
          200,
          { "Set-Cookie": sessionCookie(session.token, cookieOptions(request, SESSION_MAX_AGE)) },
        );
      }

      if (request.method === "POST" && path === "/api/logout") {
        return json(request, { ok: true }, 200, { "Set-Cookie": clearSessionCookie(cookieOptions(request, 0)) });
      }

      if (request.method === "POST" && path === "/api/scans") {
        const auth = await requireUser(request, ["admin", "scanner"]);
        if (auth.error) return auth.error;
        const ip = clientIp(context.ip);
        if (rateLimiter.tooMany(`scan:${auth.session.username}`, limits.scan, limits.scanWindowMs, now())) {
          return json(request, { ok: false, outcome: "save_failed", message: MESSAGES.save_failed }, 429);
        }
        rateLimiter.hit(`scan:${auth.session.username}`, limits.scanWindowMs, now());
        const body = await readJson(request);
        if (body.error || typeof body.value.raw !== "string" || !REQUEST_ID_RE.test(body.value.requestId || "")) {
          return json(request, { ok: false, outcome: "save_failed", message: MESSAGES.save_failed }, 400);
        }
        const code = extractCode(body.value.raw, pageUrls(request));
        if (!code) return json(request, { ok: false, outcome: "invalid", message: MESSAGES.invalid }, 200);
        const saved = await mutateState((state) => applyScan(state, {
          code,
          requestId: body.value.requestId,
          actor: auth.session.username,
          at: iso(),
        }));
        return json(request, saved.result, saved.result.outcome === "save_failed" ? 503 : saved.result.outcome === "closed" ? 403 : 200);
      }

      if (request.method === "GET" && path === "/api/admin") {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const current = await store.readState();
        return json(request, { ok: true, ...dashboard(current.data) });
      }

      if (request.method === "POST" && path === "/api/unsee") {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const body = await readJson(request);
        const reason = cleanReason(body.value?.reason);
        if (body.error || !REQUEST_ID_RE.test(body.value?.requestId || "") || typeof body.value.code !== "string" || reason === null) {
          return json(request, { ok: false, message: MESSAGES.save_failed }, 400);
        }
        const saved = await mutateState((state) => applyUnsee(state, {
          code: body.value.code,
          requestId: body.value.requestId,
          actor: auth.session.username,
          reason,
          at: iso(),
        }));
        const status = saved.result.outcome === "save_failed" ? 503 : 200;
        return json(request, saved.result, status);
      }

      if (request.method === "POST" && path === "/api/event") {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const body = await readJson(request);
        if (body.error || !REQUEST_ID_RE.test(body.value?.requestId || "")) {
          return json(request, { ok: false, message: MESSAGES.save_failed }, 400);
        }
        const saved = await mutateState((state) => applyEventStatus(state, {
          status: body.value.status,
          requestId: body.value.requestId,
          actor: auth.session.username,
          at: iso(),
        }));
        return json(request, saved.result, saved.result.outcome === "save_failed" ? 503 : 200);
      }

      if (request.method === "POST" && path === "/api/codes") {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const body = await readJson(request);
        const count = Number(body.value?.count);
        if (body.error || !REQUEST_ID_RE.test(body.value?.requestId || "") || !Number.isInteger(count) || count < 1 || count > 50) {
          return json(request, { ok: false, message: "Choose between 1 and 50 codes." }, 400);
        }
        const saved = await mutateState((state) => applyIssue(state, {
          codes: state.processedRequestIds?.[body.value.requestId]?.codes
            || generateCodes(state.issued.map((item) => item.id), count),
          requestId: body.value.requestId,
          actor: auth.session.username,
          at: iso(),
        }));
        if (!saved.result.ok) return json(request, saved.result, saved.result.outcome === "closed" ? 403 : 503);
        const codes = [];
        for (const id of saved.result.codes) {
          const link = codeUrl(publicPageUrl, id);
          codes.push({ id, url: link, svg: await svgFor(link) });
        }
        return json(request, { ok: true, message: "Codes issued", codes });
      }

      const qrMatch = path.match(/^\/api\/codes\/([A-Za-z0-9_-]{22,80})\/qr\.svg$/);
      if (request.method === "GET" && qrMatch) {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const current = await store.readState();
        if (!current.data.issued.some((item) => item.id === qrMatch[1])) {
          return json(request, { ok: false, message: MESSAGES.invalid }, 404);
        }
        const svg = await svgFor(codeUrl(publicPageUrl, qrMatch[1]));
        return new Response(svg, {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...cors(request),
          },
        });
      }

      if (request.method === "GET" && (path === "/api/report.json" || path === "/api/report.csv")) {
        const auth = await requireUser(request, ["admin"]);
        if (auth.error) return auth.error;
        const current = await store.readState();
        const view = dashboard(current.data);
        if (path.endsWith(".csv")) {
          return new Response(reportCsv(view), {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": "attachment; filename=\"ticket-tracker-report.csv\"",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              ...cors(request),
            },
          });
        }
        const report = {
          schemaVersion: 1,
          exportedAt: iso(),
          event: view.event,
          codes: view.codes,
          history: view.history,
        };
        return new Response(JSON.stringify(report, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": "attachment; filename=\"ticket-tracker-report.json\"",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...cors(request),
          },
        });
      }

      if (request.method === "POST" && path === "/api/password") {
        const auth = await requireUser(request, ["admin", "scanner"]);
        if (auth.error) return auth.error;
        const body = await readJson(request);
        const nextPassword = body.value?.newPassword;
        const currentPassword = body.value?.currentPassword;
        if (body.error || typeof nextPassword !== "string" || typeof currentPassword !== "string") {
          return json(request, { ok: false, message: "Could not change the password." }, 400);
        }
        if (nextPassword.length < 10 || nextPassword.length > 200 || nextPassword === auth.session.username || nextPassword === currentPassword) {
          return json(request, { ok: false, message: "Use at least 10 characters, different from the username and the current password." }, 400);
        }
        const usersDoc = await store.readUsers();
        const user = usersDoc.data.users.find((item) => item.username === auth.session.username);
        const currentOk = await verifyPassword(currentPassword, user?.passwordHash || "");
        if (!currentOk) return json(request, { ok: false, message: "Incorrect username or password." }, 401);
        const passwordHash = await hashPassword(nextPassword);
        const saved = await commitJson((...args) => store.readUsers(...args), (...args) => store.writeUsers(...args), (users) => (
          replacePassword(users, auth.session.username, passwordHash, iso())
        ));
        if (!saved.result?.ok) return json(request, { ok: false, message: MESSAGES.save_failed }, 503);
        const refreshed = await createSession(sessionSecret, {
          username: auth.session.username,
          role: auth.session.role,
          mustChangePassword: false,
        }, now());
        return json(
          request,
          { ok: true, message: "Password changed.", csrfToken: refreshed.csrfToken, mustChangePassword: false },
          200,
          { "Set-Cookie": sessionCookie(refreshed.token, cookieOptions(request, SESSION_MAX_AGE)) },
        );
      }

      return json(request, { ok: false, message: "Not found." }, 404);
    } catch {
      return json(request, { ok: false, outcome: "save_failed", message: MESSAGES.save_failed }, 503);
    }
  };
}

function cleanReason(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > 200) return null;
  return value.replace(/[\u0000-\u001f]/g, " ").trim();
}
