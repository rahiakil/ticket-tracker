import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function fileStore(directory) {
  let chain = Promise.resolve();
  const lock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  async function read(name) {
    const text = await readFile(path.join(directory, name), "utf8");
    return { sha: fingerprint(text), data: JSON.parse(text) };
  }

  async function write(name, data, sha) {
    const file = path.join(directory, name);
    const text = await readFile(file, "utf8");
    if (fingerprint(text) !== sha) return { ok: false, conflict: true };
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return { ok: true, conflict: false };
  }

  return {
    readState: () => lock(() => read("event-state.json")),
    writeState: (data, sha) => lock(() => write("event-state.json", data, sha)),
    readUsers: () => lock(() => read("users.json")),
    writeUsers: (data, sha) => lock(() => write("users.json", data, sha)),
  };
}
