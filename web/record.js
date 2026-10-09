(function (root) {
  const URL_RE = /^https:\/\/(?:script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)|api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/contents\/[\w./-]+)$/;

  function recordUrl(value) {
    const text = String(value || "").trim();
    return URL_RE.test(text) ? text : "";
  }

  async function commit(options, mutate) {
    const url = recordUrl(options.recordUrl);
    if (!url) return { ok: false, message: "Add the record link first." };
    const load = options.load;
    const post = options.post;
    const newId = options.newId || (() => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let book;
      let missing = false;
      try {
        book = await load(url);
      } catch (error) {
        if (error && error.message === "missing") missing = true;
        else return { ok: false, message: failMessage(error) };
      }
      if (missing) book = { schemaVersion: 1, lines: [], log: [], orders: {}, locks: {}, walkups: {}, disputes: [] };
      if (!book || book.schemaVersion !== 1 || !book.orders) return { ok: false, message: "Could not save—retry. The record file was not readable." };
      const changed = mutate(book);
      if (!changed.write) {
        if (missing) return { ok: false, missing: true, message: "" };
        return { ok: true, message: changed.message, book };
      }
      const writeId = newId();
      changed.book.lastWriteId = writeId;
      try {
        await post(url, changed.book);
      } catch (error) {
        if (error && error.message === "token") return { ok: false, message: "Could not save—retry. Add the GitHub save key on this phone." };
        continue;
      }
      let confirmed;
      try {
        confirmed = await load(url);
      } catch {
        continue;
      }
      if (confirmed && confirmed.lastWriteId === writeId) return { ok: true, message: changed.message, book: confirmed };
    }
    return { ok: false, message: "Could not save—retry. The record did not confirm the save." };
  }

  function failMessage(error) {
    const reason = error && error.message;
    if (reason === "access") return "Could not save—retry. Google refused access. Set Who has access to Anyone.";
    if (reason === "timeout") return "Could not save—retry. The record link did not answer.";
    return "Could not save—retry";
  }

  let contentSha = "";

  function pageConfig() {
    return root.TICKET_TRACKER_CONFIG || {};
  }

  function githubToken() {
    const config = pageConfig();
    const prefix = String(config.storagePrefix || "ticket-tracker").replace(/[^\w-]/g, "") || "ticket-tracker";
    let saved = "";
    try { saved = root.localStorage.getItem(`${prefix}-github-token`) || ""; } catch { saved = ""; }
    return String(config.githubToken || saved || "").trim();
  }

  function githubBranch() {
    return String(pageConfig().githubBranch || "live");
  }

  function saveUrl() {
    return String(pageConfig().saveUrl || "").trim();
  }

  function isGithub(url) {
    return /^https:\/\/api\.github\.com\/repos\//.test(String(url || ""));
  }

  function decodeContent(content) {
    const binary = atob(String(content || "").replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  function encodeContent(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function githubHeaders(token, raw) {
    const headers = {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function loadShared(url) {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) {
      contentSha = "";
      throw new Error("missing");
    }
    if (!response.ok) throw new Error("timeout");
    const body = await response.json();
    contentSha = body.sha || "";
    const book = body.book;
    if (!book || book.schemaVersion !== 1 || !book.orders) throw new Error("access");
    return book;
  }

  async function postShared(url, book) {
    const payload = { ...book };
    delete payload._sha;
    delete payload.statusGrid;
    delete payload.onSiteGrid;
    delete payload.statsGrid;
    if (payload.sheet) payload.sheet = { epoch: payload.sheet.epoch || "", fileName: "website", orders: {} };
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Content-Sha": contentSha || "" },
      body: JSON.stringify(payload),
    });
    if (response.status === 409 || response.status === 422) throw new Error("conflict");
    if (!response.ok) throw new Error("timeout");
    const body = await response.json();
    contentSha = body.sha || contentSha;
  }

  async function loadGithub(url) {
    const shared = saveUrl();
    if (shared && !githubToken()) return loadShared(shared);
    const token = githubToken();
    const response = await fetch(`${url}?ref=${encodeURIComponent(githubBranch())}`, { headers: githubHeaders(token, false) });
    if (response.status === 404) {
      contentSha = "";
      throw new Error("missing");
    }
    if (response.status === 403 || response.status === 429) throw new Error("timeout");
    if (!response.ok) throw new Error("access");
    const body = await response.json();
    contentSha = body.sha || "";
    const book = JSON.parse(decodeContent(body.content || ""));
    if (!book || book.schemaVersion !== 1 || !book.orders) throw new Error("access");
    return book;
  }

  async function postGithub(url, book) {
    const shared = saveUrl();
    if (shared && !githubToken()) return postShared(shared, book);
    const token = githubToken();
    if (!token) throw new Error("token");
    const payload = { ...book };
    delete payload._sha;
    delete payload.statusGrid;
    delete payload.onSiteGrid;
    delete payload.statsGrid;
    if (payload.sheet) payload.sheet = { epoch: payload.sheet.epoch || "", fileName: "website", orders: {} };
    const response = await fetch(url, {
      method: "PUT",
      headers: { ...githubHeaders(token, false), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Update live tickets",
        content: encodeContent(JSON.stringify(payload)),
        sha: contentSha || undefined,
        branch: githubBranch(),
      }),
    });
    if (response.status === 409 || response.status === 422) throw new Error("conflict");
    if (response.status === 401 || response.status === 403) throw new Error("token");
    if (!response.ok) throw new Error("access");
    const body = await response.json();
    contentSha = body.content && body.content.sha || contentSha;
  }

  function loadWithScript(url) {
    if (isGithub(url)) return loadGithub(url);
    return new Promise((resolve, reject) => {
      const callback = `ttRecord_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const script = root.document.createElement("script");
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout"));
      }, 28000);
      function cleanup() {
        clearTimeout(timer);
        delete root[callback];
        script.remove();
      }
      root[callback] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("access"));
      };
      const join = url.includes("?") ? "&" : "?";
      script.src = `${url}${join}callback=${callback}&t=${Date.now()}`;
      root.document.head.append(script);
    });
  }

  function postWithForm(url, book) {
    if (isGithub(url)) return postGithub(url, book);
    return root.fetch(url, {
      method: "POST",
      mode: "no-cors",
      body: new URLSearchParams({ payload: JSON.stringify(book) }),
    });
  }

  root.TicketRecord = { commit, recordUrl, loadWithScript, postWithForm };
})(typeof globalThis !== "undefined" ? globalThis : this);
