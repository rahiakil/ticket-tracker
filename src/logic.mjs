import { bytesToBase64Url } from "./encoding.mjs";

export const CODE_RE = /^[A-Za-z0-9_-]{22,80}$/;
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MESSAGES = Object.freeze({
  recorded: "Recorded",
  already_seen: "Already seen",
  invalid: "Invalid code",
  save_failed: "Could not save—retry",
  closed: "Event closed",
});

export function emptyState(now, name = "Ticket Tracker") {
  return {
    schemaVersion: 1,
    event: { name, status: "open", updatedAt: now },
    issued: [],
    statuses: {},
    events: [],
    processedRequestIds: {},
  };
}

export function emptyUsers() {
  return { schemaVersion: 1, users: [] };
}

export function saveFailed() {
  return { ok: false, outcome: "save_failed", message: MESSAGES.save_failed };
}

export function newCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function generateCodes(existingIds, count) {
  const ids = new Set(existingIds);
  const created = [];
  let guard = 0;
  while (created.length < count && guard < count * 20) {
    guard += 1;
    const id = newCode();
    if (ids.has(id)) continue;
    ids.add(id);
    created.push(id);
  }
  if (created.length !== count) throw new Error("Could not generate codes");
  return created;
}

export function codeUrl(publicPageUrl, code) {
  const url = new URL(publicPageUrl);
  url.searchParams.set("c", code);
  url.hash = "";
  return url.toString();
}

export function extractCode(raw, pageUrls) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 500) return null;
  if (CODE_RE.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const allowed = pageUrls.some((page) => {
    let expected;
    try {
      expected = new URL(page);
    } catch {
      return false;
    }
    const expectedPath = expected.pathname.endsWith("/") ? expected.pathname : `${expected.pathname}/`;
    const actualPath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return url.origin === expected.origin && actualPath === expectedPath;
  });
  if (!allowed) return null;
  const code = url.searchParams.get("c");
  if (!code || !CODE_RE.test(code)) return null;
  return code;
}

function ready(state) {
  return Boolean(
    state &&
      state.schemaVersion === 1 &&
      state.event &&
      (state.event.status === "open" || state.event.status === "closed") &&
      Array.isArray(state.issued) &&
      state.statuses &&
      Array.isArray(state.events) &&
      state.processedRequestIds,
  );
}

function priorResult(state, requestId) {
  const prior = state.processedRequestIds[requestId];
  if (!prior) return null;
  if (prior.outcome === "recorded") return { ok: true, outcome: "recorded", message: MESSAGES.recorded };
  if (prior.outcome === "reversed") return { ok: true, outcome: "reversed", message: "Marked as unseen" };
  if (prior.outcome === "issued") return { ok: true, outcome: "issued", message: "Codes issued", codes: prior.codes || [] };
  if (prior.outcome === "event_open" || prior.outcome === "event_closed") {
    const status = prior.outcome === "event_open" ? "open" : "closed";
    return { ok: true, outcome: "event_status", message: status === "open" ? "Event open" : "Event closed", status };
  }
  return null;
}

export function applyScan(state, { code, requestId, actor, at }) {
  if (!ready(state)) return { write: false, result: saveFailed() };
  const next = structuredClone(state);
  const previous = priorResult(next, requestId);
  if (previous) return { write: false, result: previous };
  if (next.event.status !== "open") return { write: false, result: { ok: false, outcome: "closed", message: MESSAGES.closed } };
  if (!next.issued.some((item) => item.id === code)) {
    return { write: false, result: { ok: false, outcome: "invalid", message: MESSAGES.invalid } };
  }
  const status = next.statuses[code] || { seen: false, firstSeenAt: null, cycle: 1 };
  if (status.seen) return { write: false, result: { ok: true, outcome: "already_seen", message: MESSAGES.already_seen } };
  status.seen = true;
  status.firstSeenAt = at;
  next.statuses[code] = status;
  next.events.push({ type: "scan", code, at, actor, cycle: status.cycle, requestId });
  next.processedRequestIds[requestId] = { outcome: "recorded", at };
  return {
    write: true,
    data: next,
    message: `Record scan ${code.slice(0, 8)}`,
    result: { ok: true, outcome: "recorded", message: MESSAGES.recorded },
  };
}

export function applyUnsee(state, { code, requestId, actor, reason, at }) {
  if (!ready(state)) return { write: false, result: saveFailed() };
  const next = structuredClone(state);
  const previous = priorResult(next, requestId);
  if (previous) return { write: false, result: previous };
  if (!next.issued.some((item) => item.id === code)) {
    return { write: false, result: { ok: false, outcome: "invalid", message: MESSAGES.invalid } };
  }
  const status = next.statuses[code];
  if (!status?.seen) return { write: false, result: { ok: true, outcome: "already_unseen", message: "Already unseen" } };
  const reversedCycle = status.cycle;
  status.seen = false;
  status.firstSeenAt = null;
  status.cycle += 1;
  next.statuses[code] = status;
  next.events.push({
    type: "reversal",
    code,
    at,
    actor,
    reason: reason || "",
    cycle: reversedCycle,
    requestId,
  });
  next.processedRequestIds[requestId] = { outcome: "reversed", at };
  return {
    write: true,
    data: next,
    message: `Reverse scan ${code.slice(0, 8)}`,
    result: { ok: true, outcome: "reversed", message: "Marked as unseen" },
  };
}

export function applyEventStatus(state, { status, requestId, actor, at }) {
  if (!ready(state)) return { write: false, result: saveFailed() };
  if (status !== "open" && status !== "closed") {
    return { write: false, result: { ok: false, outcome: "invalid", message: "Invalid request" } };
  }
  const next = structuredClone(state);
  const previous = priorResult(next, requestId);
  if (previous) return { write: false, result: previous };
  if (next.event.status === status) {
    return {
      write: false,
      result: { ok: true, outcome: "event_status", message: status === "open" ? "Event open" : "Event closed", status },
    };
  }
  next.event.status = status;
  next.event.updatedAt = at;
  next.events.push({ type: "event_status", status, at, actor, requestId });
  next.processedRequestIds[requestId] = { outcome: status === "open" ? "event_open" : "event_closed", at };
  return {
    write: true,
    data: next,
    message: `Set event ${status}`,
    result: { ok: true, outcome: "event_status", message: status === "open" ? "Event open" : "Event closed", status },
  };
}

export function applyIssue(state, { codes, requestId, actor, at }) {
  if (!ready(state)) return { write: false, result: saveFailed() };
  const next = structuredClone(state);
  const previous = priorResult(next, requestId);
  if (previous) return { write: false, result: previous };
  if (next.event.status !== "open") return { write: false, result: { ok: false, outcome: "closed", message: MESSAGES.closed } };
  if (!Array.isArray(codes) || codes.length === 0 || codes.some((code) => !CODE_RE.test(code) || next.issued.some((item) => item.id === code))) {
    return { write: false, result: { ok: false, outcome: "invalid", message: "Could not issue codes" } };
  }
  for (const code of codes) {
    next.issued.push({ id: code, issuedAt: at });
    next.statuses[code] = { seen: false, firstSeenAt: null, cycle: 1 };
  }
  next.events.push({ type: "issue", at, actor, count: codes.length, requestId });
  next.processedRequestIds[requestId] = { outcome: "issued", at, codes: [...codes] };
  return {
    write: true,
    data: next,
    message: `Issue ${codes.length} codes`,
    result: { ok: true, outcome: "issued", message: "Codes issued", codes: [...codes] },
  };
}

export function replacePassword(users, username, passwordHash, at) {
  if (!users || users.schemaVersion !== 1 || !Array.isArray(users.users)) {
    return { write: false, result: { ok: false, message: "Could not change the password." } };
  }
  const next = structuredClone(users);
  const user = next.users.find((item) => item.username === username);
  if (!user) return { write: false, result: { ok: false, message: "Could not change the password." } };
  user.passwordHash = passwordHash;
  user.passwordChangedAt = at;
  user.mustChangePassword = false;
  return { write: true, data: next, message: `Update password for ${username}`, result: { ok: true, message: "Password changed." } };
}

export function dashboard(state) {
  return {
    event: { name: state.event.name, status: state.event.status, updatedAt: state.event.updatedAt },
    codes: state.issued.map((item) => {
      const status = state.statuses[item.id] || { seen: false, firstSeenAt: null, cycle: 1 };
      return {
        id: item.id,
        issuedAt: item.issuedAt,
        seen: Boolean(status.seen),
        firstSeenAt: status.seen ? status.firstSeenAt : null,
        cycle: status.cycle || 1,
      };
    }),
    history: state.events.map((event) => ({
      type: event.type,
      code: event.code || "",
      at: event.at,
      actor: event.actor || "",
      reason: event.reason || "",
      cycle: event.cycle || null,
      status: event.status || "",
      count: event.count || null,
    })),
  };
}

export function reportCsv(view) {
  const header = ["record_type", "id", "status", "first_seen_at", "cycle", "issued_at", "event_type", "at", "actor", "reason", "count"];
  const rows = [header];
  for (const code of view.codes) {
    rows.push(["code", code.id, code.seen ? "seen" : "unseen", code.firstSeenAt || "", code.cycle, code.issuedAt, "", "", "", "", ""]);
  }
  for (const event of view.history) {
    rows.push(["event", event.code, event.status, "", event.cycle ?? "", "", event.type, event.at, event.actor, event.reason, event.count ?? ""]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
}

function csvField(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
