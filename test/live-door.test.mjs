import assert from "node:assert/strict";
import test from "node:test";
import { handleLive } from "../src/live-door.mjs";

function book() {
  return { schemaVersion: 1, orders: {}, lines: [], log: [], locks: {}, walkups: {}, disputes: [] };
}

test("live door writes only the live ticket file and hides the GitHub response", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: "next" } }),
    };
  };
  const response = await handleLive(new Request("https://door.example/api/live", {
    method: "PUT",
    headers: { Origin: "https://rahiakil.github.io", "X-Content-Sha": "prev", "Content-Type": "application/json" },
    body: JSON.stringify(book()),
  }), { GITHUB_TOKEN: "secret-token" }, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://rahiakil.github.io");
  const body = await response.json();
  assert.equal(body.sha, "next");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rahiakil\/ticket-tracker\/contents\/web\/live\.json$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.branch, "live");
  assert.equal(sent.sha, "prev");
  assert.equal(JSON.parse(Buffer.from(sent.content, "base64").toString("utf8")).schemaVersion, 1);
});

test("live door rejects a payload that is not a ticket book", async () => {
  const response = await handleLive(new Request("https://door.example/api/live", {
    method: "PUT",
    body: JSON.stringify({ hello: true }),
  }), { GITHUB_TOKEN: "secret-token" }, async () => {
    throw new Error("should not call GitHub");
  });
  assert.equal(response.status, 400);
});
