import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

test("the gate is a separate Ticket Tracker page", () => {
  assert.match(html, /<title>Ticket Tracker<\/title>/);
  assert.match(html, /For you, without login, we will not allow you\./);
  assert.match(html, /name="viewport"/);
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /Hey, scan the QR code\./);
  assert.match(html, /Scan QR/);
  assert.equal(html.includes("/api/scans"), false);
  assert.match(css, /min-height:\s*52px/);
  assert.match(app, /Invalid QR/);
  assert.match(app, /Could not save—retry/);
  assert.match(app, /Mark taken/);
  assert.equal(app.includes("FormData"), false);
  assert.equal(app.includes("location.href"), false);
  assert.match(app, /facingMode:\s*"environment"/);
  assert.match(app, /siteadmin/);
  assert.equal(app.includes("not connected"), false);
});
