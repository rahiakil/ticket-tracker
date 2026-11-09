#!/usr/bin/env node
/**
 * Emergency door for networks that block github.io / workers.dev (e.g. iBoss).
 * Serves web/ and proxies /api/live through the GitHub Contents API using `gh auth`.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "web");
const port = Number(process.env.PORT || 8788);
const repo = process.env.DATA_REPO || "rahiakil/ticket-tracker";
const branch = process.env.DATA_BRANCH || "live";
const apiPath = `/repos/${repo}/contents/web/live.json`;
const maxBytes = 1_500_000;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const out = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error("Run gh auth login first (needs repo scope).");
  return String(out.stdout || "").trim();
}

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function decode(content) {
  return Buffer.from(String(content || "").replace(/\s+/g, ""), "base64").toString("utf8");
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Content-Sha",
    Vary: "Origin",
  };
}

async function github(path, init = {}) {
  const token = ghToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ticket-tracker-emergency-door",
      ...(init.headers || {}),
    },
  });
  return response;
}

async function handleLive(request, response, origin) {
  const headers = { ...cors(origin), "Content-Type": "application/json; charset=utf-8" };
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers);
    response.end();
    return;
  }
  if (request.method === "GET") {
    const upstream = await github(`${apiPath}?ref=${encodeURIComponent(branch)}`);
    if (upstream.status === 404) {
      response.writeHead(404, headers);
      response.end(JSON.stringify({ message: "missing" }));
      return;
    }
    if (!upstream.ok) {
      response.writeHead(502, headers);
      response.end(JSON.stringify({ message: "read failed" }));
      return;
    }
    const body = await upstream.json();
    let book;
    try {
      book = JSON.parse(decode(body.content || ""));
    } catch {
      response.writeHead(502, headers);
      response.end(JSON.stringify({ message: "read failed" }));
      return;
    }
    response.writeHead(200, headers);
    response.end(JSON.stringify({ sha: body.sha || "", book }));
    return;
  }
  if (request.method !== "PUT") {
    response.writeHead(404, headers);
    response.end(JSON.stringify({ message: "not found" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length > maxBytes) {
    response.writeHead(413, headers);
    response.end(JSON.stringify({ message: "too large" }));
    return;
  }
  let book;
  try {
    book = JSON.parse(raw);
  } catch {
    response.writeHead(400, headers);
    response.end(JSON.stringify({ message: "bad json" }));
    return;
  }
  if (!book || book.schemaVersion !== 1 || !book.orders || typeof book.orders !== "object" || Array.isArray(book.orders)) {
    response.writeHead(400, headers);
    response.end(JSON.stringify({ message: "bad book" }));
    return;
  }
  delete book._sha;
  delete book.statusGrid;
  delete book.onSiteGrid;
  delete book.statsGrid;
  const sha = String(request.headers["x-content-sha"] || "").trim();
  const upstream = await github(apiPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Update live tickets",
      content: encode(JSON.stringify(book)),
      sha: sha || undefined,
      branch,
    }),
  });
  if (upstream.status === 409 || upstream.status === 422) {
    response.writeHead(409, headers);
    response.end(JSON.stringify({ message: "conflict" }));
    return;
  }
  if (!upstream.ok) {
    response.writeHead(502, headers);
    response.end(JSON.stringify({ message: "write failed" }));
    return;
  }
  const body = await upstream.json();
  response.writeHead(200, headers);
  response.end(JSON.stringify({ sha: (body.content && body.content.sha) || "" }));
}

function safePath(urlPath) {
  const clean = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const relative = clean === "/" ? "/index.html" : clean;
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) return null;
  return full;
}

function sendFile(response, filePath, urlPath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const type = types[extname(filePath).toLowerCase()] || "application/octet-stream";
  let body = readFileSync(filePath);
  // Point the door at this same-origin /api/live so blocked workers.dev is not needed.
  if (String(urlPath || "").startsWith("/config.js")) {
    const text = body.toString("utf8").replace(
      /saveUrl:\s*"[^"]*"/,
      'saveUrl: "/api/live"',
    ).replace(
      /publicPageUrl:\s*"[^"]*"/,
      'publicPageUrl: window.location.origin + "/"',
    );
    body = Buffer.from(text, "utf8");
  }
  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "*";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/live") {
      await handleLive(request, response, origin);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    const filePath = safePath(url.pathname);
    if (!filePath) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad path");
      return;
    }
    sendFile(response, filePath, url.pathname);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", ...cors(origin) });
    response.end(JSON.stringify({ message: String(error && error.message || error) }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    ok: true,
    root,
    port,
    local: `http://127.0.0.1:${port}/`,
    api: `http://127.0.0.1:${port}/api/live`,
  }, null, 2));
});
