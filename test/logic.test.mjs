import assert from "node:assert/strict";
import test from "node:test";
import { commitJson } from "../src/commit.mjs";
import {
  CODE_RE,
  MESSAGES,
  applyScan,
  applyUnsee,
  codeUrl,
  emptyState,
  extractCode,
  generateCodes,
} from "../src/logic.mjs";
import { createMemoryStore } from "../src/memory-store.mjs";

const PAGE = "https://rahiakil.github.io/ticket-tracker/";
const CODE_A = "aaaaaaaaaaaaaaaaaaaaaa";
const CODE_B = "bbbbbbbbbbbbbbbbbbbbbb";
const AT = "2026-09-29T18:00:00.000Z";

function issuedState() {
  const state = emptyState("2026-09-29T00:00:00.000Z");
  for (const code of [CODE_A, CODE_B]) {
    state.issued.push({ id: code, issuedAt: state.event.updatedAt });
    state.statuses[code] = { seen: false, firstSeenAt: null, cycle: 1 };
  }
  return state;
}

function storeWith(state) {
  return createMemoryStore({ state, users: { schemaVersion: 1, users: [] } });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("generated identifiers are unguessable-length tokens", () => {
  const codes = generateCodes([], 5);
  assert.equal(new Set(codes).size, 5);
  for (const code of codes) assert.match(code, CODE_RE);
});

test("QR URLs extract only our page identifier", () => {
  const code = "cccccccccccccccccccccc";
  assert.equal(extractCode(code, [PAGE]), code);
  assert.equal(extractCode(codeUrl(PAGE, code), [PAGE]), code);
  assert.equal(extractCode(`https://evil.example/ticket-tracker/?c=${code}`, [PAGE]), null);
  assert.equal(extractCode("https://rahiakil.github.io/displayartforseatac/?c=cccccccccccccccccccccc", [PAGE]), null);
  assert.equal(extractCode("javascript:alert(1)", [PAGE]), null);
  assert.equal(extractCode("https://user:pass@rahiakil.github.io/ticket-tracker/?c=cccccccccccccccccccccc", [PAGE]), null);
});

test("first scan, repeat scan, and retry", async () => {
  const store = storeWith(issuedState());
  const requestId = crypto.randomUUID();
  const first = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId, actor: "Ada Admin", at: AT,
  }));
  assert.equal(first.result.message, MESSAGES.recorded);
  const repeat = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: "2026-09-29T18:05:00.000Z",
  }));
  assert.equal(repeat.result.message, MESSAGES.already_seen);
  const retry = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId, actor: "Ada Admin", at: AT,
  }));
  assert.equal(retry.result.message, MESSAGES.recorded);
  const saved = await store.readState();
  assert.equal(saved.data.events.filter((event) => event.type === "scan").length, 1);
  assert.equal(saved.data.statuses[CODE_A].firstSeenAt, AT);
});

test("invalid and closed scans do not write events", async () => {
  const state = issuedState();
  state.event.status = "closed";
  const store = storeWith(state);
  const closed = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (current) => applyScan(current, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
  }));
  assert.equal(closed.result.message, MESSAGES.closed);
  const reopened = await store.readState();
  reopened.data.event.status = "open";
  await store.writeState(reopened.data, reopened.sha, "reopen");
  const invalid = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (current) => applyScan(current, {
    code: "dddddddddddddddddddddd", requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
  }));
  assert.equal(invalid.message ? invalid.result.message : invalid.result.message, MESSAGES.invalid);
  const saved = await store.readState();
  assert.equal(saved.data.events.length, 0);
  assert.equal(saved.data.statuses[CODE_A].seen, false);
});

test("two simultaneous scans of different codes both survive a conflict", async () => {
  const store = storeWith(issuedState());
  const barrier = deferred();
  let reads = 0;
  const read = store.readState.bind(store);
  store.readState = async () => {
    const snapshot = await read();
    reads += 1;
    if (reads === 2) barrier.resolve();
    if (reads <= 2) await barrier.promise;
    return snapshot;
  };
  const [left, right] = await Promise.all([
    commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
      code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
    })),
    commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
      code: CODE_B, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
    })),
  ]);
  assert.equal(left.result.outcome, "recorded");
  assert.equal(right.result.outcome, "recorded");
  const saved = await store.readState();
  assert.equal(saved.data.statuses[CODE_A].seen, true);
  assert.equal(saved.data.statuses[CODE_B].seen, true);
  assert.equal(saved.data.events.length, 2);
});

test("two simultaneous scans of one code record a single scan event", async () => {
  const store = storeWith(issuedState());
  const barrier = deferred();
  let reads = 0;
  const read = store.readState.bind(store);
  store.readState = async () => {
    const snapshot = await read();
    reads += 1;
    if (reads === 2) barrier.resolve();
    if (reads <= 2) await barrier.promise;
    return snapshot;
  };
  const [left, right] = await Promise.all([
    commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
      code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
    })),
    commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
      code: CODE_A, requestId: crypto.randomUUID(), actor: "Sam Scanner", at: AT,
    })),
  ]);
  const outcomes = [left.result.outcome, right.result.outcome].sort();
  assert.deepEqual(outcomes, ["already_seen", "recorded"]);
  const saved = await store.readState();
  assert.equal(saved.data.events.filter((event) => event.type === "scan").length, 1);
});

test("a write conflict retries a bounded number of times", async () => {
  const store = storeWith(issuedState());
  let conflicts = 0;
  store.writeState = async () => {
    conflicts += 1;
    return { ok: false, conflict: true };
  };
  const saved = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
  }));
  assert.equal(saved.result.message, MESSAGES.save_failed);
  assert.equal(conflicts, 5);
  assert.equal(saved.attempts, 5);
});

test("undo keeps the original scan and does not revert another code", async () => {
  const store = storeWith(issuedState());
  await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: AT,
  }));
  const read = store.readState.bind(store);
  const write = store.writeState.bind(store);
  let first = true;
  store.writeState = async (data, sha, message) => {
    if (first) {
      first = false;
      const current = await read();
      const other = applyScan(current.data, {
        code: CODE_B, requestId: crypto.randomUUID(), actor: "Sam Scanner", at: "2026-09-29T18:02:00.000Z",
      });
      await write(other.data, current.sha, other.message);
      return { ok: false, conflict: true };
    }
    return write(data, sha, message);
  };
  const undone = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyUnsee(state, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", reason: "Wrong ticket", at: "2026-09-29T18:10:00.000Z",
  }));
  assert.equal(undone.result.message, "Marked as unseen");
  const saved = await store.readState();
  assert.equal(saved.data.statuses[CODE_A].seen, false);
  assert.equal(saved.data.statuses[CODE_A].firstSeenAt, null);
  assert.equal(saved.data.statuses[CODE_B].seen, true);
  assert.equal(saved.data.events.filter((event) => event.type === "scan" && event.code === CODE_A).length, 1);
  assert.equal(saved.data.events.some((event) => event.type === "reversal" && event.actor === "Ada Admin"), true);
  const again = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE_A, requestId: crypto.randomUUID(), actor: "Ada Admin", at: "2026-09-29T18:20:00.000Z",
  }));
  assert.equal(again.result.message, MESSAGES.recorded);
  const finalState = await store.readState();
  assert.equal(finalState.data.statuses[CODE_A].firstSeenAt, "2026-09-29T18:20:00.000Z");
  assert.equal(finalState.data.statuses[CODE_A].cycle, 2);
  assert.equal(finalState.data.events.filter((event) => event.type === "scan" && event.code === CODE_A).length, 2);
});
