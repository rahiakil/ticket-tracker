import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({ URLSearchParams, Date, Math });
vm.runInContext(readFileSync(new URL("../web/record.js", import.meta.url), "utf8"), context);
const { commit } = context.TicketRecord;
const SCRIPT = "https://script.google.com/macros/s/abc_def-123/exec";

function memoryStore(start) {
  let book = structuredClone(start);
  return {
    async load() { return structuredClone(book); },
    async post(_url, next) { book = structuredClone(next); },
    current() { return book; },
  };
}

test("a record link is required before a scan is treated as saved", async () => {
  const saved = await commit({ recordUrl: "", load() {}, post() {} }, () => ({ write: true, book: {}, message: "nope" }));
  assert.equal(saved.message, "Add the record link first.");
});

test("a scan is shown only after the shared record contains that write", async () => {
  const store = memoryStore({ schemaVersion: 1, lines: [], orders: {}, lastWriteId: "" });
  const saved = await commit({
    recordUrl: SCRIPT,
    load: () => store.load(),
    post: (url, book) => store.post(url, book),
    newId: () => "write-1",
  }, () => ({
    write: true,
    book: {
      schemaVersion: 1,
      lines: ["order 12196 scanned but not taken"],
      orders: { 12196: { orderId: "12196" } },
    },
    message: "Order 12196. Scanned but not taken",
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.message, "Order 12196. Scanned but not taken");
  assert.equal(store.current().lastWriteId, "write-1");
  assert.equal(store.current().orders["12196"].orderId, "12196");
});

test("a lost write is retried and then reported as not saved", async () => {
  let calls = 0;
  const saved = await commit({
    recordUrl: SCRIPT,
    async load() {
      calls += 1;
      return { schemaVersion: 1, lines: [], orders: {}, lastWriteId: "old" };
    },
    async post() {},
    newId: () => "new-write",
  }, (book) => ({ write: true, book, message: "Order 12196. Scanned but not taken" }));
  assert.equal(saved.ok, false);
  assert.equal(saved.message, "Could not save—retry");
  assert.ok(calls >= 2);
});
