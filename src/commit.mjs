import { saveFailed } from "./logic.mjs";

export async function commitJson(read, write, mutate, { attempts = 5 } = {}) {
  let tries = 0;
  try {
    for (; tries < attempts; tries += 1) {
      const current = await read();
      const applied = mutate(current.data);
      if (!applied.write) return { result: applied.result, attempts: tries + 1 };
      const saved = await write(applied.data, current.sha, applied.message || "Update event state");
      if (saved.ok) return { result: applied.result, attempts: tries + 1 };
      if (!saved.conflict) return { result: saveFailed(), attempts: tries + 1 };
    }
    return { result: saveFailed(), attempts };
  } catch {
    return { result: saveFailed(), attempts: tries };
  }
}
