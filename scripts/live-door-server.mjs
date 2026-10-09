import http from "node:http";
import { handleLive } from "../src/live-door.mjs";

const port = Number(process.env.PORT || 8787);
const token = process.env.GITHUB_TOKEN || "";
if (!token) {
  console.error("Set GITHUB_TOKEN before starting the save door.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const response = await handleLive(request, { GITHUB_TOKEN: token });
    const bytes = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(bytes);
    console.log(`${req.method} ${req.url} ${response.status}`);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "write failed" }));
    console.error(req.method, req.url, error && error.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Save door listening on ${port}`);
});
