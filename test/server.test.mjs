import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, emptyUsers } from "../src/logic.mjs";
import { createMemoryStore } from "../src/memory-store.mjs";
import { startServer } from "../src/server.mjs";

test("the local server shows the gate and a page load does not record a scan", async () => {
  const store = createMemoryStore({ state: emptyState("2026-09-29T00:00:00.000Z"), users: emptyUsers() });
  let writes = 0;
  const writeState = store.writeState.bind(store);
  store.writeState = async (...args) => {
    writes += 1;
    return writeState(...args);
  };
  const started = await startServer({
    store,
    sessionSecret: "test-session-secret-should-be-long-enough",
    publicPageUrl: "https://rahiakil.github.io/ticket-tracker/",
    demo: false,
  });
  try {
    const page = await fetch(`${started.url}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /For you, without login, we will not allow you\./);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal((await fetch(`${started.url}/users.json`)).status, 404);
    assert.equal((await (await fetch(`${started.url}/api/session`)).json()).authenticated, false);
    const css = await fetch(`${started.url}/styles.css`);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.equal(writes, 0);
  } finally {
    await started.close();
  }
});
