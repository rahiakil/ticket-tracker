(function (root) {
  const ORDER_RE = /order-(\d+)-variant-(\d+(?:\|\d+)*)/i;

  function parseQr(raw) {
    if (typeof raw !== "string") return null;
    const match = raw.match(ORDER_RE);
    if (!match) return null;
    const variants = [...new Set(match[2].split("|").filter(Boolean))];
    if (!variants.length) return null;
    return { orderId: match[1], variants, raw: match[0] };
  }

  function emptyBook() {
    return { schemaVersion: 1, lines: [], log: [], orders: {} };
  }

  const MAX_ORDERS = 10000;

  function pruneBook(book) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    if (!Array.isArray(next.log)) next.log = [];
    const oldestFirst = Object.keys(next.orders || {}).sort((left, right) => {
      const leftTime = Date.parse(next.orders[left].updatedAt || next.orders[left].scannedAt || 0);
      const rightTime = Date.parse(next.orders[right].updatedAt || next.orders[right].scannedAt || 0);
      return leftTime - rightTime;
    });
    while (oldestFirst.length > MAX_ORDERS) {
      delete next.orders[oldestFirst.shift()];
    }
    if (next.log.length > MAX_ORDERS) next.log = next.log.slice(-MAX_ORDERS);
    if ((next.lines || []).length > MAX_ORDERS) next.lines = next.lines.slice(-MAX_ORDERS);
    next.counts = countsOf(next);
    return next;
  }

  function ready(book) {
    return Boolean(book && book.schemaVersion === 1 && book.orders);
  }

  function takenNumbers(order) {
    const total = Object.keys(order.variants || {}).length;
    let taken = typeof order.takenCount === "number"
      ? order.takenCount
      : Object.values(order.variants || {}).filter((item) => item.taken).length;
    if (!Number.isFinite(taken)) taken = 0;
    taken = Math.max(0, Math.min(total, Math.round(taken)));
    return { taken, total };
  }

  function statusOf(order) {
    const { taken, total } = takenNumbers(order);
    if (taken <= 0) return "Scanned but not taken";
    if (taken < total) return "Partially taken";
    return "Taken";
  }

function statusDetail(order) {
  const { taken, total } = takenNumbers(order);
  const status = statusOf(order);
  const notPickedUp = Math.max(0, total - taken);
  if (status === "Scanned but not taken") return `${status}. Picked up 0. Not picked up ${total}.`;
  return `${status}. Picked up ${taken}. Not picked up ${notPickedUp}.`;
}

  function addLine(book, at, text) {
    book.lines.push(`${at} ${text}`);
  }

  function rememberScan(book, parsed, at, actor) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    const existing = next.orders[parsed.orderId];
    const variants = existing ? structuredClone(existing.variants) : {};
    let changed = !existing;
    for (const id of parsed.variants) {
      if (!variants[id]) {
        variants[id] = { taken: false, takenAt: null };
        changed = true;
      }
    }
    next.orders[parsed.orderId] = {
      orderId: parsed.orderId,
      raw: parsed.raw,
      scannedAt: existing?.scannedAt || at,
      updatedAt: existing && !changed ? existing.updatedAt : at,
      actor: existing?.actor || actor,
      variants,
    };
    const note = existing ? `already scanned order ${parsed.orderId}` : `scanned order ${parsed.orderId}`;
    if (!existing) addLine(next, at, `order ${parsed.orderId} scanned but not taken`);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: note });
    return { book: pruneBook(next), changed: changed || Boolean(existing), already: Boolean(existing) };
  }

  function setTakenCount(book, orderId, count, at, actor) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    const order = next.orders[orderId];
    if (!order) return { book: next, changed: false };
    const total = Object.keys(order.variants || {}).length;
    let taken = Math.round(Number(count));
    if (!Number.isFinite(taken)) taken = total;
    taken = Math.max(0, Math.min(total, taken));
    if (takenNumbers(order).taken === taken && typeof order.takenCount === "number") return { book: next, changed: false };
    order.takenCount = taken;
    const ids = Object.keys(order.variants || {}).sort((left, right) => Number(left) - Number(right));
    ids.forEach((id, index) => {
      const isTaken = index < taken;
      order.variants[id].taken = isTaken;
      order.variants[id].takenAt = isTaken ? at : null;
    });
    order.updatedAt = at;
    order.actor = actor || order.actor;
    addLine(next, at, `order ${orderId} taken ${taken} out of ${total}`);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: `order ${orderId} taken ${taken} out of ${total}` });
    return { book: pruneBook(next), changed: true };
  }

  function deleteOrder(book, orderId, at, actor) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    if (!next.orders[orderId]) return { book: next, changed: false };
    delete next.orders[orderId];
    addLine(next, at, `order ${orderId} deleted by ${actor}`);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: `order ${orderId} deleted by ${actor}` });
    return { book: pruneBook(next), changed: true };
  }

  function markTaken(book, orderId, variantId, taken, at, actor) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    const order = next.orders[orderId];
    if (!order || !order.variants[variantId]) return { book: next, changed: false };
    const variant = order.variants[variantId];
    if (Boolean(variant.taken) === Boolean(taken)) return { book: next, changed: false };
    variant.taken = Boolean(taken);
    variant.takenAt = taken ? at : null;
    order.updatedAt = at;
    order.actor = actor || order.actor;
    addLine(next, at, `order ${orderId} variant ${variantId} ${taken ? "taken" : "not taken"}`);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: `order ${orderId} variant ${variantId} ${taken ? "taken" : "not taken"}` });
    return { book: pruneBook(next), changed: true };
  }

  function countsOf(book) {
    const orders = Object.values((book && book.orders) || {});
    const variants = {};
    for (const order of orders) {
      for (const [id, variant] of Object.entries(order.variants || {})) {
        if (!variants[id]) variants[id] = { orders: 0, taken: 0, notTaken: 0 };
        variants[id].orders += 1;
        if (variant.taken) variants[id].taken += 1;
        else variants[id].notTaken += 1;
      }
    }
    const itemTotal = orders.reduce((sum, order) => sum + takenNumbers(order).total, 0);
    const ticketsTaken = orders.reduce((sum, order) => sum + takenNumbers(order).taken, 0);
    return { peopleScanned: orders.length, itemTotal, ticketsTaken, variants };
  }

  function summary(book) {
    return Object.values(book.orders || {})
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((order) => ({
        orderId: order.orderId,
        raw: order.raw,
        scannedAt: order.scannedAt,
        updatedAt: order.updatedAt,
        actor: order.actor,
        status: statusOf(order),
        detail: statusDetail(order),
        taken: takenNumbers(order).taken,
        total: takenNumbers(order).total,
        variants: Object.keys(order.variants).sort((left, right) => Number(left) - Number(right)).map((id) => ({
          id,
          taken: Boolean(order.variants[id].taken),
          takenAt: order.variants[id].takenAt,
        })),
      }));
  }

  function utf8ToBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function base64ToUtf8(value) {
    const binary = atob(String(value).replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  function headers(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ticket-tracker",
      "Content-Type": "application/json",
    };
  }

  async function readRemote(options) {
    const response = await options.fetchImpl(`${options.url}?ref=${encodeURIComponent(options.branch || "main")}`, { headers: headers(options.token) });
    if (response.status === 404) return { book: emptyBook(), sha: null };
    if (!response.ok) throw new Error("read failed");
    const body = await response.json();
    const book = JSON.parse(base64ToUtf8(body.content || ""));
    if (!ready(book)) throw new Error("bad book");
    return { book, sha: body.sha };
  }

  async function writeRemote(options, book, sha, message) {
    const response = await options.fetchImpl(options.url, {
      method: "PUT",
      headers: headers(options.token),
      body: JSON.stringify({
        message,
        content: utf8ToBase64(`${JSON.stringify(book, null, 2)}\n`),
        sha: sha || undefined,
        branch: options.branch || "main",
      }),
    });
    if (response.status === 409 || response.status === 422) return { ok: false, conflict: true };
    if (!response.ok) return { ok: false, conflict: false };
    const body = await response.json();
    return { ok: true, sha: body.content?.sha || null };
  }

  async function commitRemote(options, mutate) {
    if (!options.token || !options.repo) return { ok: false, message: "Could not save—retry" };
    const safeRepo = /^[\w.-]+\/[\w.-]+$/.test(options.repo);
    const safeFile = /^[\w.-]+$/.test(options.file || "");
    if (!safeRepo || !safeFile) return { ok: false, message: "Could not save—retry" };
    const url = `https://api.github.com/repos/${options.repo}/contents/${options.file}`;
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const target = { ...options, url, fetchImpl };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let current;
      try { current = await readRemote(target); } catch { return { ok: false, message: "Could not save—retry" }; }
      const changed = mutate(current.book);
      if (!changed.write) return { ok: true, message: changed.message, book: current.book, sha: current.sha };
      const written = await writeRemote(target, changed.book, current.sha, changed.commitMessage);
      if (written.ok) return { ok: true, message: changed.message, book: changed.book, sha: written.sha };
      if (!written.conflict) return { ok: false, message: "Could not save—retry" };
    }
    return { ok: false, message: "Could not save—retry" };
  }

  root.TicketLedger = {
    parseQr,
    emptyBook,
    statusOf,
    statusDetail,
    takenNumbers,
    setTakenCount,
    deleteOrder,
    rememberScan,
    markTaken,
    countsOf,
    pruneBook,
    summary,
    commitRemote,
    readRemote,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
