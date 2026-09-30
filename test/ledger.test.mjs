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
  assert.equal(again.changed, false);
  assert.equal(again.already, true);
  assert.equal(again.book.lines.length, 1);
  assert.equal(again.book.counts.peopleScanned, 1);
  const variant992 = again.book.counts.variants["992"];
  assert.equal(variant992.orders, 1);
  assert.equal(variant992.notTaken, 1);
  const partial = ledger.markTaken(again.book, "12196", "992", true, "2026-09-30T01:10:00.000Z", "siteadmin");
  assert.equal(ledger.statusOf(partial.book.orders["12196"]), "Partially taken");
  let book = partial.book;
  for (const id of parsed.variants) book = ledger.markTaken(book, "12196", id, true, "2026-09-30T01:20:00.000Z", "siteadmin").book;
  assert.equal(ledger.statusOf(book.orders["12196"]), "Taken");
  assert.equal(book.orders["12196"].scannedAt, "2026-09-30T01:00:00.000Z");
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
