const config = window.TICKET_TRACKER_CONFIG || { publicPageUrl: "" };

function markMobile() {
  const mobile = window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;
  document.documentElement.classList.toggle("is-mobile", mobile);
}
markMobile();
window.addEventListener("resize", markMobile);
const ACCOUNTS = {
  siteadmin: { hash: "4b4d84a924bee4381c8cba1badfe3aa96cd7746ec02e36f862fab18caf42dafc", role: "records" },
  admin: { hash: "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918", role: "scanner" },
};
const SESSION_KEY = "ticket-tracker-session";
const SESSION_MS = 3 * 24 * 60 * 60 * 1000;

const gate = document.querySelector("#gate");
const login = document.querySelector("#login");
const workspace = document.querySelector("#workspace");
const adminScreen = document.querySelector("#admin-screen");
const ticketScreen = document.querySelector("#ticket-screen");
const resultEl = document.querySelector("#result");
const retryButton = document.querySelector("#retry");
const reader = document.querySelector("#reader");
const fileReader = document.querySelector("#file-reader");
const cameraHelp = document.querySelector("#camera-help");
const scanButton = document.querySelector("#scan-btn");
const cancelButton = document.querySelector("#cancel-scan");

let scanLock = false;
let scanGeneration = 0;
let camera = null;
let cameraOn = false;
let lastAttempt = null;
let openedCode = "";
let ticketReturn = null;
let currentBook = TicketLedger.emptyBook();
const pendingWrites = [];
let flushTimer = null;
let flushing = false;
const BATCH_WAIT_MS = 2500;
const BATCH_MAX = 8;

function show(view) {
  gate.hidden = view !== gate;
  login.hidden = view !== login;
  workspace.hidden = view !== workspace;
  adminScreen.hidden = view !== adminScreen;
  if (ticketScreen) ticketScreen.hidden = view !== ticketScreen;
}

function closeTicket() {
  const code = openedCode;
  const who = holderNow();
  if (code) queueWrite((book) => TicketLedger.releaseLock(book, code, who.holder, who.at));
  openedCode = "";
  const body = document.querySelector("#ticket-body");
  if (body) body.replaceChildren();
  show(ticketReturn || workspace);
}

function showGate() {
  stopCamera();
  show(gate);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function readSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!saved || !ACCOUNTS[saved.username] || saved.role !== ACCOUNTS[saved.username].role || typeof saved.exp !== "number" || saved.exp <= Date.now()) return null;
    return saved;
  } catch {
    return null;
  }
}

function enterApp() {
  const session = readSession();
  if (!session) return showGate();
  if (config.recordUrl) {
    document.querySelector("#record-link").closest("label").hidden = true;
    document.querySelector("#save-link").hidden = true;
  }
  if (session.role === "records") {
    document.querySelector("#admin-who").textContent = "Signed in as siteadmin";
    show(adminScreen);
    refreshOrders();
    return;
  }
  document.querySelector("#who").textContent = `Signed in as ${session.username}`;
  show(workspace);
  paintCounter();
  refreshOrders();
}

document.querySelector("#show-login").addEventListener("click", () => {
  document.querySelector("#username").value = "admin";
  show(login);
  document.querySelector("#password").focus();
});

document.querySelector("#show-admin").addEventListener("click", () => {
  document.querySelector("#username").value = "siteadmin";
  show(login);
  document.querySelector("#password").focus();
});

document.querySelector("#login-back").addEventListener("click", showGate);

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#login-error");
  error.hidden = true;
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  const username = document.querySelector("#username").value.trim();
  const password = document.querySelector("#password").value;
  document.querySelector("#password").value = "";
  try {
    const digest = await sha256(password);
    const account = ACCOUNTS[username];
    const accepted = account && sameText(digest, account.hash);
    if (!accepted) {
      error.hidden = false;
      error.textContent = "Incorrect username or password.";
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username, role: account.role, exp: Date.now() + SESSION_MS }));
    enterApp();
  } catch {
    error.hidden = false;
    error.textContent = "Could not save—retry";
  } finally {
    button.disabled = false;
  }
});

function logout() {
  localStorage.removeItem(SESSION_KEY);
  showGate();
}

document.querySelector("#logout").addEventListener("click", logout);
document.querySelector("#admin-logout").addEventListener("click", logout);

function library() {
  if (typeof Html5Qrcode === "function") return Html5Qrcode;
  return window.__Html5QrcodeLibrary__ && window.__Html5QrcodeLibrary__.Html5Qrcode;
}

async function stopCamera() {
  scanButton.hidden = false;
  cancelButton.hidden = true;
  if (!cameraOn || !camera) {
    cameraOn = false;
    reader.hidden = true;
    return;
  }
  cameraOn = false;
  try { await camera.stop(); } catch { /* already stopped */ }
  try { camera.clear(); } catch { /* element already clear */ }
  camera = null;
  reader.hidden = true;
}

async function startCamera() {
  const Scanner = library();
  if (!Scanner) {
    cameraHelp.hidden = false;
    cameraHelp.textContent = "Camera library did not load. Choose a photo of the QR code instead.";
    return;
  }
  if (cameraOn || scanLock) return;
  cameraHelp.hidden = true;
  reader.hidden = false;
  scanButton.hidden = true;
  cancelButton.hidden = false;
  const generation = ++scanGeneration;
  camera = new Scanner("reader", { verbose: false });
  try {
    await camera.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: { width: 240, height: 240 }, aspectRatio: 1 },
      (decoded) => { onDecoded(decoded, generation); },
      () => {},
    );
    cameraOn = true;
  } catch {
    cameraOn = false;
    reader.hidden = true;
    scanButton.hidden = false;
    cancelButton.hidden = true;
    cameraHelp.hidden = false;
    cameraHelp.textContent = "Camera unavailable. Choose a photo of the QR code instead. The photo stays on this phone.";
  }
}

function onDecoded(text, generation) {
  if (scanLock || generation !== scanGeneration) return;
  scanLock = true;
  scanGeneration += 1;
  stopCamera().then(async () => {
    lastAttempt = { raw: text };
    try { await submitAttempt(); } finally { scanLock = false; }
  });
}

document.querySelector("#scan-btn").addEventListener("click", () => { startCamera(); });
document.querySelector("#cancel-scan").addEventListener("click", () => {
  scanGeneration += 1;
  scanLock = false;
  stopCamera();
});

document.querySelector("#file-scan").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file || scanLock) return;
  const Scanner = library();
  if (!Scanner) return;
  scanLock = true;
  await stopCamera();
  const scanner = new Scanner("file-reader", { verbose: false });
  try {
    const text = await scanner.scanFile(file, false);
    try { await scanner.clear(); } catch { /* no preview to clear */ }
    lastAttempt = { raw: text };
    await submitAttempt();
  } catch {
    showMessage("Could not read a QR code from that image.", "invalid");
  } finally {
    scanLock = false;
  }
});

function recordOptions() {
  return {
    recordUrl: config.recordUrl || localStorage.getItem("ticket-tracker-record-url") || "",
    load: TicketRecord.loadWithScript,
    post: TicketRecord.postWithForm,
  };
}

function showMessage(message, kind) {
  resultEl.textContent = message;
  resultEl.className = `result ${kind}`;
  retryButton.hidden = kind !== "save_failed";
}

function queueWrite(mutate) {
  const applied = mutate(currentBook);
  if (applied.book) currentBook = applied.book;
  if (applied.write) pendingWrites.push(mutate);
  if (pendingWrites.length >= BATCH_MAX) flushWrites();
  else if (pendingWrites.length) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushWrites, BATCH_WAIT_MS);
  }
  return applied;
}

async function flushWrites() {
  clearTimeout(flushTimer);
  if (flushing || !pendingWrites.length) return;
  const batch = pendingWrites.splice(0, pendingWrites.length);
  flushing = true;
  const saved = await TicketRecord.commit(recordOptions(), (book) => {
    let working = book;
    let message = "";
    let write = false;
    for (const mutate of batch) {
      const applied = mutate(working);
      if (applied.book) working = applied.book;
      if (applied.write) write = true;
      if (applied.message) message = applied.message;
    }
    working.baseWriteId = book.lastWriteId || "";
    return { write, book: working, message, commitMessage: `Save ${batch.length} updates` };
  });
  flushing = false;
  if (!saved.ok) {
    pendingWrites.unshift(...batch);
    note(saved.message || "Could not save—retry");
    showMessage(saved.message || "Could not save—retry", "save_failed");
    flushTimer = setTimeout(flushWrites, BATCH_WAIT_MS);
    return;
  }
  currentBook = saved.book || currentBook;
  for (const mutate of pendingWrites) {
    const applied = mutate(currentBook);
    if (applied.book) currentBook = applied.book;
  }
  renderOrders();
  if (pendingWrites.length) flushTimer = setTimeout(flushWrites, BATCH_WAIT_MS);
}

function catalogPerson(raw) {
  const catalog = window.TicketCatalog;
  if (!catalog || typeof catalog.lookup !== "function") return null;
  return catalog.lookup(raw);
}

function activeCounter() {
  return localStorage.getItem("ticket-tracker-counter") === "food" ? "food" : "entry";
}

function paintCounter() {
  const food = activeCounter() === "food";
  document.querySelector("#counter-entry").className = food ? "secondary" : "primary";
  document.querySelector("#counter-food").className = food ? "primary" : "secondary";
}

function clockText(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return String(at || "");
  return when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function paintQr(code, box) {
  box = box || document.querySelector("#qr-box");
  if (!box) return;
  box.replaceChildren();
  if (!code || typeof qrcode !== "function") return;
  try {
    const drawing = qrcode(0, "M");
    drawing.addData(String(code));
    drawing.make();
    const view = document.createElement("div");
    view.className = "qr-view";
    view.innerHTML = drawing.createSvgTag(6, 2);
    box.append(view);
  } catch {
    box.replaceChildren();
  }
}

function storedItems(person) {
  const stored = currentBook.orders[person.code];
  if (!stored) return person.items.map((item) => ({ id: item.name, qty: item.qty, lane: item.lane, tone: item.tone, taken: false }));
  const row = TicketLedger.summary({ schemaVersion: 1, lines: [], log: [], orders: { [person.code]: stored } })[0];
  return row ? row.variants : [];
}

function orderView(person) {
  const items = storedItems(person);
  const allTaken = items.length > 0 && items.every((item) => item.taken);
  const noneTaken = items.every((item) => !item.taken);
  return { items, allTaken, noneTaken, phrase: TicketLedger.sheetPhrase(items) || "Not seen" };
}

function deviceId() {
  let id = localStorage.getItem("ticket-tracker-device");
  if (!id) {
    id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("ticket-tracker-device", id);
  }
  return id;
}

function holderNow() {
  return { holder: deviceId(), actor: readSession()?.username || "admin", at: new Date().toISOString() };
}

function markOne(person, index) {
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const applied = queueWrite((book) => {
    const next = TicketLedger.markItem(book, person, index, at, actor, deviceId());
    const message = next.locked
      ? `This line is locked. ${person.name}. ${person.email}.`
      : next.blocked
      ? `Unavailable yet. ${person.name}. ${person.email}.`
      : next.already ? `Already picked up. ${person.name}. ${person.email}.` : `${next.phrase}. ${person.name}. ${person.email}.`;
    return { write: next.changed, book: next.book, message };
  });
  showMessage(applied.message, String(applied.message).startsWith("Already") || String(applied.message).startsWith("Unavailable") ? "already_seen" : "pending");
  paintOpen(person);
  renderOrders();
}

function revertOne(person) {
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const applied = queueWrite((book) => {
    const next = TicketLedger.revertLast(book, person, at, actor, deviceId());
    const message = next.locked
    ? `This line is locked. ${person.name}. ${person.email}.`
    : next.changed ? `Reverted. ${next.phrase}. ${person.name}. ${person.email}.` : `Nothing to revert. ${person.name}. ${person.email}.`;
    return { write: next.changed, book: next.book, message };
  });
  showMessage(applied.message, String(applied.message).startsWith("Nothing") ? "already_seen" : "pending");
  paintOpen(person);
  renderOrders();
}

function tileOrder(items) {
  const foodCounter = activeCounter() === "food";
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const leftFood = left.item.lane === "food" ? 0 : 1;
    const rightFood = right.item.lane === "food" ? 0 : 1;
    if (foodCounter) return leftFood - rightFood;
    return rightFood - leftFood;
  });
}

function itemButtons(person) {
  const view = orderView(person);
  const foodCounter = activeCounter() === "food";
  const now = new Date();
  const who = holderNow();
  const locked = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const list = document.createElement("div");
  list.className = "item-pills";
  for (const { item, index } of tileOrder(view.items)) {
    const button = document.createElement("button");
    button.type = "button";
    const kind = TicketLedger.couponKind(item.id, item.lane);
    const ahead = TicketLedger.daysAhead(TicketLedger.itemDay(item.id), now);
    const future = Boolean(TicketLedger.itemDay(item.id)) && ahead > 0;
    const otherLane = foodCounter ? item.lane !== "food" : item.lane !== "entry";
    const state = item.taken ? "picked" : future ? "not-yet" : otherLane ? "other-lane" : "ready";
    button.className = `item-pill coupon-${kind} ${state}`;
    if (kind === "entry-other" && state === "ready") button.style.background = `hsl(${TicketLedger.entryHue(item.id)} 48% 36%)`;
    const note = item.taken ? "Done" : future ? "Unavailable yet" : otherLane ? "Greyed out" : "";
    button.textContent = note ? `${item.id} x ${item.qty || 1}\n${note}` : `${item.id} x ${item.qty || 1}`;
    if (locked || state !== "ready") button.disabled = true;
    else button.addEventListener("click", () => markOne(person, index));
    list.append(button);
  }
  return list;
}

function itemBoard(person) {
  const wrap = document.createElement("div");
  wrap.append(itemButtons(person));
  const revert = document.createElement("button");
  revert.type = "button";
  revert.className = "secondary";
  revert.textContent = "Revert last";
  const who = holderNow();
  if (TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at)) revert.disabled = true;
  revert.addEventListener("click", () => revertOne(person));
  wrap.append(revert);
  return wrap;
}

function paintOpen(person) {
  if (ticketScreen && ticketScreen.hidden) ticketReturn = adminScreen.hidden ? workspace : adminScreen;
  openedCode = person.code;
  const who = holderNow();
  const locked = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const mine = currentBook.locks && currentBook.locks[person.code];
  const mineFresh = mine && mine.holder === who.holder && Date.parse(who.at) - Date.parse(mine.at || 0) < 60000;
  if (!locked && !mineFresh) {
    queueWrite((book) => TicketLedger.acquireLock(book, person.code, who.holder, who.actor, who.at));
  }
  if (ticketScreen) show(ticketScreen);
  paintQr(person.code);
  const seen = Boolean(currentBook.orders[person.code] && currentBook.orders[person.code].scannedAt);
  const search = document.querySelector("#search-result");
  if (search) {
    search.textContent = `${seen ? "Already seen" : "Not seen yet"}. ${person.name}. ${person.email}.`;
    search.className = seen ? "result already_seen" : "result pending";
  }
  const host = document.querySelector("#ticket-body");
  host.replaceChildren();
  const view = orderView(person);
  const card = document.createElement("article");
  const qrHost = document.createElement("div");
  paintQr(person.code, qrHost);
  card.append(qrHost);
  card.className = `card ${view.allTaken ? "complete" : view.noneTaken ? "untaken" : "partial"}`;
  const title = document.createElement("p");
  title.textContent = `${person.name} · ${person.full}`;
  const mail = document.createElement("p");
  mail.textContent = person.email;
  const eventLine = document.createElement("p");
  eventLine.textContent = `${person.event} · ${person.date} · ${person.amount}`;
  const activity = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = "This order";
  activity.append(heading);
  const logs = TicketLedger.activityFor(currentBook, person.code);
  if (!logs.length) {
    const empty = document.createElement("p");
    empty.textContent = "No activity for this order yet.";
    activity.append(empty);
  } else {
    for (const item of [...logs].reverse()) {
      const line = document.createElement("p");
      line.textContent = `${clockText(item.at)} — ${item.text}`;
      activity.append(line);
    }
  }
  const phrase = document.createElement("p");
  phrase.textContent = locked
    ? `This line is locked by ${locked.actor}. ${orderView(person).phrase}`
    : orderView(person).phrase;
  card.append(title, mail, eventLine, phrase, itemBoard(person), activity);
  host.append(card);
}

function runLane(person, lane) {
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const applied = queueWrite((book) => {
    const next = TicketLedger.markLane(book, person, person.full, lane, at, actor);
    const message = lane === "entry"
      ? (next.already ? `Already checked in. ${person.name}. ${person.email}.` : `Checked in. ${person.name}. ${person.email}.`)
      : (next.already ? `Food already picked up. ${person.name}. ${person.email}.` : `Food picked up. ${person.name}. ${person.email}.`);
    return { write: next.changed, book: next.book, message };
  });
  const already = String(applied.message || "").startsWith("Already") || String(applied.message || "").startsWith("Food already");
  showMessage(applied.message, already ? "already_seen" : "pending");
  paintOpen(person);
  renderOrders();
}

function searchOrder() {
  const raw = document.querySelector("#order-query").value.trim();
  const person = catalogPerson(raw);
  const search = document.querySelector("#search-result");
  if (!person) {
    openedCode = "";
    document.querySelector("#qr-box").replaceChildren();
    const openOrder = document.querySelector("#open-order");
    if (openOrder) openOrder.replaceChildren();
    search.textContent = "That order number is not on the sheet.";
    search.className = "result invalid";
    return;
  }
  paintOpen(person);
}

function submitAttempt() {
  if (!lastAttempt) return;
  const person = catalogPerson(lastAttempt.raw);
  if (person) {
    const at = new Date().toISOString();
    const actor = readSession()?.username || "admin";
    const applied = queueWrite((book) => {
      const next = TicketLedger.rememberSheet(book, person, lastAttempt.raw, at, actor, activeCounter());
      const message = next.already
        ? `Already seen. ${person.name}. ${person.email}.`
        : `${person.name}. ${person.email}.`;
      return { write: next.changed, book: next.book, message };
    });
    showMessage(applied.message, String(applied.message).startsWith("Already") ? "already_seen" : "pending");
    paintOpen(person);
    renderOrders();
    return;
  }
  showMessage(/order-\d+|UTT\d+|^\d{5}$/i.test(lastAttempt.raw.trim()) ? "That order number is not on the sheet." : "Invalid QR", "invalid");
}

retryButton.addEventListener("click", () => { flushWrites(); });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    flushWrites();
  }
});
window.addEventListener("pagehide", () => {
  stopCamera();
  flushWrites();
});

function note(text) {
  const items = readNotes();
  items.push({ at: new Date().toISOString(), text });
  const kept = items.slice(-200);
  localStorage.setItem("ticket-tracker-local-log", JSON.stringify(kept));
  renderLog();
}

function readNotes() {
  try {
    const items = JSON.parse(localStorage.getItem("ticket-tracker-local-log") || "[]");
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function renderLog() {
  const boxes = [document.querySelector("#activity-log"), document.querySelector("#site-log")].filter(Boolean);
  const rows = [...(currentBook.log || []), ...readNotes()]
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
    .slice(0, 30);
  for (const box of boxes) {
    box.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "No log entries yet.";
      box.append(empty);
      continue;
    }
    for (const item of rows) {
      const line = document.createElement("p");
      const when = new Date(item.at);
      const clock = Number.isNaN(when.getTime()) ? item.at : when.toLocaleString();
      line.textContent = `${clock} — ${item.text}`;
      box.append(line);
    }
  }
}

function laneBreakdown(people) {
  let entryDone = 0;
  let foodNotTaken = 0;
  let complete = 0;
  for (const person of people) {
    const view = orderView(person);
    const entry = view.items.filter((item) => item.lane === "entry");
    const food = view.items.filter((item) => item.lane === "food");
    if (entry.length && entry.every((item) => item.taken)) entryDone += 1;
    if (food.some((item) => !item.taken)) foodNotTaken += 1;
    if (view.allTaken) complete += 1;
  }
  return { entryDone, foodNotTaken, complete };
}

function listedPeople(filter) {
  const catalog = (window.TicketCatalog && window.TicketCatalog.orders) || {};
  const query = filter.trim().toLowerCase();
  if (query) {
    return Object.values(catalog).filter((person) => `${person.name} ${person.email} ${person.full} ${person.code}`.toLowerCase().includes(query));
  }
  return Object.keys(currentBook.orders || {}).map((code) => catalog[code]).filter(Boolean);
}

function fillCount(id, value) {
  const node = document.querySelector(id);
  if (node) node.textContent = String(value);
}

function fillVariantCounts(elementId) {
  const variantList = document.querySelector(elementId);
  if (!variantList) return;
  variantList.replaceChildren();
}

function renderOrders() {
  const scanned = listedPeople("");
  const breakdown = laneBreakdown(scanned);
  const breakdownText = `(${breakdown.entryDone} entry done) (${breakdown.foodNotTaken} food not taken) (${breakdown.complete} taken completely)`;
  fillCount("#people-count", scanned.length);
  fillCount("#site-people-count", scanned.length);
  fillCount("#item-count", breakdown.entryDone);
  fillCount("#site-item-count", breakdown.entryDone);
  fillVariantCounts("#variant-counts");
  fillVariantCounts("#site-variant-counts");
  const heading = document.querySelector("#order-heading");
  const siteHeading = document.querySelector("#site-order-heading");
  const orderBreakdown = document.querySelector("#order-breakdown");
  const siteBreakdown = document.querySelector("#site-order-breakdown");
  if (heading) heading.textContent = `Orders (${scanned.length})`;
  if (siteHeading) siteHeading.textContent = `Orders (${scanned.length})`;
  if (orderBreakdown) orderBreakdown.textContent = breakdownText;
  if (siteBreakdown) siteBreakdown.textContent = breakdownText;
  const orders = document.querySelector("#orders");
  const filter = document.querySelector("#orders-search");
  const people = listedPeople(filter ? filter.value : "");
  orders.replaceChildren();
  if (!people.length) {
    const empty = document.createElement("p");
    empty.textContent = filter && filter.value.trim() ? "No matching orders." : "No orders scanned yet.";
    orders.append(empty);
  } else {
    for (const person of people) orders.append(orderCard(person));
  }
  if (openedCode) {
    const person = catalogPerson(openedCode);
    if (person) paintOpen(person);
  }
  renderLog();
  renderRecent();
}

function variantLine(variants) {
  const list = document.createElement("p");
  list.className = "variant-list";
  variants.forEach((variant, index) => {
    if (index > 0) list.append(", ");
    const part = document.createElement("span");
    part.textContent = variant.id;
    if (variant.taken) part.className = "taken-variant";
    list.append(part);
  });
  return list;
}

function orderCard(person, options = {}) {
  const view = orderView(person);
  const seen = Boolean(currentBook.orders[person.code] && currentBook.orders[person.code].scannedAt);
  const card = document.createElement("article");
  card.className = `card ${view.allTaken ? "complete" : view.noneTaken ? "untaken" : "partial"}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondary order-toggle";
  toggle.textContent = `${person.name} ${person.code} — ${seen ? view.phrase : "Not seen"}`;
  const box = document.createElement("div");
  box.hidden = true;
  const mail = document.createElement("p");
  mail.textContent = `${person.email}. ${person.full}.`;
  const status = document.createElement("p");
  status.textContent = seen ? view.phrase : `Not seen yet. ${view.phrase}`;
  box.append(mail, status, itemBoard(person));
  if (options.delete) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Delete";
    button.addEventListener("click", () => deleteRecent(person.code));
    box.append(button);
  }
  toggle.addEventListener("click", () => {
    box.hidden = !box.hidden;
    paintOpen(person);
  });
  card.append(toggle, box);
  return card;
}

function renderRecent() {
  const recent = document.querySelector("#recent-orders");
  if (!recent) return;
  recent.replaceChildren();
  const filter = document.querySelector("#site-orders-search");
  const people = listedPeople(filter ? filter.value : "").slice(0, 40);
  if (!people.length) {
    const empty = document.createElement("p");
    empty.textContent = filter && filter.value.trim() ? "No matching orders." : "No recent scans.";
    recent.append(empty);
    return;
  }
  for (const person of people) recent.append(orderCard(person, { delete: true }));
}

function saveTaken(orderId, rawCount) {
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const applied = queueWrite((book) => {
    const next = TicketLedger.setTakenCount(book, orderId, rawCount, at, actor);
    const order = next.book.orders[orderId];
    return {
      write: next.changed,
      book: next.book,
      message: order ? TicketLedger.statusDetail(order) : "Could not save—retry",
    };
  });
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = applied.message || "Could not save—retry";
  renderOrders();
}

function deleteRecent(orderId) {
  const at = new Date().toISOString();
  const applied = queueWrite((book) => {
    const next = TicketLedger.deleteOrder(book, orderId, at, "siteadmin");
    return {
      write: next.changed,
      book: next.book,
      message: next.changed ? `Order ${orderId} deleted` : `Order ${orderId} was already removed`,
    };
  });
  const message = document.querySelector("#admin-note");
  message.hidden = false;
  message.textContent = applied.message;
  renderOrders();
}

async function refreshOrders() {
  if (pendingWrites.length) await flushWrites();
  const options = recordOptions();
  if (!TicketRecord.recordUrl(options.recordUrl)) return;
  const loaded = await TicketRecord.commit(options, (book) => ({
    write: false,
    book,
    message: "",
    commitMessage: "",
  }));
  if (!loaded.ok) {
    const message = document.querySelector("#admin-message");
    message.hidden = false;
    message.textContent = loaded.message || "Could not save—retry";
    note(message.textContent);
    return;
  }
  currentBook = loaded.book;
  const preview = TicketLedger.cleanSheetBook(loaded.book);
  if (preview.changed) {
    queueWrite((book) => {
      const next = TicketLedger.cleanSheetBook(book);
      return { write: next.changed, book: next.book, message: "Cleaned old scans" };
    });
  }
  renderOrders();
}

function exportStatus() {
  const catalog = window.TicketCatalog && window.TicketCatalog.orders;
  const csv = TicketLedger.exportCsv(currentBook, catalog || {});
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ticket-status-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector("#save-link").addEventListener("click", () => {
  const value = document.querySelector("#record-link").value.trim();
  const link = TicketRecord.recordUrl(value);
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  if (!link) {
    message.textContent = value.indexOf("drive.google.com") >= 0
      ? "That Drive folder is the storage place. Paste the web app link that ends in /exec."
      : "Use the Google web app link ending in /exec.";
    return;
  }
  localStorage.setItem("ticket-tracker-record-url", link);
  document.querySelector("#record-link").value = "";
  message.textContent = "Record link saved on this phone.";
  refreshOrders();
});

function toggleBox(button, boxId, closedLabel) {
  const box = document.querySelector(boxId);
  box.hidden = !box.hidden;
  button.textContent = box.hidden ? closedLabel : "Hide totals";
}

document.querySelector("#show-totals").addEventListener("click", (event) => {
  toggleBox(event.currentTarget, "#count-body", "Show totals");
});
document.querySelector("#show-site-totals").addEventListener("click", (event) => {
  toggleBox(event.currentTarget, "#site-count-body", "Show totals");
});

document.querySelector("#counter-entry").addEventListener("click", () => {
  localStorage.setItem("ticket-tracker-counter", "entry");
  paintCounter();
  renderOrders();
});
document.querySelector("#counter-food").addEventListener("click", () => {
  localStorage.setItem("ticket-tracker-counter", "food");
  paintCounter();
  renderOrders();
});
document.querySelector("#orders-search").addEventListener("input", () => { renderOrders(); });
document.querySelector("#site-orders-search").addEventListener("input", () => { renderOrders(); });
document.querySelector("#main-page").addEventListener("click", closeTicket);
document.querySelector("#search-order").addEventListener("click", searchOrder);
document.querySelector("#order-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchOrder();
});
document.querySelector("#refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#admin-refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#export-csv").addEventListener("click", exportStatus);
document.querySelector("#admin-export-csv").addEventListener("click", exportStatus);
document.querySelector("#release-locks").addEventListener("click", () => {
  if (!window.confirm("Release every line lock?")) return;
  const at = new Date().toISOString();
  const applied = queueWrite((book) => TicketLedger.releaseAllLocks(book, at));
  const noteBox = document.querySelector("#admin-note");
  noteBox.hidden = false;
  noteBox.textContent = applied.write ? "All locks released." : "There were no locks.";
  renderOrders();
});
document.querySelector("#cleanup-all").addEventListener("click", () => {
  if (!window.confirm("Clean up everything? This clears every scan, lock, and log.")) return;
  const at = new Date().toISOString();
  queueWrite((book) => TicketLedger.cleanupAll(book, at));
  openedCode = "";
  const noteBox = document.querySelector("#admin-note");
  noteBox.hidden = false;
  noteBox.textContent = "Cleanup sent. The status file will be empty after it saves.";
  renderOrders();
});

setInterval(() => {
  if (document.hidden || !readSession() || flushing || pendingWrites.length) return;
  refreshOrders();
}, 20000);

show(gate);
if (readSession()) enterApp();
