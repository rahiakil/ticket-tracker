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
const ALIAS_KEY = "ticket-tracker-alias";
const SESSION_MS = 3 * 24 * 60 * 60 * 1000;

const gate = document.querySelector("#gate");
const login = document.querySelector("#login");
const workspace = document.querySelector("#workspace");
const adminScreen = document.querySelector("#admin-screen");
const ticketScreen = document.querySelector("#ticket-screen");
const saleScreen = document.querySelector("#sale-screen");
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
  if (saleScreen) saleScreen.hidden = view !== saleScreen;
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

function readAlias() {
  return sessionStorage.getItem(ALIAS_KEY) || "";
}

function enterApp() {
  const session = readSession();
  if (!session) return showGate();
  if (!readAlias()) {
    document.querySelector("#username").value = session.username;
    document.querySelector("#login-error").hidden = false;
    document.querySelector("#login-error").textContent = "Enter your name for this visit. It is not saved on the account.";
    show(login);
    document.querySelector("#display-name").focus();
    return;
  }
  if (config.recordUrl) {
    document.querySelector("#record-link").closest("label").hidden = true;
    document.querySelector("#save-link").hidden = true;
  }
  if (session.role === "records") {
    document.querySelector("#admin-who").textContent = `Signed in as ${readAlias()} (siteadmin)`;
    show(adminScreen);
    refreshOrders();
    return;
  }
  document.querySelector("#who").textContent = `Signed in as ${readAlias()} (${session.username})`;
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
  const displayName = document.querySelector("#display-name").value.trim();
  document.querySelector("#password").value = "";
  document.querySelector("#display-name").value = "";
  if (!displayName) {
    error.hidden = false;
    error.textContent = "Enter your name for this visit. It is not saved on the account.";
    button.disabled = false;
    return;
  }
  try {
    const digest = password ? await sha256(password) : "";
    const account = ACCOUNTS[username];
    const current = readSession();
    const accepted = account && password && sameText(digest, account.hash);
    const sameVisit = current && current.username === username && !password;
    if (!accepted && !sameVisit) {
      error.hidden = false;
      error.textContent = "Incorrect username or password.";
      return;
    }
    if (accepted) localStorage.setItem(SESSION_KEY, JSON.stringify({ username, role: account.role, exp: Date.now() + SESSION_MS }));
    sessionStorage.setItem(ALIAS_KEY, displayName);
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
  sessionStorage.removeItem(ALIAS_KEY);
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
    if (write) {
      working.statusGrid = statusGrid(working);
      working.onSiteGrid = onSiteGrid(working);
      working.statsGrid = statsGrid();
    }
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

function catalogSource() {
  const fromBook = currentBook.sheet && currentBook.sheet.orders;
  if (fromBook && Object.keys(fromBook).length) return fromBook;
  try {
    const saved = JSON.parse(localStorage.getItem("ticket-tracker-sheet") || "null");
    if (saved && saved.orders && Object.keys(saved.orders).length) return saved.orders;
  } catch {
    /* use the built-in sheet */
  }
  return (window.TicketCatalog && window.TicketCatalog.orders) || {};
}

function activeOrders() {
  return { ...catalogSource(), ...(currentBook.walkups || {}) };
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function looksLikeCode(value) {
  const text = String(value || "").trim();
  return /UTT\d+/i.test(text) || /order-\d+/i.test(text) || /^walk\d+$/i.test(text) || /^\d{5}$/.test(text);
}

function catalogMatches(raw) {
  if (looksLikeCode(raw)) {
    const exact = catalogPerson(raw);
    return exact ? [exact] : [];
  }
  const tokens = normalized(raw).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  return Object.values(activeOrders()).filter((person) => {
    const hay = normalized(`${person.name} ${person.email} ${person.full} ${person.code}`);
    return tokens.every((token) => hay.includes(token));
  });
}

function catalogPerson(raw) {
  const orders = activeOrders();
  const text = String(raw || "").trim();
  const orderCode = text.match(/order-(\d+)/i);
  if (orderCode) return orders[orderCode[1].slice(-5)] || null;
  const utt = text.match(/UTT(\d{8,})/i);
  if (utt) return orders[utt[1].slice(-5)] || null;
  if (/^\d{5}$/.test(text)) return orders[text] || null;
  const tail = text.match(/(\d{5})\s*$/);
  if (tail && text.length <= 80) return orders[tail[1]] || null;
  return null;
}

function activeCounter() {
  return localStorage.getItem("ticket-tracker-counter") === "food" ? "food" : "entry";
}

function paintCounter() {
  const food = activeCounter() === "food";
  document.querySelector("#counter-entry").className = food ? "btn-quiet" : "btn-teal";
  document.querySelector("#counter-food").className = food ? "btn-orange" : "btn-quiet";
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
  const variants = TicketLedger.expandVariants(person, stored && stored.variants ? stored.variants : {});
  return Object.values(variantEntries(variants));
}

function variantEntries(variants) {
  return Object.keys(variants).sort((left, right) => {
    const leftParts = String(left).split(":");
    const rightParts = String(right).split(":");
    const byIndex = Number(leftParts[1]) - Number(rightParts[1]);
    if (byIndex) return byIndex;
    return Number(leftParts[2]) - Number(rightParts[2]);
  }).map((id) => ({
    id: variants[id].name || id,
    index: Number(String(id).split(":")[1]) || 0,
    unit: Number(variants[id].unit) || 0,
    parts: variants[id].parts || 1,
    qty: 1,
    lane: variants[id].lane || "",
    tone: variants[id].tone || "",
    taken: Boolean(variants[id].taken),
    takenBy: variants[id].takenBy || "",
  }));
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
  const session = readSession();
  return { holder: deviceId(), actor: readAlias() || (session && session.username) || "admin", at: new Date().toISOString() };
}

let demoMode = false;

function paintDemo() {
  for (const button of document.querySelectorAll(".demo-toggle")) {
    button.textContent = demoMode ? "Demo on" : "Demo";
    button.className = demoMode ? "demo-toggle btn-teal" : "demo-toggle btn-orange";
  }
}

function markOne(person, index, unit) {
  const at = new Date().toISOString();
  const actor = holderNow().actor;
  const applied = queueWrite((book) => {
    const next = TicketLedger.markItem(book, person, index, at, actor, deviceId(), { demo: demoMode, unit });
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

function sendDispute(person, itemName) {
  const note = window.prompt("Send this to the dispute bucket. What should the admin check?", "Needs a check");
  if (note === null) return;
  const at = new Date().toISOString();
  const actor = holderNow().actor;
  queueWrite((book) => {
    const next = TicketLedger.addDispute(book, person, itemName, at, actor, note.trim() || "Needs a check");
    return { write: next.changed, book: next.book, message: next.already ? "Already in the dispute bucket." : "Sent to the dispute bucket." };
  });
  showMessage("Sent to the dispute bucket.", "pending");
  renderOrders();
}

function revertOne(person) {
  const at = new Date().toISOString();
  const actor = holderNow().actor;
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

function dayBucket(name) {
  return TicketLedger.itemDay(name) || "other";
}

function itemButtons(person) {
  const view = orderView(person);
  const now = new Date();
  const who = holderNow();
  const locked = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const desk = activeCounter();
  const groups = [
    ["Friday entry", "friday", "entry"],
    ["Friday food", "friday", "food"],
    ["Saturday entry", "saturday", "entry"],
    ["Saturday food", "saturday", "food"],
    ["Sunday entry", "sunday", "entry"],
    ["Sunday food", "sunday", "food"],
    ["Other entry", "other", "entry"],
    ["Other food", "other", "food"],
  ].filter((group) => group[2] === desk);
  const board = document.createElement("div");
  for (const [label, bucket, lane] of groups) {
    const rows = view.items.map((item, index) => ({ item, index })).filter(({ item }) => dayBucket(item.id) === bucket && (item.lane || "food") === lane).sort((left, right) => Number(left.item.taken) - Number(right.item.taken));
    if (!rows.length) continue;
    const heading = document.createElement("p");
    heading.className = "day-heading";
    heading.textContent = label;
    const list = document.createElement("div");
    list.className = "item-pills";
    for (const { item, index } of rows) {
      const button = document.createElement("button");
      button.type = "button";
      const kind = TicketLedger.couponKind(item.id, item.lane);
      const ahead = TicketLedger.daysAhead(TicketLedger.itemDay(item.id), now);
      const future = !demoMode && Boolean(TicketLedger.itemDay(item.id)) && ahead > 0;
      const state = item.taken ? (demoMode ? "semi" : "picked") : future ? "not-yet" : "ready";
      button.className = `item-pill coupon-${kind} ${state}`;
      if (kind.startsWith("entry-any") && (state === "ready" || state === "semi")) button.style.background = `hsl(${TicketLedger.entryHue(item.id)} 42% 36%)`;
      const icons = { fish: "🐟", chicken: "🍗", mutton: "🐑", veg: "🥦", paneer: "🥦" };
      const icon = icons[kind] || (String(kind).startsWith("entry") ? "🚪" : "");
      const note = item.taken ? (item.takenBy ? `Done · ${item.takenBy}` : "Done") : future ? "Unavailable yet" : "";
      const label = item.parts > 1 ? `${item.id} (${item.unit + 1} of ${item.parts})` : item.id;
      button.textContent = [icon, label, note].filter(Boolean).join("\n");
      if (locked) button.disabled = true;
      else {
        let holdTimer = 0;
        let held = false;
        button.addEventListener("pointerdown", () => {
          held = false;
          holdTimer = window.setTimeout(() => {
            held = true;
            sendDispute(person, `${item.id}${item.parts > 1 ? ` ${item.unit + 1} of ${item.parts}` : ""}`);
          }, 650);
        });
        button.addEventListener("pointerup", () => window.clearTimeout(holdTimer));
        button.addEventListener("pointerleave", () => window.clearTimeout(holdTimer));
        button.addEventListener("pointercancel", () => window.clearTimeout(holdTimer));
        button.addEventListener("click", () => {
          if (held) { held = false; return; }
          if (state === "ready") markOne(person, item.index, item.unit);
        });
      }
      list.append(button);
    }
    board.append(heading, list);
  }
  return board;
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

function ordersForPerson(person) {
  const email = String(person.email || "").trim().toLowerCase();
  const orders = Object.values(activeOrders());
  const matches = orders.filter((item) => email ? String(item.email || "").trim().toLowerCase() === email : item.name === person.name);
  return matches.length ? matches : [person];
}

function paintOpen(person, options) {
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
  activity.className = "log-scroll";
  const heading = document.createElement("p");
  const allActivity = Boolean(options && options.allActivity);
  const related = allActivity ? ordersForPerson(person) : [person];
  heading.textContent = allActivity ? `All activity for ${person.name}` : "This order, one by one";
  activity.append(heading);
  const logs = related
    .flatMap((item) => TicketLedger.activityFor(currentBook, item.code))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  if (!logs.length) {
    const empty = document.createElement("p");
    empty.textContent = "No activity for this order yet.";
    activity.append(empty);
  } else {
    for (const item of logs) {
      const line = document.createElement("p");
      line.textContent = logLine(item, person);
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
  const actor = holderNow().actor;
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
  const matches = catalogMatches(raw);
  const search = document.querySelector("#search-result");
  const list = document.querySelector("#name-matches");
  if (list) list.replaceChildren();
  if (!matches.length) {
    openedCode = "";
    document.querySelector("#qr-box").replaceChildren();
    search.textContent = "No order or name matched.";
    search.className = "result invalid";
    return;
  }
  if (matches.length === 1) {
    paintOpen(matches[0]);
    return;
  }
  search.textContent = `${matches.length} names. Pick one.`;
  search.className = "result pending";
  for (const person of matches.slice(0, 20)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = `${person.name} · ${person.code} · ${person.email}`;
    button.addEventListener("click", () => paintOpen(person));
    if (list) list.append(button);
  }
}

function submitAttempt() {
  if (!lastAttempt) return;
  const person = catalogPerson(lastAttempt.raw);
  if (person) {
    const at = new Date().toISOString();
    const actor = holderNow().actor;
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

function personForLog(text) {
  const match = String(text || "").match(/\b(\d{5})\b/);
  if (!match) return null;
  return activeOrders()[match[1]] || null;
}

function logLine(item, person) {
  const when = new Date(item.at);
  const clock = Number.isNaN(when.getTime()) ? item.at : when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const who = person || personForLog(item.text);
  const name = who ? `${who.name} · ${who.code}` : "";
  return name ? `${clock} — ${name} — ${item.text}` : `${clock} — ${item.text}`;
}

function logMatches(item, query) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const person = personForLog(item.text);
  const hay = [item.text, person && person.name, person && person.email, person && person.full, person && person.code].join(" ").toLowerCase();
  return hay.includes(text);
}

function renderLog() {
  const boxes = [
    ["#activity-log", "#log-search"],
    ["#site-log", "#site-log-search"],
  ];
  const rows = [...(currentBook.log || []), ...readNotes()]
    .sort((left, right) => String(right.at).localeCompare(String(left.at)));
  for (const [boxId, inputId] of boxes) {
    const box = document.querySelector(boxId);
    if (!box) continue;
    const input = document.querySelector(inputId);
    const query = input ? input.value : "";
    const shown = rows.filter((item) => logMatches(item, query)).slice(0, 400);
    box.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.textContent = query.trim() ? "No matching log lines." : "No log entries yet.";
      box.append(empty);
      continue;
    }
    for (const item of shown) {
      const line = document.createElement("p");
      line.textContent = logLine(item);
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

let flowTab = "waiting";

function wasScanned(person) {
  const saved = currentBook.orders[person.code];
  return Boolean(saved && saved.scannedAt);
}

function listedPeople(filter, tab) {
  const tokens = normalized(filter).split(" ").filter(Boolean);
  const people = Object.values(activeOrders()).filter((person) => {
    if (!tokens.length) return tab === "scanned" ? wasScanned(person) : !wasScanned(person);
    const hay = normalized(`${person.name} ${person.email} ${person.full} ${person.code}`);
    return tokens.every((token) => hay.includes(token));
  });
  return people.sort((left, right) => left.name.localeCompare(right.name));
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

function paintFlowTabs() {
  const everyone = Object.values(activeOrders());
  const waiting = everyone.filter((person) => !wasScanned(person)).length;
  const scanned = everyone.filter((person) => wasScanned(person)).length;
  document.querySelectorAll("[data-flow]").forEach((button) => {
    const tab = button.getAttribute("data-flow");
    button.className = flowTab === tab ? "btn-teal" : "btn-quiet";
    button.textContent = tab === "scanned" ? `Already scanned (${scanned})` : `Not scanned (${waiting})`;
  });
}

function renderOrders() {
  paintFlowTabs();
  const scanned = listedPeople("", "scanned");
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
  const title = flowTab === "scanned" ? "Already scanned" : "Not scanned";
  if (orderBreakdown) orderBreakdown.textContent = breakdownText;
  if (siteBreakdown) siteBreakdown.textContent = breakdownText;
  const orders = document.querySelector("#orders");
  const filter = document.querySelector("#orders-search");
  const siteFilter = document.querySelector("#site-orders-search");
  const people = listedPeople(filter ? filter.value : "", flowTab);
  const sitePeople = listedPeople(siteFilter ? siteFilter.value : "", flowTab);
  if (heading) heading.textContent = `${title} (${people.length})`;
  if (siteHeading) siteHeading.textContent = `${title} (${sitePeople.length})`;
  orders.replaceChildren();
  if (!people.length) {
    const empty = document.createElement("p");
    empty.textContent = filter && filter.value.trim() ? "No matching names." : flowTab === "scanned" ? "No one scanned yet." : "Everyone here is already scanned.";
    orders.append(empty);
  } else {
    for (const person of people) orders.append(orderCard(person));
  }
  if (openedCode && ticketScreen && !ticketScreen.hidden) {
    const person = catalogPerson(openedCode);
    if (person) paintOpen(person);
  }
  renderLog();
  renderRecent();
  renderLiveSheet();
  renderDisputes();
  renderStats();
}

function renderDisputes() {
  const box = document.querySelector("#disputes");
  if (!box) return;
  box.replaceChildren();
  const rows = (currentBook.disputes || []).filter((item) => item.open);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No open disputes.";
    box.append(empty);
    return;
  }
  for (const item of rows) {
    const line = document.createElement("p");
    line.textContent = `${item.name} · ${item.code} · ${item.item} · ${item.note} · ${item.by}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Clear dispute";
    button.addEventListener("click", () => {
      const at = new Date().toISOString();
      queueWrite((book) => {
        const next = TicketLedger.clearDispute(book, item.key, at, holderNow().actor);
        return { write: next.changed, book: next.book, message: "Dispute cleared." };
      });
      renderOrders();
    });
    box.append(line, button);
  }
}

let cart = [];

function menuItems() {
  const names = new Map();
  Object.values(catalogSource()).forEach((person) => {
    (person.items || []).forEach((item) => {
      if (!names.has(item.name)) names.set(item.name, { name: item.name, lane: item.lane || "entry", tone: item.tone || "" });
    });
  });
  return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function openSale() {
  cart = [];
  const select = document.querySelector("#sale-item");
  select.replaceChildren();
  menuItems().forEach((item) => {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.name;
    option.dataset.lane = item.lane;
    select.append(option);
  });
  document.querySelector("#sale-name").value = "";
  document.querySelector("#sale-email").value = "";
  paintCart();
  show(saleScreen);
}

function paintCart() {
  const box = document.querySelector("#sale-cart");
  box.replaceChildren();
  if (!cart.length) {
    const empty = document.createElement("p");
    empty.textContent = "Cart is empty.";
    box.append(empty);
    return;
  }
  cart.forEach((item, index) => {
    const line = document.createElement("p");
    line.textContent = `${item.name} x ${item.qty}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => { cart.splice(index, 1); paintCart(); });
    box.append(line, remove);
  });
}

function nextWalkCode() {
  const used = new Set(Object.keys(activeOrders()));
  let code = 90001;
  while (used.has(String(code))) code += 1;
  return String(code);
}

function submitSale() {
  const name = document.querySelector("#sale-name").value.trim();
  const email = document.querySelector("#sale-email").value.trim();
  const note = document.querySelector("#sale-note");
  if (!name || !cart.length) {
    note.textContent = "Add a name and at least one item.";
    return;
  }
  const code = nextWalkCode();
  const person = {
    code,
    full: `WALK${code}`,
    name,
    email,
    event: "On site",
    date: new Date().toLocaleDateString(),
    amount: "",
    items: cart.map((item) => ({ name: item.name, qty: item.qty, lane: item.lane, tone: item.lane === "entry" ? "entry" : "food" })),
  };
  const at = new Date().toISOString();
  queueWrite((book) => {
    const next = TicketLedger.addWalkup(book, person, at, holderNow().actor);
    return { write: next.changed, book: next.book, message: `Order ${code} created.` };
  });
  cart = [];
  note.textContent = `Order ${code} is ready to share.`;
  paintOpen(person);
}

function receiptText(person) {
  const view = orderView(person);
  const lines = [`Uttoron ${person.full}`, person.name, person.email || "", ...view.items.map((item) => `${item.taken ? "DONE" : "OPEN"} ${item.parts > 1 ? `${item.id} ${item.unit + 1}/${item.parts}` : item.id}`)];
  return lines.filter(Boolean).join("\n");
}

function printTicket() {
  const person = catalogPerson(openedCode);
  if (!person) return;
  document.body.dataset.print = "ticket";
  window.print();
  delete document.body.dataset.print;
}

async function bluetoothPrint() {
  const person = catalogPerson(openedCode);
  if (!person) return;
  if (!navigator.bluetooth) {
    showMessage("This browser cannot open Bluetooth. Use Print, and pick a paired Bluetooth printer there.", "invalid");
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["0000ffe0-0000-1000-8000-00805f9b34fb", "49535343-fe7d-4ae5-8fa9-9fafd205e455"],
    });
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    let writer = null;
    for (const service of services) {
      const characteristics = await service.getCharacteristics();
      writer = characteristics.find((item) => item.properties.write || item.properties.writeWithoutResponse);
      if (writer) break;
    }
    if (!writer) {
      showMessage("The Bluetooth device did not accept a print. Use Print instead.", "invalid");
      return;
    }
    const bytes = new TextEncoder().encode(`${receiptText(person)}\n\n`);
    await writer.writeValue(bytes);
    showMessage(`Sent the receipt to ${device.name || "the printer"}.`, "pending");
  } catch (error) {
    if (error && error.name === "NotFoundError") return;
    showMessage("Bluetooth print did not connect. Use Print, and pick a paired printer.", "invalid");
  }
}

function qrSvg() {
  return document.querySelector("#ticket-body svg");
}

async function qrImageFile() {
  const svg = qrSvg();
  const person = catalogPerson(openedCode);
  if (!svg || !person) return null;
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const xml = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 760;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffaf4";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 70, 40, 500, 500);
  ctx.fillStyle = "#1c140c";
  ctx.textAlign = "center";
  ctx.font = "700 36px sans-serif";
  ctx.fillText(person.name, 320, 600);
  ctx.font = "28px sans-serif";
  ctx.fillText(person.code, 320, 650);
  URL.revokeObjectURL(url);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new File([blob], `uttaron-${person.code}.png`, { type: "image/png" });
}

async function saveQrImage() {
  const file = await qrImageFile();
  if (!file) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showMessage("QR image saved to Downloads.", "pending");
}

async function shareQrImage(kind) {
  const person = catalogPerson(openedCode);
  if (!person) return;
  const text = `Uttoron order ${person.code} for ${person.name}`;
  const file = await qrImageFile();
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Uttoron ticket", text });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const link = document.createElement("a");
  if (kind === "whatsapp") link.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  else link.href = `mailto:?subject=${encodeURIComponent("Uttoron ticket")}&body=${encodeURIComponent(text)}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.click();
}

async function shareTicket() {
  await shareQrImage("whatsapp");
}

let sheetPublishTried = false;

function renderLiveSheet() {
  const rows = statusGrid();
  const url = currentBook.sheetUrl || "";
  document.querySelectorAll(".sheet-panel").forEach((panel) => {
    const link = panel.querySelector(".google-sheet-link");
    const wait = panel.querySelector(".sheet-wait");
    const wrap = panel.querySelector(".sheet-frame-wrap");
    const frame = panel.querySelector(".google-sheet-frame");
    const table = panel.querySelector(".sheet-table");
    if (url && link && wrap && frame) {
      link.hidden = false;
      link.href = url;
      if (wait) wait.hidden = true;
      wrap.hidden = false;
      const preview = String(url).replace(/\/edit.*$/, "/preview");
      if (frame.getAttribute("src") !== preview) frame.setAttribute("src", preview);
    }
    const sales = panel.querySelector(".google-sales-link");
    if (sales && currentBook.salesSheetUrl) {
      sales.hidden = false;
      sales.href = currentBook.salesSheetUrl;
    }
    if (!table) return;
    table.replaceChildren();
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const nameIndex = (rows[0] || []).indexOf("Name");
    const codeIndex = (rows[0] || []).indexOf("Code");
    (rows[0] || []).forEach((label) => {
      const cell = document.createElement("th");
      cell.textContent = label;
      headRow.append(cell);
    });
    head.append(headRow);
    const body = document.createElement("tbody");
    rows.slice(1).forEach((row) => {
      if (row[0] === "On site sales") {
        const line = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = (rows[0] || []).length || 1;
        cell.textContent = "On site sales";
        cell.className = "sheet-break";
        line.append(cell);
        body.append(line);
        return;
      }
      const line = document.createElement("tr");
      row.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === nameIndex) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "text-button sheet-name";
          button.textContent = value;
          button.addEventListener("click", () => {
            const person = catalogPerson(row[codeIndex]);
            if (person) paintOpen(person, { allActivity: true });
          });
          cell.append(button);
        } else {
          cell.textContent = value;
        }
        line.append(cell);
      });
      body.append(line);
    });
    table.append(head, body);
  });
  if (!url && !sheetPublishTried && readSession()) {
    sheetPublishTried = true;
    queueWrite((book) => {
      book.statusGrid = statusGrid(book);
      book.publishSheet = true;
      return { write: true, book, message: "" };
    });
  }
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
  const people = listedPeople(filter ? filter.value : "", flowTab).slice(0, 80);
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
  const actor = holderNow().actor;
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

function scanMoments() {
  return (currentBook.log || [])
    .map((item) => ({ at: Date.parse(item.at), text: String(item.text || "") }))
    .filter((item) => Number.isFinite(item.at) && /scanned/.test(item.text));
}

function countSince(ms) {
  const cutoff = Date.now() - ms;
  return scanMoments().filter((item) => item.at >= cutoff).length;
}

function dailyScans() {
  const days = new Map();
  scanMoments().forEach((item) => {
    const label = new Date(item.at).toLocaleDateString();
    days.set(label, (days.get(label) || 0) + 1);
  });
  return [...days.entries()];
}

function statsGrid() {
  const rows = [
    ["Metric", "Value"],
    ["Last 15 minutes", countSince(15 * 60 * 1000)],
    ["Last 1 hour", countSince(60 * 60 * 1000)],
    ["Last 6 hours", countSince(6 * 60 * 60 * 1000)],
    ["Day", "Scans"],
  ];
  dailyScans().forEach(([day, count]) => rows.push([day, count]));
  return rows;
}

function renderStats() {
  const recent = countSince(15 * 60 * 1000);
  const hour = countSince(60 * 60 * 1000);
  const hours = countSince(6 * 60 * 60 * 1000);
  const desk = document.querySelector("#desk-stats");
  if (desk) desk.textContent = `Scanned ${recent} in 15 minutes, ${hour} in the last hour, ${hours} in 6 hours.`;
  const map = [["#stats-15", recent], ["#stats-hour", hour], ["#stats-hours", hours]];
  map.forEach(([id, value]) => {
    const node = document.querySelector(id);
    if (node) node.textContent = String(value);
  });
  const chart = document.querySelector("#stats-chart");
  if (!chart) return;
  const days = dailyScans();
  const peak = Math.max(1, ...days.map((item) => item[1]));
  chart.replaceChildren();
  if (!days.length) {
    const empty = document.createElement("p");
    empty.textContent = "No scans yet.";
    chart.append(empty);
    return;
  }
  days.forEach(([day, count]) => {
    const row = document.createElement("p");
    row.className = "stat-bar";
    const label = document.createElement("span");
    label.textContent = day;
    const track = document.createElement("span");
    const bar = document.createElement("i");
    bar.style.width = `${Math.round((count / peak) * 100)}%`;
    track.append(bar);
    const total = document.createElement("span");
    total.textContent = String(count);
    row.append(label, track, total);
    chart.append(row);
  });
}

function exportStats() {
  const csv = statsGrid().map((row) => row.join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `uttaron-stats-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  sayExport("Stats file saved to Downloads. The same counts are written to the Drive sheet.");
}

function sheetHeader() {
  return ["Utilized", "Total", "Name", "Order number", "Code", "Email", "Seen", "Status", "Entry pending", "Food pending", "Pending count", "Pending items", "Picked up items", "Scanned at"];
}

function sheetLine(row) {
  return [row.utilized, row.total, row.name, row.full, row.code, row.email, row.seen, row.status, row.entryPending, row.foodPending, row.pendingCount, row.pendingItems, row.pickedItems, row.scannedAt];
}

function statusGrid(book) {
  const source = book || currentBook;
  const main = TicketLedger.exportRows(source, catalogSource());
  const sales = TicketLedger.exportRows(source, source.walkups || {});
  const rows = [sheetHeader(), ...main.map(sheetLine)];
  if (sales.length) {
    rows.push(["On site sales"]);
    rows.push(...sales.map(sheetLine));
  }
  return rows;
}

function onSiteGrid(book) {
  const source = book || currentBook;
  const sales = TicketLedger.exportRows(source, source.walkups || {});
  return [sheetHeader(), ...sales.map(sheetLine)];
}

function statusFile() {
  const csv = TicketLedger.exportCsv(currentBook, activeOrders());
  const name = `ticket-status-${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, name };
}

function sayExport(text) {
  for (const id of ["#admin-message", "#admin-note"]) {
    const node = document.querySelector(id);
    if (!node) continue;
    node.hidden = false;
    node.textContent = text;
  }
}

function exportStatus() {
  const { csv, name } = statusFile();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  sayExport(`Saved ${name} to your Downloads folder.`);
}

async function emailStatus() {
  const { csv, name } = statusFile();
  const file = new File([csv], name, { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Uttoron ticket status", text: "Ticket status from Uttoron." });
      sayExport("Choose Mail to send the CSV from this phone.");
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const summary = csv.split(/\r?\n/).slice(0, 12).join("\n");
  const body = `Uttoron ticket status\n\n${summary}\n\nDownload CSV saves the full file in the Downloads folder.`;
  const link = document.createElement("a");
  link.href = `mailto:?subject=${encodeURIComponent("Uttoron ticket status")}&body=${encodeURIComponent(body.slice(0, 1600))}`;
  link.click();
  sayExport("Opened the mail app with the totals. Download CSV saves the full file.");
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
document.querySelector("#log-search").addEventListener("input", () => { renderLog(); });
document.querySelector("#site-log-search").addEventListener("input", () => { renderLog(); });
document.querySelectorAll("[data-flow]").forEach((button) => {
  button.addEventListener("click", () => {
    flowTab = button.getAttribute("data-flow") || "waiting";
    renderOrders();
  });
});
function runListSearch(inputId) {
  const input = document.querySelector(inputId);
  const query = input ? input.value.trim() : "";
  const matches = query ? catalogMatches(query) : [];
  if (matches.length === 1) {
    paintOpen(matches[0]);
    return;
  }
  renderOrders();
  if (matches.length > 1 && input) input.focus();
}
document.querySelector("#orders-search").addEventListener("input", () => { renderOrders(); });
document.querySelector("#site-orders-search").addEventListener("input", () => { renderOrders(); });
document.querySelector("#orders-search-btn").addEventListener("click", () => { runListSearch("#orders-search"); });
document.querySelector("#site-orders-search-btn").addEventListener("click", () => { runListSearch("#site-orders-search"); });
document.querySelector("#orders-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runListSearch("#orders-search");
});
document.querySelector("#site-orders-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runListSearch("#site-orders-search");
});
document.querySelector("#main-page").addEventListener("click", closeTicket);
document.querySelectorAll(".demo-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    demoMode = !demoMode;
    paintDemo();
    const person = catalogPerson(openedCode);
    if (person) paintOpen(person);
    renderOrders();
  });
});
document.querySelector("#search-order").addEventListener("click", searchOrder);
document.querySelector("#order-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchOrder();
});
document.querySelector("#refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#admin-refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#export-csv").addEventListener("click", exportStatus);
document.querySelector("#admin-export-csv").addEventListener("click", exportStatus);
document.querySelector("#email-csv").addEventListener("click", () => { emailStatus(); });
document.querySelector("#admin-email-csv").addEventListener("click", () => { emailStatus(); });
document.querySelector("#release-locks").addEventListener("click", () => {
  if (!window.confirm("Release every line lock?")) return;
  const at = new Date().toISOString();
  const applied = queueWrite((book) => TicketLedger.releaseAllLocks(book, at));
  const noteBox = document.querySelector("#admin-note");
  noteBox.hidden = false;
  noteBox.textContent = applied.write ? "All locks released." : "There were no locks.";
  renderOrders();
});
async function applySheetFile(file) {
  const noteBox = document.querySelector("#sheet-note");
  const lower = file.name.toLowerCase();
  let orders;
  try {
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      if (typeof XLSX === "undefined" || !XLSX.read) throw new Error("Excel reader did not load.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const workbook = XLSX.read(bytes, { type: "array" });
      const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false, defval: "" });
      orders = TicketSheet.ordersFromRows(grid);
    } else if (lower.endsWith(".tsv") || lower.endsWith(".txt")) {
      orders = TicketSheet.ordersFromText(await file.text(), "\t");
    } else {
      orders = TicketSheet.ordersFromText(await file.text(), ",");
    }
  } catch (error) {
    noteBox.textContent = error && error.message ? error.message : "Could not read that sheet.";
    return;
  }
  const sheet = { orders, fileName: file.name, uploadedAt: new Date().toISOString() };
  try { localStorage.setItem("ticket-tracker-sheet", JSON.stringify(sheet)); } catch { /* the Drive file still receives it */ }
  queueWrite((book) => {
    book.sheet = sheet;
    return { write: true, book, message: `Loaded ${Object.keys(orders).length} orders from ${file.name}` };
  });
  noteBox.textContent = `Loaded ${Object.keys(orders).length} orders from ${file.name}.`;
  renderOrders();
}

document.querySelector("#sheet-upload").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (file) await applySheetFile(file);
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

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    const page = button.getAttribute("data-page");
    document.querySelectorAll("[data-page]").forEach((item) => {
      item.className = item.getAttribute("data-page") === page ? "btn-teal" : "btn-quiet";
    });
    document.querySelectorAll("[data-page-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-page-panel") !== page;
    });
  });
});
document.querySelector("#home-save-qr").addEventListener("click", () => { saveQrImage(); });
document.querySelector("#home-whatsapp").addEventListener("click", () => { shareQrImage("whatsapp"); });
document.querySelector("#home-email-qr").addEventListener("click", () => { shareQrImage("email"); });
document.querySelector("#export-stats").addEventListener("click", exportStats);
document.querySelector("#new-sale").addEventListener("click", openSale);
document.querySelector("#sale-back").addEventListener("click", () => show(workspace));
document.querySelector("#sale-add").addEventListener("click", () => {
  const select = document.querySelector("#sale-item");
  const option = select.selectedOptions[0];
  if (!option) return;
  const found = cart.find((item) => item.name === option.value);
  if (found) found.qty += 1;
  else cart.push({ name: option.value, qty: 1, lane: option.dataset.lane || "entry" });
  paintCart();
});
document.querySelector("#sale-submit").addEventListener("click", submitSale);
document.querySelector("#print-ticket").addEventListener("click", printTicket);
document.querySelector("#bluetooth-print").addEventListener("click", () => { bluetoothPrint(); });
document.querySelector("#share-ticket").addEventListener("click", () => { shareTicket(); });
document.querySelector("#screenshot-qr").addEventListener("click", () => { saveQrImage(); });
document.querySelector("#whatsapp-share").addEventListener("click", () => { shareQrImage("whatsapp"); });
document.querySelector("#email-share").addEventListener("click", () => { shareQrImage("email"); });

const legend = document.querySelector(".legend");
if (legend) {
  let swipeStart = 0;
  legend.addEventListener("pointerdown", (event) => { swipeStart = event.clientX; });
  legend.addEventListener("pointerup", (event) => {
    const moved = event.clientX - swipeStart;
    if (moved > 36) legend.classList.add("is-open");
    if (moved < -36) legend.classList.remove("is-open");
  });
}

show(gate);
if (readSession()) enterApp();
