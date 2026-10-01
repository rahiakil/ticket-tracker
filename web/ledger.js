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

  const LOCK_MS = 3 * 60 * 1000;

  function emptyBook() {
    return { schemaVersion: 1, lines: [], log: [], orders: {}, locks: {} };
  }

  const MAX_ORDERS = 10000;

  function pruneBook(book) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    if (!Array.isArray(next.log)) next.log = [];
    if (!next.locks || typeof next.locks !== "object") next.locks = {};
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

  function variantList(order) {
    return Object.keys(order.variants || {}).sort((left, right) => {
      const leftIndex = Number(String(left).split(":")[1]);
      const rightIndex = Number(String(right).split(":")[1]);
      if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex) && leftIndex !== rightIndex) return leftIndex - rightIndex;
      const byNumber = Number(left) - Number(right);
      return Number.isFinite(byNumber) && byNumber !== 0 ? byNumber : String(left).localeCompare(String(right));
    }).map((id) => ({
      id: order.variants[id].name || id,
      key: id,
      qty: order.variants[id].qty || 1,
      lane: order.variants[id].lane || "",
      tone: order.variants[id].tone || "",
      taken: Boolean(order.variants[id].taken),
      takenAt: order.variants[id].takenAt,
    }));
  }

  function sheetVariants(person) {
    const variants = {};
    person.items.forEach((item, index) => {
      variants[`item:${index}:${item.name}`] = {
        taken: false,
        takenAt: null,
        name: item.name,
        qty: item.qty,
        lane: item.lane,
        tone: item.tone,
      };
    });
    return variants;
  }

  function syncTakenCount(order) {
    order.takenCount = Object.values(order.variants || {}).filter((item) => item.taken).length;
  }

  function ensureSheetOrder(next, person, raw, at, actor) {
    const existing = next.orders[person.code];
    const variants = existing && existing.variants && Object.keys(existing.variants).length
      ? structuredClone(existing.variants)
      : sheetVariants(person);
    next.orders[person.code] = {
      orderId: person.code,
      fullNumber: person.full,
      name: person.name,
      email: person.email,
      raw: existing?.raw || raw,
      scannedAt: existing?.scannedAt || at,
      updatedAt: existing?.updatedAt || at,
      actor: existing?.actor || actor,
      takenCount: existing?.takenCount || 0,
      variants,
    };
    return { order: next.orders[person.code], existing: Boolean(existing) };
  }

  function rememberSheet(book, person, raw, at, actor, counter) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    const placed = ensureSheetOrder(next, person, raw, at, actor);
    const label = counter === "food" ? "food" : "entry";
    const note = placed.existing
      ? `${person.code} scanned again at the ${label} counter`
      : `${person.code} scanned at the ${label} counter`;
    if (!placed.existing) addLine(next, at, `order ${person.code} scanned but not taken`);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: note });
    if (!placed.existing) placed.order.updatedAt = at;
    return { book: pruneBook(next), changed: true, already: placed.existing, orderId: person.code };
  }

  function markLane(book, person, raw, lane, at, actor) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    const placed = ensureSheetOrder(next, person, raw, at, actor);
    let newlyTaken = 0;
    for (const item of Object.values(placed.order.variants)) {
      if (item.lane !== lane || item.taken) continue;
      item.taken = true;
      item.takenAt = at;
      newlyTaken += 1;
    }
    syncTakenCount(placed.order);
    placed.order.updatedAt = at;
    placed.order.actor = actor || placed.order.actor;
    const text = lane === "entry"
      ? `${person.code} checked in at the entry counter`
      : `${person.code} food picked up at the food counter`;
    const changed = newlyTaken > 0 || !placed.existing;
    if (changed) {
      addLine(next, at, text);
      if (!Array.isArray(next.log)) next.log = [];
      next.log.push({ at, text });
    }
    return { book: pruneBook(next), changed, already: !changed, orderId: person.code };
  }

  function sheetPhrase(items) {
    const list = items || [];
    const entry = list.filter((item) => item.lane === "entry");
    const food = list.filter((item) => item.lane === "food");
    const done = (group) => group.length > 0 && group.every((item) => item.taken);
    const none = (group) => group.every((item) => !item.taken);
    const days = [];
    if (food.some((item) => /saturday/i.test(item.name || item.id || ""))) days.push("Saturday");
    if (food.some((item) => /sunday/i.test(item.name || item.id || ""))) days.push("Sunday");
    const day = days.join(" and ");
    let entryText = "";
    if (entry.length) {
      if (done(entry)) entryText = day ? `Entry done for ${day}` : "Entry done";
      else if (none(entry)) entryText = "Entry not done";
      else entryText = "Entry partly done";
    }
    let foodText = "";
    if (food.length) {
      if (done(food)) foodText = "Food taken";
      else if (none(food)) foodText = "Food not taken";
      else foodText = "Food partly taken";
    }
    return [entryText, foodText].filter(Boolean).join(". ");
  }

  function itemDay(name) {
    const text = String(name || "").toLowerCase();
    if (/\bfriday\b/.test(text)) return "friday";
    if (/\bsaturday\b/.test(text)) return "saturday";
    if (/\bsunday\b/.test(text)) return "sunday";
    return "";
  }

  function daysAhead(dayName, now) {
    const clock = now instanceof Date ? now : new Date(now || Date.now());
    const weekday = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    let target = weekday[dayName];
    if (target === undefined) return 0;
    const today = clock.getDay();
    if (today === 0) {
      if (target === 0) return 0;
      if (target === 6) return -1;
      if (target === 5) return -2;
      return target;
    }
    if (target === 0) target = 7;
    return target - today;
  }

  function couponKind(name, lane) {
    const text = String(name || "").toLowerCase();
    const entry = lane === "entry" || /\bentry\b/.test(text);
    if (entry) {
      if (/\bfriday\b/.test(text)) return "entry-friday";
      if (/\bsaturday\b/.test(text)) return "entry-saturday";
      if (/\bsunday\b/.test(text)) return "entry-sunday";
      return "entry-other";
    }
    if (/\bsnacks?\b/.test(text)) return "snack";
    if (/\bpaneer\b/.test(text)) return "paneer";
    if (/\bmutton\b/.test(text)) return "mutton";
    if (/\bchicken\b/.test(text)) return "chicken";
    if (/\bfish\b|\bmachh/.test(text)) return "fish";
    if (/non-?veg/.test(text)) return "nonveg";
    if (/\bvegetarian\b|\bveg\b/.test(text)) return "veg";
    return "food-other";
  }

  function entryHue(name) {
    let hash = 0;
    const text = String(name || "").toLowerCase();
    for (let index = 0; index < text.length; index += 1) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
    return 165 + (hash % 115);
  }

  function foreignLock(book, code, holder, at) {
    const lock = book && book.locks && book.locks[code];
    if (!lock || !lock.holder || !holder || lock.holder === holder) return null;
    const age = Date.parse(at) - Date.parse(lock.at || "");
    if (!Number.isFinite(age) || age < 0 || age >= LOCK_MS) return null;
    return lock;
  }

  function acquireLock(book, code, holder, actor, at) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    if (!next.locks) next.locks = {};
    const current = foreignLock(next, code, holder, at);
    if (current) return { book: pruneBook(next), changed: false, locked: true, lock: current };
    const previous = next.locks[code];
    next.locks[code] = { holder, actor, at };
    const changed = !previous || previous.holder !== holder || previous.at !== at;
    return { book: pruneBook(next), changed, locked: false, lock: next.locks[code] };
  }

  function releaseLock(book, code, holder, at) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    if (!next.locks) next.locks = {};
    const lock = next.locks[code];
    if (!lock || lock.holder !== holder) return { book: pruneBook(next), changed: false };
    delete next.locks[code];
    next.releasedLocks = [code];
    next.releasedBy = holder;
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: `${code} lock released` });
    return { book: pruneBook(next), changed: true };
  }

  function releaseAllLocks(book, at) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    next.locks = {};
    next.releaseAllLocks = true;
    next.actor = "siteadmin";
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text: "siteadmin released all locks" });
    return { book: pruneBook(next), changed: true };
  }

  function cleanupAll(book, at) {
    const next = emptyBook();
    if (book && book.sheet) next.sheet = book.sheet;
    next.lines = [`${at} siteadmin cleaned up everything`];
    next.log = [{ at, text: "siteadmin cleaned up everything" }];
    next.cleanupAll = true;
    next.actor = "siteadmin";
    return { book: next, changed: true };
  }

  function markItem(book, person, itemIndex, at, actor, holder, options) {
    if (foreignLock(book, person.code, holder, at)) {
      const current = structuredClone(ready(book) ? book : emptyBook());
      return { book: pruneBook(current), changed: false, locked: true, already: false, phrase: "" };
    }
    const named = person.items && person.items[itemIndex];
    const when = new Date(at);
    const demo = Boolean(options && options.demo);
    if (!demo && named && itemDay(named.name) && daysAhead(itemDay(named.name), when) > 0) {
      const current = structuredClone(ready(book) ? book : emptyBook());
      return { book: pruneBook(current), changed: false, blocked: true, already: false, phrase: "" };
    }
    const next = structuredClone(ready(book) ? book : emptyBook());
    const placed = ensureSheetOrder(next, person, person.full, at, actor);
    const key = Object.keys(placed.order.variants).find((id) => id.startsWith(`item:${itemIndex}:`));
    if (!key) return { book: pruneBook(next), changed: false, already: true, phrase: "" };
    const item = placed.order.variants[key];
    if (item.taken) return { book: pruneBook(next), changed: false, already: true, phrase: sheetPhrase(variantList(placed.order)) };
    item.taken = true;
    item.takenAt = at;
    syncTakenCount(placed.order);
    placed.order.updatedAt = at;
    placed.order.actor = actor || placed.order.actor;
    const text = item.lane === "entry"
      ? `${person.code} entry done: ${item.name}`
      : `${person.code} food picked up: ${item.name}`;
    addLine(next, at, text);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text });
    return { book: pruneBook(next), changed: true, already: false, phrase: sheetPhrase(variantList(placed.order)) };
  }

  function revertLast(book, person, at, actor, holder) {
    if (foreignLock(book, person.code, holder, at)) {
      const current = structuredClone(ready(book) ? book : emptyBook());
      return { book: pruneBook(current), changed: false, locked: true, already: false, phrase: "" };
    }
    const next = structuredClone(ready(book) ? book : emptyBook());
    const order = next.orders[person.code];
    if (!order) return { book: pruneBook(next), changed: false, already: true, phrase: "" };
    let latestKey = "";
    let latestTime = -1;
    for (const [key, item] of Object.entries(order.variants || {})) {
      if (!item.taken) continue;
      const time = Date.parse(item.takenAt || 0);
      if (time >= latestTime) {
        latestTime = time;
        latestKey = key;
      }
    }
    if (!latestKey) return { book: pruneBook(next), changed: false, already: true, phrase: sheetPhrase(variantList(order)) };
    next.revertKey = latestKey;
    const item = order.variants[latestKey];
    item.taken = false;
    item.takenAt = null;
    syncTakenCount(order);
    order.updatedAt = at;
    order.actor = actor || order.actor;
    const text = `${person.code} reverted ${item.name}`;
    addLine(next, at, text);
    if (!Array.isArray(next.log)) next.log = [];
    next.log.push({ at, text });
    return { book: pruneBook(next), changed: true, already: false, phrase: sheetPhrase(variantList(order)) };
  }

  function activityFor(book, code) {
    const needle = new RegExp(`\\b${String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return (book.log || []).filter((item) => item && needle.test(String(item.text)));
  }

  function isSheetOrder(order) {
    const variants = Object.values(order && order.variants || {});
    return variants.length > 0 && variants.every((item) => item && (item.lane === "entry" || item.lane === "food"));
  }

  function cleanSheetBook(book) {
    const next = structuredClone(ready(book) ? book : emptyBook());
    let removed = 0;
    for (const id of Object.keys(next.orders || {})) {
      if (isSheetOrder(next.orders[id])) continue;
      delete next.orders[id];
      removed += 1;
    }
    if (removed) {
      const kept = new Set(Object.keys(next.orders));
      next.lines = (next.lines || []).filter((line) => {
        const match = String(line).match(/order (\d+)/);
        return Boolean(match && kept.has(match[1]));
      });
      next.log = (next.log || []).filter((item) => {
        const match = String(item && item.text).match(/\b(\d{5})\b/);
        return Boolean(match && kept.has(match[1]));
      });
    }
    return { book: pruneBook(next), changed: removed > 0, removed };
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportRows(book, catalogOrders) {
    return Object.values(catalogOrders || {})
      .sort((left, right) => String(right.code).localeCompare(String(left.code)))
      .map((person) => {
        const saved = (book.orders || {})[person.code];
        const items = (person.items || []).map((item, index) => {
          const stored = saved && saved.variants && saved.variants[`item:${index}:${item.name}`];
          return { ...item, taken: Boolean(stored && stored.taken) };
        });
        const pending = items.filter((item) => !item.taken);
        const picked = items.filter((item) => item.taken);
        const seen = Boolean(saved && saved.scannedAt);
        let status = "Not seen";
        if (seen && items.length && pending.length === 0) status = "Taken completely";
        else if (seen && picked.length === 0) status = "Scanned only";
        else if (seen || picked.length) status = "Taken partially";
        const names = (list) => list.map((item) => `${item.name} x ${item.qty}`).join("; ");
        return {
          full: person.full,
          code: person.code,
          name: person.name,
          email: person.email,
          seen: seen ? "Seen" : "Not seen",
          status,
          entryPending: pending.filter((item) => item.lane === "entry").length,
          foodPending: pending.filter((item) => item.lane === "food").length,
          pendingCount: pending.length,
          pendingItems: names(pending),
          pickedItems: names(picked),
          scannedAt: saved && saved.scannedAt ? saved.scannedAt : "",
        };
      });
  }

  function exportCsv(book, catalogOrders) {
    const rows = exportRows(book, catalogOrders);
    const seen = rows.filter((row) => row.seen === "Seen").length;
    const pendingItems = rows.reduce((sum, row) => sum + row.pendingCount, 0);
    const header = ["Order number", "Code", "Name", "Email", "Seen", "Status", "Entry pending", "Food pending", "Pending count", "Pending items", "Picked up items", "Scanned at"];
    const lines = [
      ["Seen", seen],
      ["Not seen", rows.length - seen],
      ["Pending items", pendingItems],
      [],
      header,
      ...rows.map((row) => [row.full, row.code, row.name, row.email, row.seen, row.status, row.entryPending, row.foodPending, row.pendingCount, row.pendingItems, row.pickedItems, row.scannedAt]),
    ];
    return lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
  }

  function summary(book) {
    return Object.values(book.orders || {})
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((order) => ({
        orderId: order.orderId,
        fullNumber: order.fullNumber || order.orderId,
        name: order.name || "",
        email: order.email || "",
        raw: order.raw,
        scannedAt: order.scannedAt,
        updatedAt: order.updatedAt,
        actor: order.actor,
        status: statusOf(order),
        detail: statusDetail(order),
        taken: takenNumbers(order).taken,
        total: takenNumbers(order).total,
        variants: variantList(order),
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
    rememberSheet,
    markLane,
    activityFor,
    cleanSheetBook,
    exportRows,
    exportCsv,
    sheetPhrase,
    markItem,
    revertLast,
    foreignLock,
    acquireLock,
    releaseLock,
    releaseAllLocks,
    cleanupAll,
    LOCK_MS,
    itemDay,
    daysAhead,
    couponKind,
    entryHue,
    markTaken,
    countsOf,
    pruneBook,
    summary,
    commitRemote,
    readRemote,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
