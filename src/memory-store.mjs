export function createMemoryStore({ state, users }) {
  let current = structuredClone(state);
  let userDoc = structuredClone(users);
  let sha = 1;
  let userSha = 1;
  return {
    async readState() {
      return { sha: String(sha), data: structuredClone(current) };
    },
    async writeState(data, expected) {
      if (expected !== String(sha)) return { ok: false, conflict: true };
      current = structuredClone(data);
      sha += 1;
      return { ok: true, conflict: false };
    },
    async readUsers() {
      return { sha: String(userSha), data: structuredClone(userDoc) };
    },
    async writeUsers(data, expected) {
      if (expected !== String(userSha)) return { ok: false, conflict: true };
      userDoc = structuredClone(data);
      userSha += 1;
      return { ok: true, conflict: false };
    },
  };
}
