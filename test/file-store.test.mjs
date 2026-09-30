import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileStore } from "../src/file-store.mjs";
import { emptyState } from "../src/logic.mjs";

test("local files reject a stale SHA", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-tracker-"));
  try {
    const state = emptyState("2026-09-29T00:00:00.000Z");
    await writeFile(path.join(directory, "event-state.json"), `${JSON.stringify(state)}\n`);
    await writeFile(path.join(directory, "users.json"), '{"schemaVersion":1,"users":[]}\n');
    const store = fileStore(directory);
    const first = await store.readState();
    const next = structuredClone(first.data);
    next.event.status = "closed";
    const stale = await store.writeState(first.data, "not-the-sha", "stale");
    assert.equal(stale.conflict, true);
    const saved = await store.writeState(next, first.sha, "close");
    assert.equal(saved.ok, true);
    const text = await readFile(path.join(directory, "event-state.json"), "utf8");
    assert.equal(JSON.parse(text).event.status, "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
