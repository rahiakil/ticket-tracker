import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({ crypto, URL, structuredClone, btoa, TextEncoder, TextDecoder });
vm.runInContext(readFileSync(new URL("../web/ledger.js", import.meta.url), "utf8"), context);
const { openLedger } = context.TicketLedger;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

const CODE = "aaaaaaaaaaaaaaaaaaaaaa";

test("a saved scan is recorded once and a repeat stays already seen", () => {
  const ledger = openLedger(memoryStorage());
  const issued = ledger.issue(1, crypto.randomUUID(), "siteadmin");
  assert.equal(issued.message, "Codes issued");
  const code = issued.codes[0];
  const first = ledger.scan(code, crypto.randomUUID(), "siteadmin");
  const second = ledger.scan(`https://rahiakil.github.io/ticket-tracker/?c=${code}`, crypto.randomUUID(), "siteadmin");
  assert.equal(first.message, "Recorded");
  assert.equal(second.message, "Already seen");
  assert.equal(ledger.view().history.filter((event) => event.type === "scan").length, 1);
});

test("a foreign URL is invalid even when it contains a real code", () => {
  const ledger = openLedger(memoryStorage());
  ledger.issue(1, crypto.randomUUID(), "siteadmin");
  const code = ledger.view().codes[0].id;
  const result = ledger.scan(`https://evil.example/?c=${code}`, crypto.randomUUID(), "siteadmin");
  assert.equal(result.message, "Invalid code");
  assert.equal(ledger.view().codes[0].seen, false);
});

test("undo then scan keeps the original scan", () => {
  const ledger = openLedger(memoryStorage());
  const code = CODE;
  const storage = memoryStorage();
  const local = openLedger(storage);
  local.issue(1, crypto.randomUUID(), "siteadmin");
  const id = local.view().codes[0].id;
  local.scan(id, crypto.randomUUID(), "siteadmin");
  assert.equal(local.unsee(id, crypto.randomUUID(), "wrong ticket", "siteadmin").message, "Marked as unseen");
  assert.equal(local.scan(id, crypto.randomUUID(), "siteadmin").message, "Recorded");
  const history = local.view().history;
  assert.equal(history.filter((event) => event.type === "scan").length, 2);
  assert.equal(history.some((event) => event.type === "reversal"), true);
  void code;
});

test("a closed event rejects a new scan", () => {
  const ledger = openLedger(memoryStorage());
  const issued = ledger.issue(1, crypto.randomUUID(), "siteadmin");
  ledger.setEvent("closed", crypto.randomUUID(), "siteadmin");
  const result = ledger.scan(issued.codes[0], crypto.randomUUID(), "siteadmin");
  assert.equal(result.message, "Event closed");
});
