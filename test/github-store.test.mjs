import assert from "node:assert/strict";
import test from "node:test";
import { commitJson } from "../src/commit.mjs";
import { base64ToUtf8, utf8ToBase64 } from "../src/encoding.mjs";
import { githubStore } from "../src/github-store.mjs";
import { MESSAGES, applyScan, emptyState } from "../src/logic.mjs";

const CODE = "aaaaaaaaaaaaaaaaaaaaaa";

function docs() {
  const state = emptyState("2026-09-29T00:00:00.000Z");
  state.issued.push({ id: CODE, issuedAt: state.event.updatedAt });
  state.statuses[CODE] = { seen: false, firstSeenAt: null, cycle: 1 };
  return state;
}

function mockGitHub() {
  let doc = docs();
  let sha = "sha-1";
  let puts = 0;
  let authorization = "";
  const fetchImpl = async (url, options = {}) => {
    authorization = options.headers?.Authorization || authorization;
    if (options.method !== "PUT") {
      return Response.json({ content: utf8ToBase64(JSON.stringify(doc)), sha, encoding: "base64" });
    }
    puts += 1;
    const body = JSON.parse(options.body);
    if (body.sha !== sha) return new Response(JSON.stringify({ message: "sha mismatch" }), { status: 409 });
    doc = JSON.parse(base64ToUtf8(body.content));
    sha = `sha-${puts + 1}`;
    return Response.json({ content: { sha } });
  };
  return {
    fetchImpl,
    puts: () => puts,
    current: () => doc,
    authorization: () => authorization,
    forceConflictOnce() {
      const original = fetchImpl;
      let armed = true;
      return async (url, options = {}) => {
        if (armed && options.method === "PUT") {
          armed = false;
          sha = "sha-other-writer";
          return new Response(JSON.stringify({ message: "sha mismatch" }), { status: 409 });
        }
        return original(url, options);
      };
    },
  };
}

test("GitHub writes retry after a SHA conflict and keep the bearer token on the request", async () => {
  const github = mockGitHub();
  const fetchImpl = github.forceConflictOnce();
  const store = githubStore({ token: "test-token", repo: "rahiakil/ticket-tracker-data", fetchImpl });
  const saved = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE, requestId: crypto.randomUUID(), actor: "Ada Admin", at: "2026-09-29T18:00:00.000Z",
  }));
  assert.equal(saved.result.message, MESSAGES.recorded);
  assert.equal(saved.attempts, 2);
  assert.equal(github.authorization(), "Bearer test-token");
  const current = await store.readState();
  assert.equal(current.data.statuses[CODE].seen, true);
  assert.equal(current.data.events.length, 1);
});

test("GitHub conflicts stop after five attempts", async () => {
  let puts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "PUT") {
      puts += 1;
      return new Response("sha", { status: 409 });
    }
    const doc = docs();
    return Response.json({ content: utf8ToBase64(JSON.stringify(doc)), sha: "sha-1" });
  };
  const store = githubStore({ token: "test-token", repo: "rahiakil/ticket-tracker-data", fetchImpl });
  const saved = await commitJson(() => store.readState(), (...args) => store.writeState(...args), (state) => applyScan(state, {
    code: CODE, requestId: crypto.randomUUID(), actor: "Ada Admin", at: "2026-09-29T18:00:00.000Z",
  }));
  assert.equal(saved.result.message, MESSAGES.save_failed);
  assert.equal(puts, 5);
});

test("the data repository name is validated before any request", () => {
  assert.throws(() => githubStore({ token: "test-token", repo: "https://github.com/owner/name" }));
});
