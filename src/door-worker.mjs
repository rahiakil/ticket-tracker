import { handleLive } from "./live-door.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live") return handleLive(request, env);
    return new Response("Not found", { status: 404 });
  },
};
