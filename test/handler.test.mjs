import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createApiHandler } from "../src/handler.mjs";
import { MESSAGES, emptyState } from "../src/logic.mjs";
import { createMemoryStore } from "../src/memory-store.mjs";
import { hashPassword, verifyPassword, warmupPasswords } from "../src/passwords.mjs";

const PAGE = "https://rahiakil.github.io/ticket-tracker/";
const CODE = "aaaaaaaaaaaaaaaaaaaaaa";
let adminHash = "";
let scannerHash = "";

before(async () => {
  await warmupPasswords();
  adminHash = await hashPassword("correct horse");
  scannerHash = await hashPassword("scanner horse");
});

function watched(store) {
  const writeState = store.writeState.bind(store);
  let writes = 0;
  store.writeState = async (...args) => {
    writes += 1;
    return writeState(...args);
  };
  store.writes = () => writes;
  return store;
}

function fixture(extraUser) {
  let now = Date.parse("2026-09-29T17:00:00.000Z");
  const state = emptyState("2026-09-29T00:00:00.000Z");
  state.issued.push({ id: CODE, issuedAt: state.event.updatedAt });
  state.statuses[CODE] = { seen: false, firstSeenAt: null, cycle: 1 };
  const users = {
    schemaVersion: 1,
    users: [
      { username: "Ada Admin", role: "admin", passwordHash: adminHash },
      { username: "Sam Scanner", role: "scanner", passwordHash: scannerHash },
    ],
  };
  if (extraUser) users.users.push(extraUser);
  const store = watched(createMemoryStore({ state, users }));
  const handler = createApiHandler({
    store,
    sessionSecret: "test-session-secret-should-be-long-enough",
    allowedOrigins: ["https://rahiakil.github.io"],
    qrPageUrls: [PAGE],
    publicPageUrl: PAGE,
    now: () => now,
  });
  return { handler, store, setNow(value) { now = value; } };
}

function call(handler, path, options = {}) {
  const headers = new Headers();
  const base = options.base || "http://127.0.0.1:8787";
  if (options.origin !== null) headers.set("Origin", options.origin || base);
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  return handler(new Request(`${base}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }), { ip: options.ip || "203.0.113.10" });
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  assert.match(raw, /HttpOnly/);
  assert.equal(raw.includes("Domain="), false);
  return raw.split(";")[0];
}

async function login(handler, username = "Ada Admin", password = "correct horse", options = {}) {
  const response = await call(handler, "/api/login", { method: "POST", body: { username, password }, ...options });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(JSON.stringify(data).includes("scrypt"), false);
  assert.equal(JSON.stringify(data).includes(password), false);
  return { cookie: cookieFrom(response), csrf: data.csrfToken, data, response };
}

test("login sets an expiring cookie and logout clears it", async () => {
  const { handler } = fixture();
  const auth = await login(handler, "Ada Admin", "correct horse", { base: "https://127.0.0.1:8787" });
  assert.match(auth.response.headers.get("set-cookie"), /Secure/);
  assert.match(auth.response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(auth.response.headers.get("set-cookie"), /Max-Age=28800/);
  const session = await call(handler, "/api/session", { cookie: auth.cookie, base: "https://127.0.0.1:8787" });
  assert.equal((await session.json()).username, "Ada Admin");
  const loggedOut = await call(handler, "/api/logout", { method: "POST", cookie: auth.cookie, base: "https://127.0.0.1:8787" });
  assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
});

test("unknown users and wrong passwords get the same response", async () => {
  const { handler } = fixture();
  const missing = await call(handler, "/api/login", { method: "POST", body: { username: "Missing Person", password: "correct horse" } });
  const wrong = await call(handler, "/api/login", { method: "POST", body: { username: "Ada Admin", password: "wrong horse" } });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal((await missing.json()).message, (await wrong.json()).message);
});

test("login attempts are rate limited", async () => {
  const { handler } = fixture();
  const limited = createApiHandler({
    store: (await (async () => fixture().store)()),
    sessionSecret: "test-session-secret-should-be-long-enough",
    allowedOrigins: ["https://rahiakil.github.io"],
    qrPageUrls: [PAGE],
    publicPageUrl: PAGE,
    limits: { loginUser: 2, loginIp: 10, loginWindowMs: 15 * 60 * 1000, scan: 40, scanWindowMs: 60000 },
  });
  const first = await call(limited, "/api/login", { method: "POST", body: { username: "Ada Admin", password: "nope" }, ip: "203.0.113.20" });
  const second = await call(limited, "/api/login", { method: "POST", body: { username: "Ada Admin", password: "nope" }, ip: "203.0.113.20" });
  const third = await call(limited, "/api/login", { method: "POST", body: { username: "Ada Admin", password: "correct horse" }, ip: "203.0.113.20" });
  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
  void handler;
});

test("rejected and repeated reads do not change stored scans", async () => {
  const fx = fixture();
  const health = await call(fx.handler, "/api/health");
  const session = await call(fx.handler, "/api/session");
  const users = await call(fx.handler, "/users.json");
  const getScan = await call(fx.handler, "/api/scans");
  assert.equal(health.status, 200);
  assert.equal((await session.json()).authenticated, false);
  assert.equal(users.status, 404);
  assert.equal(getScan.status, 404);
  assert.equal(fx.store.writes(), 0);
  const foreign = await call(fx.handler, "/api/login", { method: "POST", body: { username: "Ada Admin", password: "correct horse" }, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
});

test("scans record once, reject bad codes, and survive a conflict plus a retry", async () => {
  const fx = fixture();
  const auth = await login(fx.handler);
  const evil = await call(fx.handler, "/api/scans", {
    method: "POST",
    body: { raw: `https://evil.example/?c=${CODE}`, requestId: crypto.randomUUID(), actor: "intruder" },
    ...auth,
  });
  assert.equal((await evil.json()).message, MESSAGES.invalid);
  assert.equal(fx.store.writes(), 0);

  let conflicted = false;
  const write = fx.store.writeState.bind(fx.store);
  fx.store.writeState = async (...args) => {
    fx.store.writes = fx.store.writes;
    if (!conflicted) {
      conflicted = true;
      return { ok: false, conflict: true };
    }
    return write(...args);
  };
  const requestId = crypto.randomUUID();
  const recorded = await call(fx.handler, "/api/scans", {
    method: "POST",
    body: { raw: `${PAGE}?c=${CODE}`, requestId, actor: "intruder" },
    ...auth,
  });
  const recordedBody = await recorded.json();
  assert.equal(recordedBody.message, MESSAGES.recorded);
  assert.deepEqual(Object.keys(recordedBody).sort(), ["message", "ok", "outcome"]);
  const retry = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId }, ...auth });
  assert.equal((await retry.json()).message, MESSAGES.recorded);
  const saved = await fx.store.readState();
  assert.equal(saved.data.events.length, 1);
  assert.equal(saved.data.events[0].actor, "Ada Admin");
  const again = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...auth });
  assert.equal((await again.json()).message, MESSAGES.already_seen);
  const after = await fx.store.readState();
  assert.equal(after.data.events.length, 1);
});

test("unauthenticated and non-admin reversals do not write", async () => {
  const fx = fixture();
  const anon = await call(fx.handler, "/api/unsee", { method: "POST", body: { code: CODE, requestId: crypto.randomUUID() } });
  assert.equal(anon.status, 401);
  const scanner = await login(fx.handler, "Sam Scanner", "scanner horse");
  const denied = await call(fx.handler, "/api/unsee", {
    method: "POST",
    body: { code: CODE, requestId: crypto.randomUUID() },
    ...scanner,
  });
  assert.equal(denied.status, 403);
  const admin = await login(fx.handler);
  const missingCsrf = await call(fx.handler, "/api/unsee", {
    method: "POST",
    cookie: admin.cookie,
    body: { code: CODE, requestId: crypto.randomUUID() },
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(fx.store.writes(), 0);
  const tampered = await call(fx.handler, "/api/admin", { cookie: `${admin.cookie}x`, csrf: admin.csrf });
  assert.equal(tampered.status, 401);
});

test("closed events reject scans while export and undo still work", async () => {
  const fx = fixture();
  const auth = await login(fx.handler);
  const scanned = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...auth });
  assert.equal((await scanned.json()).outcome, "recorded");
  const closed = await call(fx.handler, "/api/event", { method: "POST", body: { status: "closed", requestId: crypto.randomUUID() }, ...auth });
  assert.equal((await closed.json()).status, "closed");
  const blocked = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...auth });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).message, MESSAGES.closed);
  const report = await call(fx.handler, "/api/report.json", auth);
  const body = await report.json();
  assert.equal(body.event.status, "closed");
  assert.equal(JSON.stringify(body).includes("passwordHash"), false);
  assert.equal(JSON.stringify(body).includes("processedRequestIds"), false);
  const undone = await call(fx.handler, "/api/unsee", {
    method: "POST",
    body: { code: CODE, reason: "Correct the record", requestId: crypto.randomUUID() },
    ...auth,
  });
  assert.equal((await undone.json()).message, "Marked as unseen");
  const state = await fx.store.readState();
  assert.equal(state.data.events.some((event) => event.type === "scan"), true);
  assert.equal(state.data.statuses[CODE].seen, false);
});

test("scan, undo, and scan again keep both scan events", async () => {
  const fx = fixture();
  const auth = await login(fx.handler);
  await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...auth });
  await call(fx.handler, "/api/unsee", { method: "POST", body: { code: CODE, reason: "", requestId: crypto.randomUUID() }, ...auth });
  fx.setNow(Date.parse("2026-09-29T19:00:00.000Z"));
  const second = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...auth });
  assert.equal((await second.json()).message, MESSAGES.recorded);
  const view = await (await call(fx.handler, "/api/admin", auth)).json();
  assert.equal(view.codes[0].seen, true);
  assert.equal(view.codes[0].firstSeenAt, "2026-09-29T19:00:00.000Z");
  assert.equal(view.history.filter((event) => event.type === "scan").length, 2);
  assert.equal(view.history.some((event) => event.type === "reversal"), true);
  const csv = await (await call(fx.handler, "/api/report.csv", auth)).text();
  assert.match(csv, /sample|aaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(csv.includes("passwordHash"), false);
});

test("setup passwords must be changed before scans", async () => {
  const fx = fixture({ username: "New Admin", role: "admin", passwordHash: adminHash, mustChangePassword: true });
  const auth = await login(fx.handler, "New Admin", "correct horse");
  assert.equal(auth.data.mustChangePassword, true);
  const blocked = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, cookie: auth.cookie, csrf: auth.csrf });
  assert.equal(blocked.status, 403);
  const changed = await call(fx.handler, "/api/password", {
    method: "POST",
    body: { currentPassword: "correct horse", newPassword: "a much stronger secret" },
    cookie: auth.cookie,
    csrf: auth.csrf,
  });
  const changedBody = await changed.json();
  assert.equal(changed.status, 200);
  const next = { cookie: cookieFrom(changed), csrf: changedBody.csrfToken };
  const scanned = await call(fx.handler, "/api/scans", { method: "POST", body: { raw: CODE, requestId: crypto.randomUUID() }, ...next });
  assert.equal((await scanned.json()).message, MESSAGES.recorded);
  const users = await fx.store.readUsers();
  assert.equal(users.data.users.find((user) => user.username === "New Admin").mustChangePassword, false);
  assert.equal(await verifyPassword("a much stronger secret", users.data.users.find((user) => user.username === "New Admin").passwordHash), true);
});

test("issued QR downloads are admin-only and a huge hash cost is ignored", async () => {
  const fx = fixture();
  const anonymous = await call(fx.handler, `/api/codes/${CODE}/qr.svg`);
  assert.equal(anonymous.status, 401);
  const auth = await login(fx.handler);
  const issued = await call(fx.handler, "/api/codes", { method: "POST", body: { count: 1, requestId: crypto.randomUUID() }, ...auth });
  const body = await issued.json();
  assert.equal(issued.status, 200);
  assert.match(body.codes[0].svg, /<svg/);
  assert.match(body.codes[0].url, /^https:\/\/rahiakil\.github\.io\/ticket-tracker\/\?c=/);
  const svg = await call(fx.handler, `/api/codes/${body.codes[0].id}/qr.svg`, auth);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal(await verifyPassword("hunter2", "scrypt$1048576$8$1$00112233445566778899aabbccddeeff$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), false);
});

test("an expired session cannot undo a scan", async () => {
  const fx = fixture();
  const auth = await login(fx.handler);
  fx.setNow(Date.parse("2026-09-30T03:00:00.000Z"));
  const expired = await call(fx.handler, "/api/unsee", {
    method: "POST",
    body: { code: CODE, requestId: crypto.randomUUID() },
    ...auth,
  });
  assert.equal(expired.status, 401);
  assert.equal(fx.store.writes(), 0);
});
