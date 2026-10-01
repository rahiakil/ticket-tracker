import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { base64ToUtf8, utf8ToBase64 } from "../src/encoding.mjs";

const context = vm.createContext({ crypto, URL, structuredClone, btoa, atob, TextEncoder, TextDecoder });
vm.runInContext(readFileSync(new URL("../web/ledger.js", import.meta.url), "utf8"), context);
const ledger = context.TicketLedger;
const SAMPLE = "order-12196-variant-992|993|997|998|1002|1003|1007|1008|1009|1010|1011|1012";

test("the sample QR splits into an order and variant ids", () => {
  const parsed = ledger.parseQr(SAMPLE);
  assert.equal(parsed.orderId, "12196");
  assert.equal(JSON.stringify(parsed.variants), JSON.stringify(["992", "993", "997", "998", "1002", "1003", "1007", "1008", "1009", "1010", "1011", "1012"]));
  assert.equal(ledger.parseQr("not a ticket"), null);
});

test("a new order is scanned but not taken, then partial, then taken", () => {
  const parsed = ledger.parseQr(SAMPLE);
  const first = ledger.rememberScan(ledger.emptyBook(), parsed, "2026-09-30T01:00:00.000Z", "siteadmin");
  assert.equal(first.changed, true);
  assert.equal(ledger.statusOf(first.book.orders["12196"]), "Scanned but not taken");
  const again = ledger.rememberScan(first.book, parsed, "2026-09-30T01:05:00.000Z", "siteadmin");
  assert.equal(again.changed, true);
  assert.equal(again.already, true);
  assert.equal(again.book.lines.length, 1);
  assert.equal(again.book.counts.peopleScanned, 1);
  const variant992 = again.book.counts.variants["992"];
  assert.equal(variant992.orders, 1);
  assert.equal(variant992.notTaken, 1);
  assert.match(again.book.log.map((item) => item.text).join(" "), /already scanned order 12196/);
  const partial = ledger.setTakenCount(again.book, "12196", 3, "2026-09-30T01:10:00.000Z", "siteadmin");
  assert.equal(ledger.statusOf(partial.book.orders["12196"]), "Partially taken");
  assert.equal(ledger.statusDetail(partial.book.orders["12196"]), "Partially taken. Picked up 3. Not picked up 9.");
  assert.equal(partial.book.orders["12196"].takenCount, 3);
  assert.equal(partial.book.orders["12196"].variants["992"].taken, true);
  assert.equal(partial.book.orders["12196"].variants["1012"].taken, false);
  assert.equal(partial.book.counts.itemTotal, 12);
  assert.equal(partial.book.counts.ticketsTaken, 3);
  const full = ledger.setTakenCount(partial.book, "12196", 12, "2026-09-30T01:20:00.000Z", "siteadmin");
  assert.equal(ledger.statusOf(full.book.orders["12196"]), "Taken");
  assert.equal(full.book.orders["12196"].scannedAt, "2026-09-30T01:00:00.000Z");
  const removed = ledger.deleteOrder(full.book, "12196", "2026-09-30T01:30:00.000Z", "admin");
  assert.equal(removed.changed, true);
  assert.equal(Boolean(removed.book.orders["12196"]), false);
});

test("saving a new order retries a GitHub SHA conflict and keeps the text record", async () => {
  let doc = ledger.emptyBook();
  let sha = null;
  let puts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method !== "PUT") {
      if (!sha) return new Response("missing", { status: 404 });
      return Response.json({ content: utf8ToBase64(JSON.stringify(doc)), sha });
    }
    puts += 1;
    const body = JSON.parse(options.body);
    if (puts === 1) return new Response("sha mismatch", { status: 409 });
    if (sha && body.sha !== sha) return new Response("sha mismatch", { status: 409 });
    doc = JSON.parse(base64ToUtf8(body.content));
    sha = `sha-${puts}`;
    return Response.json({ content: { sha } });
  };
  const saved = await ledger.commitRemote({
    token: "test-token",
    repo: "rahiakil/ticket-tracker-data",
    file: "scans.txt",
    fetchImpl,
  }, (book) => {
    const next = ledger.rememberScan(book, ledger.parseQr(SAMPLE), "2026-09-30T02:00:00.000Z", "siteadmin");
    return { write: next.changed, book: next.book, message: "Order 12196. Scanned but not taken", commitMessage: "Scan order 12196" };
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.message, "Order 12196. Scanned but not taken");
  assert.equal(doc.orders["12196"].variants["992"].taken, false);
  assert.match(doc.lines[0], /order 12196 scanned but not taken/);
  assert.equal(puts, 2);
});

test("a sheet order uses the last 5 digits and turns food gray when picked up", () => {
  const person = {
    code: "12166",
    full: "UTT20260900012166",
    name: "barna NA",
    email: "barna_c@yahoo.com",
    items: [
      { name: "Saturday Lunch Vegetarian", qty: 1, lane: "food", tone: "sat-veg" },
      { name: "Sunday Lunch Non-Vegetarian", qty: 1, lane: "food", tone: "sun-nonveg" },
      { name: "Regular Member Entry", qty: 1, lane: "entry", tone: "entry" },
      { name: "Chinese Non-Veg Combo", qty: 1, lane: "food", tone: "nonveg" },
    ],
  };
  const scanned = ledger.rememberSheet(ledger.emptyBook(), person, "12166", "2026-09-30T17:20:00.000Z", "admin", "entry");
  assert.equal(scanned.already, false);
  assert.equal(scanned.book.orders["12166"].name, "barna NA");
  assert.equal(ledger.statusOf(scanned.book.orders["12166"]), "Scanned but not taken");
  const again = ledger.rememberSheet(scanned.book, person, "12166", "2026-09-30T17:21:00.000Z", "admin", "entry");
  assert.equal(again.already, true);
  assert.match(again.book.log.map((item) => item.text).join(" "), /12166 scanned again at the entry counter/);
  const entered = ledger.markLane(again.book, person, person.full, "entry", "2026-09-30T17:22:00.000Z", "admin");
  assert.equal(entered.book.orders["12166"].variants["item:2:Regular Member Entry"].taken, true);
  assert.equal(entered.book.orders["12166"].variants["item:0:Saturday Lunch Vegetarian"].taken, false);
  const fed = ledger.markLane(entered.book, person, person.full, "food", "2026-09-30T17:30:00.000Z", "admin");
  assert.equal(fed.book.orders["12166"].variants["item:0:Saturday Lunch Vegetarian"].taken, true);
  assert.equal(fed.book.orders["12166"].variants["item:1:Sunday Lunch Non-Vegetarian"].taken, true);
  assert.equal(fed.book.orders["12166"].variants["item:3:Chinese Non-Veg Combo"].taken, true);
  assert.equal(ledger.statusOf(fed.book.orders["12166"]), "Taken");
  const repeat = ledger.markLane(fed.book, person, person.full, "food", "2026-09-30T17:31:00.000Z", "admin");
  assert.equal(repeat.already, true);
  assert.equal(repeat.changed, false);
});

test("old variant scans are removed and the sheet exports one CSV line per order", () => {
  const book = ledger.emptyBook();
  book.orders["12196"] = {
    orderId: "12196",
    scannedAt: "2026-09-30T02:42:08.353Z",
    variants: { "992": { taken: false, takenAt: null } },
  };
  book.lines = ["2026-09-30T02:42:08.353Z order 12196 scanned but not taken"];
  book.log = [{ at: "2026-09-30T02:42:08.353Z", text: "scanned order 12196" }];
  const cleaned = ledger.cleanSheetBook(book);
  assert.equal(cleaned.removed, 1);
  assert.equal(Object.keys(cleaned.book.orders).length, 0);
  assert.equal(cleaned.book.lines.length, 0);
  const catalog = {
    "12166": {
      code: "12166",
      full: "UTT20260900012166",
      name: "barna NA",
      email: "barna_c@yahoo.com",
      items: [
        { name: "Saturday Lunch Vegetarian", qty: 1, lane: "food" },
        { name: "Regular Member Entry", qty: 1, lane: "entry" },
      ],
    },
  };
  const csv = ledger.exportCsv(cleaned.book, catalog);
  assert.match(csv, /Not seen,1/);
  assert.match(csv, /barna NA/);
  assert.match(csv, /Saturday Lunch Vegetarian x 1; Regular Member Entry x 1/);
  assert.match(csv, /Pending items,2/);
});

test("orders stay until the file reaches 10000, then the oldest order is dropped", () => {
  const book = ledger.emptyBook();
  book.orders.old = { orderId: "old", updatedAt: "2020-01-01T00:00:00.000Z", scannedAt: "2020-01-01T00:00:00.000Z", variants: {} };
  book.orders.recent = { orderId: "recent", updatedAt: "2026-09-30T00:00:00.000Z", scannedAt: "2026-09-30T00:00:00.000Z", variants: {} };
  const kept = ledger.pruneBook(book);
  assert.equal(Boolean(kept.orders.old), true);
  for (let index = 0; index < 10000; index += 1) {
    book.orders[`n${index}`] = { orderId: `n${index}`, updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`, scannedAt: "2026-01-01T00:00:00.000Z", variants: {} };
  }
  const capped = ledger.pruneBook(book);
  assert.equal(Object.keys(capped.orders).length, 10000);
  assert.equal(Boolean(capped.orders.old), false);
});
