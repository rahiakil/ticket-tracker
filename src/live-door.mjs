const MAX_BYTES = 1500000;
const API = "https://api.github.com/repos/rahiakil/ticket-tracker/contents/web/live.json";
const BRANCH = "live";

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function decode(content) {
  return Buffer.from(String(content || "").replace(/\s/g, ""), "base64").toString("utf8");
}

function allowOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  if (origin === "https://rahiakil.github.io") return origin;
  if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) return origin;
  return "https://rahiakil.github.io";
}

function headersFor(request) {
  return {
    "Access-Control-Allow-Origin": allowOrigin(request),
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Content-Sha",
    Vary: "Origin",
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ticket-tracker",
  };
}

export async function handleLive(request, env, fetchImpl = fetch) {
  const headers = headersFor(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const token = env && env.GITHUB_TOKEN;
  if (!token) return Response.json({ message: "Save door is not configured." }, { status: 503, headers });
  if (request.method === "GET") {
    const response = await fetchImpl(`${API}?ref=${encodeURIComponent(BRANCH)}`, { headers: githubHeaders(token) });
    if (response.status === 404) return Response.json({ message: "missing" }, { status: 404, headers });
    if (!response.ok) return Response.json({ message: "read failed" }, { status: 502, headers });
    const body = await response.json();
    let book;
    try {
      book = JSON.parse(decode(body.content || ""));
    } catch {
      return Response.json({ message: "read failed" }, { status: 502, headers });
    }
    return Response.json({ sha: body.sha || "", book }, { headers });
  }
  if (request.method !== "PUT") return new Response("Not found", { status: 404, headers });
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return Response.json({ message: "too large" }, { status: 413, headers });
  let book;
  try {
    book = JSON.parse(raw);
  } catch {
    return Response.json({ message: "bad json" }, { status: 400, headers });
  }
  if (!book || book.schemaVersion !== 1 || !book.orders || typeof book.orders !== "object" || Array.isArray(book.orders)) {
    return Response.json({ message: "bad book" }, { status: 400, headers });
  }
  delete book._sha;
  delete book.statusGrid;
  delete book.onSiteGrid;
  delete book.statsGrid;
  const sha = String(request.headers.get("X-Content-Sha") || "").trim();
  const response = await fetchImpl(API, {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Update live tickets",
      content: encode(JSON.stringify(book)),
      sha: sha || undefined,
      branch: BRANCH,
    }),
  });
  if (response.status === 409 || response.status === 422) return Response.json({ message: "conflict" }, { status: 409, headers });
  if (!response.ok) return Response.json({ message: "write failed" }, { status: 502, headers });
  const body = await response.json();
  return Response.json({ sha: (body.content && body.content.sha) || "" }, { headers });
}
