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
  assert.equal(entered.book.orders["12166"].variants["item:2:0:Regular Member Entry"].taken, true);
  assert.equal(entered.book.orders["12166"].variants["item:0:0:Saturday Lunch Vegetarian"].taken, false);
  const fed = ledger.markLane(entered.book, person, person.full, "food", "2026-09-30T17:30:00.000Z", "admin");
  assert.equal(fed.book.orders["12166"].variants["item:0:0:Saturday Lunch Vegetarian"].taken, true);
  assert.equal(fed.book.orders["12166"].variants["item:1:0:Sunday Lunch Non-Vegetarian"].taken, true);
  assert.equal(fed.book.orders["12166"].variants["item:3:0:Chinese Non-Veg Combo"].taken, true);
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

test("entry and food get separate status, and one item turns done at a time", () => {
  const person = {
    code: "12166",
    full: "UTT20260900012166",
    name: "barna NA",
    email: "barna_c@yahoo.com",
    items: [
      { name: "Saturday Lunch Vegetarian", qty: 1, lane: "food", tone: "sat-veg" },
      { name: "Regular Member Entry", qty: 1, lane: "entry", tone: "entry" },
    ],
  };
  assert.equal(ledger.sheetPhrase(person.items.map((item) => ({ ...item, taken: false }))), "Entry not done. Food not taken");
  const entered = ledger.markItem(ledger.emptyBook(), person, 1, "2026-09-30T17:20:00.000Z", "admin");
  assert.equal(entered.phrase, "Entry done for Saturday. Food not taken");
  assert.equal(entered.book.orders["12166"].variants["item:1:0:Regular Member Entry"].taken, true);
  assert.equal(entered.book.orders["12166"].variants["item:0:0:Saturday Lunch Vegetarian"].taken, false);
  const early = ledger.markItem(entered.book, person, 0, "2026-09-30T18:00:00.000Z", "admin");
  assert.equal(early.blocked, true);
  assert.equal(early.book.orders["12166"].variants["item:0:0:Saturday Lunch Vegetarian"].taken, false);
  const fed = ledger.markItem(entered.book, person, 0, "2026-10-03T18:00:00.000Z", "admin");
  assert.equal(fed.phrase, "Entry done for Saturday. Food taken");
  const undone = ledger.revertLast(fed.book, person, "2026-10-03T18:05:00.000Z", "admin");
  assert.equal(undone.changed, true);
  assert.equal(undone.book.orders["12166"].variants["item:0:0:Saturday Lunch Vegetarian"].taken, false);
  assert.equal(ledger.couponKind("Mutton Biriyani", "food"), "mutton");
  assert.equal(ledger.couponKind("Chicken Chaap", "food"), "chicken");
  assert.equal(ledger.couponKind("Member Non-Veg Snacks (2 fish Chop, Salad)", "food"), "snack");
  assert.equal(ledger.couponKind("Veg Pulao with Paneer Kofta", "food"), "paneer");
  assert.equal(ledger.couponKind("Sunday Machher Kalia", "food"), "fish");
  assert.equal(ledger.couponKind("Maacher Kalia", "food"), "fish");
  assert.equal(ledger.couponKind("Saturday Lunch Vegetarian", "food"), "veg");
  assert.equal(ledger.couponKind("Saturday Adult Member Entry", "entry"), "entry-sat-adult");
  assert.equal(ledger.couponKind("Saturday Kids Member Entry", "entry"), "entry-sat-kids");
  assert.equal(ledger.couponKind("Friday Student Member Entry", "entry"), "entry-fri-student");
  assert.equal(ledger.couponKind("Sunday Senior Member Entry", "entry"), "entry-sun-senior");
  assert.equal(ledger.couponKind("Regular Member Entry", "entry"), "entry-any-adult");
  assert.equal(ledger.activityFor({ log: [{ at: "2026-10-03T18:00:00.000Z", text: "12166 food picked up" }, { at: "2026-10-03T18:01:00.000Z", text: "12222 scanned" }] }, "12166").length, 1);
  assert.equal(ledger.daysAhead("saturday", new Date("2026-09-30T18:00:00.000Z")) > 0, true);
  assert.equal(ledger.daysAhead("saturday", new Date("2026-10-03T18:00:00.000Z")), 0);
  const eventDays = { friday: "2026-10-09", saturday: "2026-10-10", sunday: "2026-10-11" };
  assert.equal(ledger.daysAhead("friday", new Date(2026, 9, 8, 12), eventDays), 1);
  assert.equal(ledger.daysAhead("friday", new Date(2026, 9, 9, 12), eventDays), 0);
  assert.equal(ledger.daysAhead("saturday", new Date(2026, 9, 9, 12), eventDays), 1);
  assert.equal(ledger.daysAhead("sunday", new Date(2026, 9, 11, 12), eventDays), 0);
});

test("a line stays locked so a second phone cannot mark it twice", () => {
  const person = {
    code: "12166",
    full: "UTT20260900012166",
    name: "barna NA",
    email: "barna_c@yahoo.com",
    items: [{ name: "Regular Member Entry", qty: 1, lane: "entry", tone: "entry" }],
  };
  const first = ledger.acquireLock(ledger.emptyBook(), "12166", "phone-a", "admin", "2026-10-03T18:00:00.000Z");
  const marked = ledger.markItem(first.book, person, 0, "2026-10-03T18:00:30.000Z", "admin", "phone-a");
  assert.equal(marked.changed, true);
  const second = ledger.acquireLock(marked.book, "12166", "phone-b", "admin", "2026-10-03T18:01:00.000Z");
  assert.equal(second.locked, true);
  const blocked = ledger.markItem(marked.book, person, 0, "2026-10-03T18:01:00.000Z", "admin", "phone-b");
  assert.equal(blocked.locked, true);
  assert.equal(blocked.changed, false);
  marked.book.sheet = { orders: { "12166": person }, fileName: "source" };
  marked.book.accounts = [{ username: "siteadmin", hash: "a".repeat(64), role: "records" }];
  const cleared = ledger.cleanupAll(marked.book, "2026-10-03T18:02:00.000Z", "admin");
  assert.equal(cleared.book.cleanupAll, true);
  assert.equal(cleared.book.allowCleanup, true);
  assert.equal(cleared.book.actor, "siteadmin");
  assert.equal(Object.keys(cleared.book.orders).length, 0);
  assert.equal(Object.keys(cleared.book.locks).length, 0);
  assert.equal(cleared.book.sheet.orders["12166"].name, "barna NA");
  assert.equal(cleared.book.accounts[0].username, "siteadmin");
  assert.match(cleared.book.log[0].text, /admin cleaned up everything/);
});

test("source sheet edits remove an order or one item", () => {
  const book = ledger.prepareSourceSheet(ledger.emptyBook(), {
    "12166": {
      code: "12166",
      name: "barna NA",
      items: [
        { name: "Regular Member Entry", qty: 1 },
        { name: "Fish", qty: 2 },
      ],
    },
  });
  const item = ledger.editSourceSheet(book, { type: "delete-item", code: "12166", name: "Fish" }, "2026-10-07T00:00:00.000Z", "admin");
  assert.equal(item.changed, true);
  assert.deepEqual(item.book.sheet.orders["12166"].items.map((entry) => entry.name), ["Regular Member Entry"]);
  const order = ledger.editSourceSheet(item.book, { type: "delete-order", code: "12166" }, "2026-10-07T00:01:00.000Z", "admin");
  assert.equal(order.changed, true);
  assert.equal(order.book.sheet.orders["12166"], undefined);
});

test("site admin can save logins when one site admin remains", () => {
  const book = ledger.emptyBook();
  book.sheet = { orders: { "12166": { code: "12166" } }, fileName: "source" };
  const saved = ledger.saveAccounts(book, [
    { username: "SiteAdmin", hash: "ab".repeat(32), role: "records" },
    { username: "desk", hash: "cd".repeat(32), role: "desk" },
  ], "2026-10-07T00:00:00.000Z", "siteadmin");
  assert.equal(saved.changed, true);
  assert.equal(saved.book.accountsWrite, true);
  assert.equal(saved.book.accounts[0].username, "siteadmin");
  assert.equal(saved.book.accounts[1].abilities.sell, true);
  assert.equal(saved.book.accounts[1].abilities.edit, false);
  assert.equal(saved.book.accounts[1].abilities.admin, false);
  assert.equal(saved.book.sheet.logins[1].username, "desk");
  assert.equal(saved.book.sheet.orders["12166"].code, "12166");
  const blocked = ledger.saveAccounts(ledger.emptyBook(), [
    { username: "desk", hash: "cd".repeat(32), role: "desk" },
  ], "2026-10-07T00:00:00.000Z", "siteadmin");
  assert.equal(blocked.changed, false);
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
