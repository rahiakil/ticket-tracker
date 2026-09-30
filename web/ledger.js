(function (root) {
  const CODE_RE = /^[A-Za-z0-9_-]{22,80}$/;
  const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PAGE = "https://rahiakil.github.io/ticket-tracker/";
  const STORAGE_KEY = "ticket-tracker-event-v1";
  const MESSAGES = {
    recorded: "Recorded",
    already_seen: "Already seen",
    invalid: "Invalid code",
    save_failed: "Could not save—retry",
    closed: "Event closed",
  };

  function emptyState(now) {
    return {
      schemaVersion: 1,
      event: { name: "Ticket Tracker", status: "open", updatedAt: now },
      issued: [],
      statuses: {},
      events: [],
      processedRequestIds: {},
    };
  }

  function failed() {
    return { ok: false, outcome: "save_failed", message: MESSAGES.save_failed };
  }

  function ready(state) {
    return Boolean(state && state.schemaVersion === 1 && state.event && Array.isArray(state.issued) && state.statuses && Array.isArray(state.events) && state.processedRequestIds);
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  }

  function newCode() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  function codeUrl(code) {
    const url = new URL(PAGE);
    url.searchParams.set("c", code);
    return url.toString();
  }

  function extractCode(raw) {
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (!text || text.length > 500) return null;
    if (CODE_RE.test(text)) return text;
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.username || url.password) return null;
    if (url.origin !== "https://rahiakil.github.io") return null;
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    if (path !== "/ticket-tracker/") return null;
    const code = url.searchParams.get("c");
    if (!code || !CODE_RE.test(code)) return null;
    return code;
  }

  function prior(state, requestId) {
    const saved = state.processedRequestIds[requestId];
    if (!saved) return null;
    if (saved.outcome === "recorded") return { ok: true, outcome: "recorded", message: MESSAGES.recorded };
    if (saved.outcome === "reversed") return { ok: true, outcome: "reversed", message: "Marked as unseen" };
    if (saved.outcome === "issued") return { ok: true, outcome: "issued", message: "Codes issued", codes: saved.codes || [] };
    if (saved.outcome === "event_open" || saved.outcome === "event_closed") {
      const status = saved.outcome === "event_open" ? "open" : "closed";
      return { ok: true, outcome: "event_status", status, message: status === "open" ? "Event open" : "Event closed" };
    }
    return null;
  }

  function applyScan(state, { code, requestId, actor, at }) {
    if (!ready(state)) return { write: false, result: failed() };
    const next = structuredClone(state);
    const previous = prior(next, requestId);
    if (previous) return { write: false, result: previous };
    if (next.event.status !== "open") return { write: false, result: { ok: false, outcome: "closed", message: MESSAGES.closed } };
    if (!next.issued.some((item) => item.id === code)) return { write: false, result: { ok: false, outcome: "invalid", message: MESSAGES.invalid } };
    const status = next.statuses[code] || { seen: false, firstSeenAt: null, cycle: 1 };
    if (status.seen) return { write: false, result: { ok: true, outcome: "already_seen", message: MESSAGES.already_seen } };
    status.seen = true;
    status.firstSeenAt = at;
    next.statuses[code] = status;
    next.events.push({ type: "scan", code, at, actor, cycle: status.cycle, requestId });
    next.processedRequestIds[requestId] = { outcome: "recorded", at };
    return { write: true, data: next, result: { ok: true, outcome: "recorded", message: MESSAGES.recorded } };
  }

  function applyUnsee(state, { code, requestId, actor, reason, at }) {
    if (!ready(state)) return { write: false, result: failed() };
    const next = structuredClone(state);
    const previous = prior(next, requestId);
    if (previous) return { write: false, result: previous };
    if (!next.issued.some((item) => item.id === code)) return { write: false, result: { ok: false, outcome: "invalid", message: MESSAGES.invalid } };
    const status = next.statuses[code];
    if (!status?.seen) return { write: false, result: { ok: true, outcome: "already_unseen", message: "Already unseen" } };
    const cycle = status.cycle;
    status.seen = false;
    status.firstSeenAt = null;
    status.cycle += 1;
    next.events.push({ type: "reversal", code, at, actor, reason: reason || "", cycle, requestId });
    next.processedRequestIds[requestId] = { outcome: "reversed", at };
    return { write: true, data: next, result: { ok: true, outcome: "reversed", message: "Marked as unseen" } };
  }

  function applyEventStatus(state, { status, requestId, actor, at }) {
    if (!ready(state) || (status !== "open" && status !== "closed")) return { write: false, result: failed() };
    const next = structuredClone(state);
    const previous = prior(next, requestId);
    if (previous) return { write: false, result: previous };
    if (next.event.status === status) {
      return { write: false, result: { ok: true, outcome: "event_status", status, message: status === "open" ? "Event open" : "Event closed" } };
    }
    next.event.status = status;
    next.event.updatedAt = at;
    next.events.push({ type: "event_status", status, at, actor, requestId });
    next.processedRequestIds[requestId] = { outcome: status === "open" ? "event_open" : "event_closed", at };
    return { write: true, data: next, result: { ok: true, outcome: "event_status", status, message: status === "open" ? "Event open" : "Event closed" } };
  }

  function applyIssue(state, { count, requestId, actor, at }) {
    if (!ready(state)) return { write: false, result: failed() };
    const next = structuredClone(state);
    const previous = prior(next, requestId);
    if (previous) return { write: false, result: previous };
    if (next.event.status !== "open") return { write: false, result: { ok: false, outcome: "closed", message: MESSAGES.closed } };
    if (!Number.isInteger(count) || count < 1 || count > 50) return { write: false, result: { ok: false, outcome: "invalid", message: "Choose between 1 and 50 codes." } };
    const codes = [];
    const taken = new Set(next.issued.map((item) => item.id));
    while (codes.length < count) {
      const code = newCode();
      if (taken.has(code)) continue;
      taken.add(code);
      codes.push(code);
    }
    for (const code of codes) {
      next.issued.push({ id: code, issuedAt: at });
      next.statuses[code] = { seen: false, firstSeenAt: null, cycle: 1 };
    }
    next.events.push({ type: "issue", at, actor, count, requestId });
    next.processedRequestIds[requestId] = { outcome: "issued", at, codes };
    return { write: true, data: next, result: { ok: true, outcome: "issued", message: "Codes issued", codes } };
  }

  function dashboard(state) {
    return {
      ok: true,
      event: state.event,
      codes: state.issued.map((item) => {
        const status = state.statuses[item.id] || { seen: false, firstSeenAt: null, cycle: 1 };
        return { id: item.id, issuedAt: item.issuedAt, seen: Boolean(status.seen), firstSeenAt: status.seen ? status.firstSeenAt : null, cycle: status.cycle || 1 };
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

  function csvField(value) {
    const text = value == null ? "" : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  }

  function reportCsv(view) {
    const rows = [["record_type", "id", "status", "first_seen_at", "cycle", "issued_at", "event_type", "at", "actor", "reason", "count"]];
    for (const code of view.codes) rows.push(["code", code.id, code.seen ? "seen" : "unseen", code.firstSeenAt || "", code.cycle, code.issuedAt, "", "", "", "", ""]);
    for (const event of view.history) rows.push(["event", event.code, event.status, "", event.cycle ?? "", "", event.type, event.at, event.actor, event.reason, event.count ?? ""]);
    return `${rows.map((row) => row.map(csvField).join(",")).join("\n")}\n`;
  }

  function openLedger(storage) {
    function read() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return emptyState(new Date().toISOString());
      const parsed = JSON.parse(raw);
      if (!ready(parsed)) throw new Error("bad state");
      return parsed;
    }
    function commit(mutate) {
      let current;
      try { current = read(); } catch { return failed(); }
      const applied = mutate(current);
      if (!applied.write) return applied.result;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(applied.data)); } catch { return failed(); }
      return applied.result;
    }
    const actorOf = (actor) => actor || "siteadmin";
    return {
      view() {
        try { return dashboard(read()); } catch { return null; }
      },
      scan(raw, requestId, actor) {
        if (!REQUEST_ID_RE.test(requestId || "")) return failed();
        const code = extractCode(raw);
        if (!code) return { ok: false, outcome: "invalid", message: MESSAGES.invalid };
        return commit((state) => applyScan(state, { code, requestId, actor: actorOf(actor), at: new Date().toISOString() }));
      },
      unsee(code, requestId, reason, actor) {
        if (!REQUEST_ID_RE.test(requestId || "")) return failed();
        return commit((state) => applyUnsee(state, { code, requestId, reason, actor: actorOf(actor), at: new Date().toISOString() }));
      },
      setEvent(status, requestId, actor) {
        if (!REQUEST_ID_RE.test(requestId || "")) return failed();
        return commit((state) => applyEventStatus(state, { status, requestId, actor: actorOf(actor), at: new Date().toISOString() }));
      },
      issue(count, requestId, actor) {
        if (!REQUEST_ID_RE.test(requestId || "")) return failed();
        return commit((state) => applyIssue(state, { count, requestId, actor: actorOf(actor), at: new Date().toISOString() }));
      },
      report() {
        const view = this.view();
        if (!view) return null;
        return {
          json: JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), event: view.event, codes: view.codes, history: view.history }, null, 2),
          csv: reportCsv(view),
        };
      },
    };
  }

  function qrSvg(text) {
    if (typeof root.qrcode !== "function") return "";
    const qr = root.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  root.TicketLedger = { openLedger, extractCode, codeUrl, qrSvg, CODE_RE };
})(typeof globalThis !== "undefined" ? globalThis : this);
