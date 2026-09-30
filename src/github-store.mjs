import { base64ToUtf8, utf8ToBase64 } from "./encoding.mjs";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ticket-tracker",
  };
}

async function readFile(fetchImpl, { token, repo, branch }, filePath) {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (response.status === 404) {
    const error = new Error(`Missing ${filePath}`);
    error.code = "missing";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`GitHub read failed (${response.status})`);
    error.code = "github";
    throw error;
  }
  const body = await response.json();
  const data = JSON.parse(base64ToUtf8(body.content || ""));
  return { sha: body.sha, data };
}

async function writeFile(fetchImpl, { token, repo, branch }, filePath, data, sha, message) {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(`${JSON.stringify(data, null, 2)}\n`),
      sha,
      branch,
    }),
  });
  if (response.status === 409) return { ok: false, conflict: true };
  if (response.status === 422) {
    const text = await response.text();
    return { ok: false, conflict: /sha/i.test(text) };
  }
  if (!response.ok) return { ok: false, conflict: false };
  return { ok: true, conflict: false };
}

export function githubStore({ token, repo, branch = "main", fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("DATA_REPO must look like owner/name");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const target = { token, repo, branch };
  return {
    readState: () => readFile(fetchImpl, target, "event-state.json"),
    writeState: (data, sha, message) => writeFile(fetchImpl, target, "event-state.json", data, sha, message),
    readUsers: () => readFile(fetchImpl, target, "users.json"),
    writeUsers: (data, sha, message) => writeFile(fetchImpl, target, "users.json", data, sha, message),
  };
}
