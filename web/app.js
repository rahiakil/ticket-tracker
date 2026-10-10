const config = window.TICKET_TRACKER_CONFIG || { publicPageUrl: "" };
const STORE = String(config.storagePrefix || "ticket-tracker").replace(/[^\w-]/g, "") || "ticket-tracker";

function storeKey(name) {
  return `${STORE}-${name}`;
}

let phoneLayout = null;
function markMobile() {
  const mobile = window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;
  const phone = window.matchMedia("(max-width: 820px)").matches;
  document.documentElement.classList.toggle("is-mobile", mobile);
  document.documentElement.classList.toggle("is-phone", phone);
  if (phone === phoneLayout) return;
  phoneLayout = phone;
  document.querySelectorAll(".more-fold").forEach((node) => { node.open = !phone; });
}
markMobile();
window.addEventListener("resize", markMobile);
const BUILTIN_ACCOUNTS = [
  { username: "siteadmin", hash: "4b4d84a924bee4381c8cba1badfe3aa96cd7746ec02e36f862fab18caf42dafc", role: "records" },
  { username: "admin", hash: "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918", role: "scanner" },
  { username: "desk", hash: "49be417ad74080a0031b636b44cfc26fdd0065492d6cd3b033960c4414955cf7", role: "desk" },
  { username: "volunteer", hash: "dcbb0f3cafb30402d5ed4cb826e000bcae930c7ce60763e0458665150dffa879", role: "food" },
];
const ROLE_OPTIONS = [
  ["records", "Site admin"],
  ["scanner", "Admin"],
  ["desk", "Desk"],
  ["food", "Volunteer"],
];
const SESSION_KEY = storeKey("session");
const ALIAS_KEY = storeKey("alias");
const ACCOUNTS_KEY = storeKey("accounts");
let loginLanding = "desk";
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

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
let guestStayCode = "";
let ticketReturn = null;
let currentBook = TicketLedger.emptyBook();
const pendingWrites = [];
let flushTimer = null;
let flushing = false;
const BATCH_WAIT_MS = 0;

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
  guestStayCode = "";
  const body = document.querySelector("#ticket-body");
  if (body) body.replaceChildren();
  show(ticketReturn || workspace);
}

function showGate() {
  stopCamera();
  guestStayCode = "";
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

function storedAccounts() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "null");
    if (!Array.isArray(saved) || !saved.length) return null;
    return saved.filter((account) => account && account.username && account.hash && account.role);
  } catch {
    return null;
  }
}

function accountList() {
  return storedAccounts() || BUILTIN_ACCOUNTS.map((account) => ({ ...account }));
}

function accountMap() {
  const map = {};
  accountList().forEach((account) => { map[account.username] = account; });
  return map;
}

function cacheAccounts(book) {
  const list = book && Array.isArray(book.accounts) && book.accounts.length
    ? book.accounts
    : book && book.sheet && book.sheet.logins;
  if (!Array.isArray(list) || !list.length) return;
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

async function pullAccounts() {
  const url = TicketRecord.recordUrl(recordOptions().recordUrl);
  if (!url) return;
  try {
    cacheAccounts(await TicketRecord.loadWithScript(url));
  } catch {
    /* keep the last saved logins */
  }
}

function readSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    const account = saved && accountMap()[saved.username];
    if (!account || saved.role !== account.role || typeof saved.exp !== "number" || saved.exp <= Date.now()) return null;
    return saved;
  } catch {
    return null;
  }
}

function readAlias() {
  return localStorage.getItem(ALIAS_KEY) || sessionStorage.getItem(ALIAS_KEY) || "";
}

function writeAlias(name) {
  const text = String(name || "").trim();
  if (!text) return;
  localStorage.setItem(ALIAS_KEY, text);
  sessionStorage.setItem(ALIAS_KEY, text);
}

function enterApp() {
  const session = readSession();
  if (!session) return showGate();
  if (!readAlias()) writeAlias(session.username);
  const renewed = { ...session, exp: Date.now() + SESSION_MS };
  localStorage.setItem(SESSION_KEY, JSON.stringify(renewed));
  if (config.recordUrl) {
    document.querySelector("#record-link").closest("label").hidden = true;
    document.querySelector("#save-link").hidden = true;
  }
  if (session.role === "records") {
    document.querySelector("#admin-who").textContent = `Signed in as ${readAlias()} (${session.username})`;
    show(adminScreen);
    showSitePage(siteTab);
    renderLogins();
    refreshOrders();
    return;
  }
  document.querySelector("#who").textContent = `Signed in as ${readAlias()} (${session.username})`;
  show(workspace);
  applyRoleUi();
  showWorkspacePage("desk");
  paintCounter();
  refreshOrders();
}

function isVolunteer() {
  return readSession()?.role === "food";
}

const ABILITY_FIELDS = [
  ["scan", "Scanning"],
  ["add", "Adding"],
  ["edit", "Editing"],
  ["search", "Searching"],
  ["sell", "New sales"],
  ["admin", "Admin functions"],
];

function defaultAbilities(role) {
  if (role === "records" || role === "scanner") {
    return { scan: true, add: true, edit: true, search: true, sell: true, admin: true };
  }
  if (role === "desk") {
    return { scan: true, add: false, edit: false, search: true, sell: true, admin: false };
  }
  return { scan: true, add: true, edit: false, search: false, sell: false, admin: false };
}

function abilitiesFor(account) {
  const next = defaultAbilities(account && account.role);
  const saved = account && account.abilities;
  if (saved && typeof saved === "object") {
    for (const [key] of ABILITY_FIELDS) {
      if (typeof saved[key] === "boolean") next[key] = saved[key];
    }
  }
  if (account && account.role === "records") {
    for (const [key] of ABILITY_FIELDS) next[key] = true;
  }
  if (account && account.role === "desk") next.scan = true;
  return next;
}

function can(name) {
  const session = readSession();
  if (!session) return false;
  const account = accountMap()[session.username];
  return Boolean(abilitiesFor(account)[name]);
}

function canEditSource() {
  return can("edit");
}

function canResetScans() {
  return can("admin");
}

function abilityBox(abilities) {
  const box = document.createElement("fieldset");
  box.className = "ability-set";
  const legend = document.createElement("legend");
  legend.textContent = "Abilities";
  box.append(legend);
  ABILITY_FIELDS.forEach(([key, label]) => {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.ability = key;
    input.checked = Boolean(abilities[key]);
    wrap.append(input, document.createTextNode(` ${label}`));
    box.append(wrap);
  });
  return box;
}

function readAbilities(scope) {
  const abilities = {};
  scope.querySelectorAll("[data-ability]").forEach((input) => {
    abilities[input.dataset.ability] = input.checked;
  });
  return abilities;
}

function applyRoleUi() {
  const session = readSession();
  const volunteer = session?.role === "food";
  const scan = can("scan");
  const add = can("add");
  const search = can("search");
  const sell = can("sell");
  const admin = can("admin");
  const sale = document.querySelector("#new-sale");
  const entryDesk = document.querySelector("#counter-entry");
  if (sale) sale.hidden = !sell;
  document.querySelectorAll(".show-pay").forEach((node) => { node.hidden = !sell && !admin; });
  if (entryDesk) entryDesk.hidden = !add || volunteer;
  const foodDesk = document.querySelector("#counter-food");
  if (foodDesk) foodDesk.hidden = !add;
  const counterSwitch = document.querySelector(".counter-switch");
  if (counterSwitch) counterSwitch.hidden = !add;
  const searchLine = document.querySelector("#order-query")?.closest(".search-line");
  if (searchLine) searchLine.hidden = !search;
  const scanButton = document.querySelector("#scan-btn");
  if (scanButton) scanButton.hidden = !scan;
  document.querySelectorAll("#show-colors").forEach((node) => { node.hidden = !scan && !add; });
  const fileScan = document.querySelector("label[for='file-scan']");
  if (fileScan) fileScan.hidden = !scan;
  document.querySelectorAll("#home-save-qr, #home-whatsapp, #home-email-qr, #qr-box").forEach((node) => { node.hidden = true; });
  const deskStats = document.querySelector("#desk-stats");
  if (deskStats) deskStats.hidden = !admin;
  const orderList = document.querySelector("#orders")?.closest("section");
  if (orderList) orderList.hidden = !search && !add && !scan;
  const findHeading = document.querySelector("[data-page-panel='desk'] h1");
  if (findHeading) findHeading.hidden = !search && !scan && !add;
  document.querySelectorAll("[data-page='admin']").forEach((button) => { button.hidden = !admin; });
  document.querySelectorAll("[data-page='stats']").forEach((button) => { button.hidden = !admin; });
  document.querySelectorAll(".cleanup-scans").forEach((button) => { button.hidden = !canResetScans(); });
  localStorage.setItem(storeKey("counter"), volunteer || !add ? "food" : "entry");
}

function openLogin(username, landing) {
  loginLanding = landing;
  document.querySelector("#username").value = username;
  show(login);
  document.querySelector("#password").focus();
  pullAccounts();
}

document.querySelector("#show-desk").addEventListener("click", () => { openLogin("desk", "desk"); });
document.querySelector("#show-admin-login").addEventListener("click", () => { openLogin("admin", "admin"); });

document.querySelector("#show-volunteer").addEventListener("click", () => { openLogin("volunteer", "desk"); });

document.querySelector("#show-admin").addEventListener("click", () => { openLogin("siteadmin", "records"); });

document.querySelector("#login-back").addEventListener("click", showGate);

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#login-error");
  error.hidden = true;
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
    await Promise.race([pullAccounts(), new Promise((resolve) => { setTimeout(resolve, 4000); })]);
    const username = document.querySelector("#username").value.trim().toLowerCase();
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
    const account = accountMap()[username];
    const current = readSession();
    const accepted = account && password && sameText(digest, account.hash);
    const sameVisit = current && current.username === username && !password;
    if (!accepted && !sameVisit) {
      error.hidden = false;
      error.textContent = "Incorrect username or password.";
      return;
    }
    const landing = account.role === "records" ? "records" : account.role === "scanner" || loginLanding === "admin" ? "admin" : "desk";
    if (accepted) localStorage.setItem(SESSION_KEY, JSON.stringify({ username, role: account.role, landing, exp: Date.now() + SESSION_MS }));
    writeAlias(displayName);
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
  localStorage.removeItem(ALIAS_KEY);
  sessionStorage.removeItem(ALIAS_KEY);
  const pay = document.querySelector("#pay-screen");
  if (pay) pay.hidden = true;
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
  if (!can("scan")) return;
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
    cameraHelp.textContent = cameraDeniedMessage();
  }
}

function cameraDeniedMessage() {
  const apple = /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (apple) return "Tap Allow on the phone prompt. If no prompt appears, open Settings, then Safari, then Camera, and choose Allow. Come back and tap Allow camera again.";
  return "Tap Allow on the phone prompt. If no prompt appears, tap the lock icon in the address bar, set Camera to Allow, then tap Allow camera again.";
}

async function requestCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraHelp.hidden = false;
    cameraHelp.textContent = "Open this page in Safari on iPhone or Chrome on Android, then tap Allow camera.";
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    stream.getTracks().forEach((track) => track.stop());
    cameraHelp.hidden = true;
    return true;
  } catch {
    cameraHelp.hidden = false;
    cameraHelp.textContent = cameraDeniedMessage();
    return false;
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
const allowCamera = document.querySelector("#allow-camera");
if (allowCamera) {
  allowCamera.addEventListener("click", async () => {
    if (await requestCamera()) startCamera();
  });
}
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
    recordUrl: config.recordUrl || localStorage.getItem(storeKey("record-url")) || "",
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
  if (applied.book) {
    currentBook = applied.book;
    cacheLiveBook(currentBook);
  }
  if (applied.write) pendingWrites.push(mutate);
  if (pendingWrites.length) flushWrites();
  return applied;
}

let flushPromise = Promise.resolve(true);
async function flushWrites() {
  clearTimeout(flushTimer);
  if (flushing) return flushPromise;
  if (!pendingWrites.length) return true;
  flushing = true;
  flushPromise = finishFlush();
  return flushPromise;
}

async function finishFlush() {
  const batch = pendingWrites.splice(0, pendingWrites.length);
  try {
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
      stripPrepaidCopy(working);
      return { write, book: working, message, commitMessage: `Save ${batch.length} updates` };
    });
    if (!saved.ok) {
      pendingWrites.unshift(...batch);
      note(saved.message || "Could not save—retry");
      showMessage(saved.message || "Could not save—retry", "save_failed");
      flushTimer = setTimeout(flushWrites, 1500);
      return false;
    }
    currentBook = saved.book || currentBook;
    cacheLiveBook(currentBook);
    for (const mutate of pendingWrites) {
      const applied = mutate(currentBook);
      if (applied.book) currentBook = applied.book;
    }
    renderOrders();
    if (pendingWrites.length) flushTimer = setTimeout(flushWrites, BATCH_WAIT_MS);
    return true;
  } finally {
    flushing = false;
  }
}

function refundedOrders(orders) {
  const rules = (window.TicketCatalog && window.TicketCatalog.refunds) || [];
  if (!rules.length || !orders) return orders || {};
  const next = {};
  for (const [code, order] of Object.entries(orders)) {
    if (!order || !Array.isArray(order.items)) {
      next[code] = order;
      continue;
    }
    const items = [];
    for (const item of order.items) {
      const caps = rules.filter((rule) => rule.code === code && rule.item === item.name).map((rule) => rule.keep);
      const qty = caps.length ? Math.max(0, Math.min(Number(item.qty) || 0, ...caps)) : item.qty;
      if (qty > 0) items.push({ ...item, qty });
    }
    next[code] = { ...order, items };
  }
  return next;
}

function stripPrepaidCopy(book) {
  if (!book || typeof book !== "object") return false;
  const bulky = Boolean(book.sheet && book.sheet.orders && Object.keys(book.sheet.orders).length);
  book.sheet = { epoch: (window.TicketCatalog && window.TicketCatalog.epoch) || "", fileName: "website", orders: {} };
  delete book.statusGrid;
  delete book.onSiteGrid;
  delete book.statsGrid;
  return bulky;
}

function catalogSource() {
  return refundedOrders((window.TicketCatalog && window.TicketCatalog.orders) || {});
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
  return localStorage.getItem(storeKey("counter")) === "food" ? "food" : "entry";
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

function cacheLiveBook(book) {
  if (!book || book.schemaVersion !== 1) return;
  try {
    const copy = {
      schemaVersion: 1,
      orders: book.orders || {},
      locks: book.locks || {},
      log: (book.log || []).slice(-500),
      lines: (book.lines || []).slice(-200),
      disputes: book.disputes || [],
      eventDays: book.eventDays || null,
      accounts: book.accounts || null,
      skus: book.skus || null,
      walkups: book.walkups || {},
    };
    localStorage.setItem(storeKey("book-cache"), JSON.stringify(copy));
  } catch {
    /* scans still save to Drive */
  }
}

function restoreCachedBook() {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey("book-cache")) || "null");
    if (!saved || saved.schemaVersion !== 1 || !saved.orders) return;
    const savedCount = Object.keys(saved.orders).length + Object.keys(saved.walkups || {}).length;
    const currentCount = Object.keys(currentBook.orders || {}).length + Object.keys(currentBook.walkups || {}).length;
    if (!savedCount && currentCount) return;
    currentBook = { ...TicketLedger.emptyBook(), ...saved, walkups: saved.walkups || {} };
  } catch {
    /* start from the baked order list */
  }
}

async function loadPackagedLive() {
  try {
    const response = await fetch(config.liveFile || "live.json", { cache: "no-store" });
    if (!response.ok) return;
    const book = await response.json();
    if (!book || book.schemaVersion !== 1 || !book.orders) return;
    currentBook = { ...TicketLedger.emptyBook(), ...book, walkups: book.walkups || {} };
  } catch {
    /* the packaged file is the fallback */
  }
}

function deviceId() {
  let id = localStorage.getItem(storeKey("device"));
  if (!id) {
    id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(storeKey("device"), id);
  }
  return id;
}

function holderNow() {
  const session = readSession();
  return { holder: deviceId(), actor: readAlias() || (session && session.username) || "admin", at: new Date().toISOString() };
}

const demoMode = false;
const DEFAULT_EVENT_DAYS = { friday: "2026-10-09", saturday: "2026-10-10", sunday: "2026-10-11" };

function eventDates(book) {
  const saved = book && book.eventDays;
  const pick = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(saved && saved[day] || "") ? saved[day] : DEFAULT_EVENT_DAYS[day]);
  const openRaw = saved && saved.open;
  const open = (day) => (openRaw && typeof openRaw[day] === "boolean" ? openRaw[day] : true);
  return {
    friday: pick("friday"),
    saturday: pick("saturday"),
    sunday: pick("sunday"),
    open: { friday: open("friday"), saturday: open("saturday"), sunday: open("sunday") },
  };
}

function paintDemo() {
  const dates = eventDates(currentBook);
  const openNames = ["friday", "saturday", "sunday"].filter((day) => dates.open[day]);
  const summary = `Open: ${openNames.length ? openNames.join(", ") : "none"}. Friday ${dates.friday}, Saturday ${dates.saturday}, Sunday ${dates.sunday}.`;
  for (const button of document.querySelectorAll(".demo-toggle")) {
    button.textContent = demoMode ? "Demo on" : "Demo off";
    button.className = demoMode ? "demo-toggle btn-teal" : "demo-toggle btn-orange";
    button.title = demoMode ? "Demo is on for every ticket" : "Demo is off. Reality dates apply.";
  }
  document.querySelectorAll(".demo-note").forEach((node) => {
    node.textContent = demoMode ? "Demo is on for every ticket." : `Demo is off. ${summary}`;
  });
}

const volunteerMarks = new Map();
const VOLUNTEER_REVERT_MS = 2 * 60 * 1000;

function volunteerRevertLeft(code) {
  const started = volunteerMarks.get(code);
  if (!started) return 0;
  return Math.max(0, VOLUNTEER_REVERT_MS - (Date.now() - started));
}

function canMarkTicket(lane, day) {
  if (can("add")) return true;
  const today = todayEventDay() || "saturday";
  return can("scan") && lane === "entry" && day === today;
}

function eventDatesForMark(book) {
  const dates = eventDates(book);
  const today = todayEventDay() || "saturday";
  dates.open = { ...dates.open, [today]: true };
  return dates;
}

function markOne(person, index, unit) {
  const item = orderView(person).items.find((row) => row.index === index && row.unit === unit);
  const day = item ? TicketLedger.itemDay(item.id) : "";
  if (!canMarkTicket(item && item.lane, day)) return;
  const at = new Date().toISOString();
  const actor = holderNow().actor;
  const applied = queueWrite((book) => {
    const next = TicketLedger.markItem(book, person, index, at, actor, deviceId(), { demo: demoMode, unit, eventDays: eventDatesForMark(book) });
    const message = next.locked
      ? `This line is locked. ${person.name}. ${person.email}.`
      : next.blocked
      ? `Unavailable yet. ${person.name}. ${person.email}.`
      : next.already ? `Already picked up. ${person.name}. ${person.email}.` : `${next.phrase}. ${person.name}. ${person.email}.`;
    return { write: next.changed, book: next.book, message };
  });
  showMessage(applied.message, String(applied.message).startsWith("Already") || String(applied.message).startsWith("Unavailable") ? "already_seen" : "pending");
  if (isVolunteer() && !String(applied.message || "").startsWith("Already") && !String(applied.message || "").startsWith("Unavailable") && !String(applied.message || "").startsWith("This line")) {
    volunteerMarks.set(person.code, Date.now());
  }
  paintOpen(person);
  renderOrders();
}

function markEntryDay(person, bucket) {
  const targets = orderView(person).items.filter((item) => item.lane === "entry" && !item.taken && dayBucket(item.id) === bucket);
  if (!targets.length || !canMarkTicket("entry", bucket)) return;
  const at = new Date().toISOString();
  const actor = holderNow().actor;
  const applied = queueWrite((book) => {
    let current = book;
    let changed = false;
    let phrase = "";
    let blocked = false;
    for (const item of targets) {
      const next = TicketLedger.markItem(current, person, item.index, at, actor, deviceId(), { demo: demoMode, unit: item.unit, eventDays: eventDatesForMark(current) });
      current = next.book;
      changed = changed || next.changed;
      phrase = next.phrase || phrase;
      if (next.locked || next.blocked) {
        blocked = true;
        break;
      }
    }
    const message = blocked && !changed
      ? `Unavailable yet. ${person.name}. ${person.email}.`
      : `${phrase || "Entry done"}. ${person.name}. ${person.email}.`;
    return { write: changed, book: current, message };
  });
  showMessage(applied.message, String(applied.message).startsWith("Unavailable") ? "already_seen" : "pending");
  if (isVolunteer() && !String(applied.message || "").startsWith("Unavailable")) volunteerMarks.set(person.code, Date.now());
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
  if (!can("add")) return;
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

function ticketPill(person, item, index, lane, locked, now) {
  const button = document.createElement("button");
  button.type = "button";
  const kind = TicketLedger.couponKind(item.id, item.lane);
  const day = TicketLedger.itemDay(item.id);
  const today = todayEventDay() || "saturday";
  const closed = !demoMode && Boolean(day) && day !== today && !TicketLedger.dayIsOpen(day, eventDates(currentBook));
  const future = closed;
  const state = item.taken ? (demoMode ? "semi" : "picked") : future ? "not-yet" : "ready";
  button.className = `item-pill coupon-${kind} ${state}`;
  if (kind.startsWith("entry-any") && (state === "ready" || state === "semi")) button.style.background = `hsl(${TicketLedger.entryHue(item.id)} 42% 36%)`;
  const icons = { fish: "🐟", chicken: "🍗", mutton: "🐑", veg: "🥦", paneer: "🥦" };
  const icon = icons[kind] || (String(kind).startsWith("entry") ? "🚪" : "");
  const note = item.taken ? (item.takenBy ? `Done · ${item.takenBy}` : "Done") : future ? "Unavailable yet" : "";
  const ticketLabel = item.parts > 1 ? `${item.id} (${item.unit + 1} of ${item.parts})` : item.id;
  button.textContent = [icon, ticketLabel, note].filter(Boolean).join("\n");
  if (lane === "food" && state === "ready") {
    const doneBox = document.createElement("label");
    doneBox.className = "done-box";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.addEventListener("click", (event) => event.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) markOne(person, item.index, item.unit);
    });
    doneBox.append(check, document.createTextNode(" Done"));
    button.append(doneBox);
  }
  if (locked || !canMarkTicket(lane, day)) button.disabled = true;
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
  return button;
}

function itemButtons(person, options = {}) {
  const view = orderView(person);
  const now = new Date();
  const who = holderNow();
  const locked = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const deskUser = readSession()?.role === "desk";
  const desk = activeCounter();
  const showAll = deskUser || Boolean(options.allTickets) || String(person.full || "").startsWith("WALK");
  const grouped = (deskUser || options.allTickets)
    ? [["Entry", "", "entry"], ["Food", "", "food"]]
    : [
      ["Friday entry", "friday", "entry"],
      ["Friday food", "friday", "food"],
      ["Saturday entry", "saturday", "entry"],
      ["Saturday food", "saturday", "food"],
      ["Sunday entry", "sunday", "entry"],
      ["Sunday food", "sunday", "food"],
      ["3 day visit", "other", "entry"],
      ["3 day visit", "other", "food"],
    ];
  const today = todayEventDay() || "saturday";
  const groups = grouped.filter((group) => showAll || group[2] === desk || (group[2] === "entry" && group[1] === today));
  const board = document.createElement("div");
  board.className = "ticket-board";
  for (const [label, bucket, lane] of groups) {
    const rows = view.items.map((item, index) => ({ item, index })).filter(({ item }) => (!bucket || dayBucket(item.id) === bucket) && (item.lane || "food") === lane);
    if (!rows.length) continue;
    const openRows = rows.filter(({ item }) => !item.taken);
    const doneRows = rows.filter(({ item }) => item.taken);
    const block = document.createElement("section");
    block.className = openRows.length ? "day-block has-open" : "day-block";
    const heading = document.createElement(lane === "entry" && bucket === (todayEventDay() || "saturday") ? "button" : "p");
    heading.className = heading.tagName === "BUTTON" ? "day-heading day-tab" : "day-heading";
    heading.textContent = label;
    if (heading.tagName === "BUTTON") {
      heading.type = "button";
      heading.disabled = !openRows.length || Boolean(locked) || !canMarkTicket("entry", bucket);
      heading.addEventListener("click", () => markEntryDay(person, bucket));
    }
    block.append(heading);
    if (openRows.length) {
      const list = document.createElement("div");
      list.className = "item-pills";
      for (const { item, index } of openRows) list.append(pillWithPrint(person, item, index, lane, locked, now));
      block.append(list);
    }
    if (doneRows.length) {
      const tray = document.createElement("aside");
      tray.className = "done-window";
      const title = document.createElement("h3");
      title.textContent = `Done (${doneRows.length})`;
      const list = document.createElement("div");
      list.className = "item-pills";
      for (const { item, index } of doneRows) list.append(pillWithPrint(person, item, index, lane, locked, now));
      tray.append(title, list);
      block.append(tray);
    }
    board.append(block);
  }
  return board;
}

function itemBoard(person, options = {}) {
  const wrap = document.createElement("div");
  wrap.append(itemButtons(person, options));
  if (!can("add")) return wrap;
  const revert = document.createElement("button");
  revert.type = "button";
  revert.id = "revert-last";
  revert.className = "secondary";
  const who = holderNow();
  const lockedOut = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const left = isVolunteer() ? volunteerRevertLeft(person.code) : VOLUNTEER_REVERT_MS;
  revert.disabled = Boolean(lockedOut) || (isVolunteer() && left <= 0);
  revert.textContent = isVolunteer() ? (left > 0 ? `Revert last (${Math.ceil(left / 1000)}s)` : "Revert closed") : "Revert last";
  revert.addEventListener("click", () => {
    if (isVolunteer() && volunteerRevertLeft(person.code) <= 0) return;
    revertOne(person);
  });
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
  paintDemo();
  if (ticketScreen && ticketScreen.hidden) ticketReturn = adminScreen.hidden ? workspace : adminScreen;
  openedCode = person.code;
  const keepGuest = Boolean(options && options.showGuest) || String(person.full || "").startsWith("WALK") || Boolean(currentBook.walkups && currentBook.walkups[person.code]);
  if (keepGuest) guestStayCode = person.code;
  else if (person.code !== guestStayCode) guestStayCode = "";
  const showGuest = guestStayCode === person.code;
  const who = holderNow();
  const locked = TicketLedger.foreignLock(currentBook, person.code, who.holder, who.at);
  const mine = currentBook.locks && currentBook.locks[person.code];
  const mineFresh = mine && mine.holder === who.holder && Date.parse(who.at) - Date.parse(mine.at || 0) < 60000;
  if (!locked && !mineFresh) {
    queueWrite((book) => TicketLedger.acquireLock(book, person.code, who.holder, who.actor, who.at));
  }
  if (ticketScreen) show(ticketScreen);
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
  const boardOptions = {
    allTickets: Boolean(options && options.allTickets) || String(person.full || "").startsWith("WALK"),
  };
  card.append(title, mail, eventLine, phrase, itemBoard(person, boardOptions), activity);
  if (showGuest) host.append(guestQrPanel(person));
  host.append(card);
}

function canPrintQr() {
  const role = readSession()?.role;
  return role === "desk" || role === "scanner" || role === "records";
}

function pillWithPrint(person, item, index, lane, locked, now) {
  const wrap = document.createElement("div");
  wrap.className = "pill-wrap";
  wrap.append(ticketPill(person, item, index, lane, locked, now));
  if (canPrintQr()) {
    const printOne = document.createElement("button");
    printOne.type = "button";
    printOne.className = "text-button pill-print";
    printOne.textContent = "Print QR";
    printOne.addEventListener("click", () => printOneSlip(person, item));
    wrap.append(printOne);
  }
  return wrap;
}

function slipArticle(person, item) {
  const slip = document.createElement("article");
  slip.className = "print-slip";
  const name = document.createElement("p");
  name.className = "print-slip-name";
  name.textContent = person.name;
  const ticketId = document.createElement("p");
  ticketId.className = "print-slip-id";
  ticketId.textContent = person.full || person.code;
  const label = document.createElement("p");
  label.className = "print-slip-item";
  label.textContent = item && item.parts > 1 ? `${item.id} (${item.unit + 1} of ${item.parts})` : (item && item.id) || "Ticket";
  const qr = document.createElement("div");
  paintQr(person.code, qr);
  slip.append(name, ticketId, label, qr);
  return slip;
}

function printSlips(person, onlyItem) {
  const stack = document.createElement("div");
  stack.className = "print-slips";
  const copies = onlyItem ? [onlyItem] : orderView(person).items;
  const slips = copies.length ? copies : [{ id: "Ticket", unit: 0, parts: 1 }];
  slips.forEach((item) => stack.append(slipArticle(person, item)));
  return stack;
}

function runPrint(stack) {
  const host = document.querySelector("#ticket-body");
  if (!host) return;
  host.querySelectorAll(".print-slips").forEach((node) => node.remove());
  host.append(stack);
  document.body.dataset.print = "ticket";
  window.print();
  delete document.body.dataset.print;
  stack.remove();
}

function printOneSlip(person, item) {
  runPrint(printSlips(person, item));
}

function guestQrPanel(person) {
  const panel = document.createElement("section");
  panel.className = "guest-qr";
  const lead = document.createElement("p");
  lead.className = "guest-qr-lead";
  lead.textContent = "Show this QR to the guest so they can photograph it.";
  const qr = document.createElement("div");
  paintQr(person.code, qr);
  const code = document.createElement("p");
  code.className = "guest-qr-code";
  code.textContent = person.full || person.code;
  const view = orderView(person);
  const items = document.createElement("p");
  items.textContent = view.items.length
    ? view.items.map((item) => (item.parts > 1 ? `${item.id} ${item.unit + 1}/${item.parts}` : item.id)).join(" · ")
    : "Ticket";
  const print = document.createElement("button");
  print.type = "button";
  print.className = "btn-teal";
  print.textContent = "Print";
  print.addEventListener("click", () => printTicket());
  const share = document.createElement("button");
  share.type = "button";
  share.className = "btn-orange";
  share.textContent = "Share QR";
  share.addEventListener("click", () => { shareTicket(); });
  panel.append(lead, qr, code, items, print, share);
  if (currentBook.walkups && currentBook.walkups[person.code]) {
    const change = document.createElement("button");
    change.type = "button";
    change.className = "secondary";
    change.textContent = "Change order";
    change.addEventListener("click", () => startEditSale(person));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Delete order";
    remove.addEventListener("click", () => { deleteSale(person); });
    panel.append(change, remove);
  }
  return panel;
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
  if (!can("search")) return;
  const raw = document.querySelector("#order-query").value.trim();
  const search = document.querySelector("#search-result");
  deskLetter = "";
  renderOrders();
  if (!raw) {
    search.textContent = "Choose a letter, or say a name.";
    search.className = "result pending";
    return;
  }
  const matches = catalogMatches(raw);
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
  search.textContent = `${matches.length} names. Pick one below.`;
  search.className = "result pending";
}

async function submitAttempt() {
  if (!lastAttempt) return;
  showMessage("Checking the latest scans…", "pending");
  await refreshOrders({ force: true });
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
    paintOpen(person, { allTickets: true });
    renderOrders();
    return;
  }
  showMessage(/order-\d+|UTT\d+|^\d{5}$/i.test(lastAttempt.raw.trim()) ? "That order number is not on the shared list yet." : "Invalid QR", "invalid");
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
  localStorage.setItem(storeKey("local-log"), JSON.stringify(kept));
  renderLog();
}

function readNotes() {
  try {
    const items = JSON.parse(localStorage.getItem(storeKey("local-log")) || "[]");
    const epoch = Date.parse(currentBook && currentBook.logEpoch || "") || 0;
    const kept = (Array.isArray(items) ? items : []).filter((item) => item && (!epoch || Date.parse(item.at) > epoch));
    if (epoch && kept.length !== (Array.isArray(items) ? items.length : 0)) {
      localStorage.setItem(storeKey("local-log"), JSON.stringify(kept));
    }
    return kept;
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
let deskLetter = "";
let siteLetter = "";
let saleLetter = "";
let entryLetter = "";
let toolTab = "sheet";
let siteTab = "orders";

function todayEventDay() {
  const dates = eventDates(currentBook);
  const now = new Date();
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  return ["friday", "saturday", "sunday"].find((day) => dates[day] === stamp) || "";
}

function paintEventDays() {
  const dates = eventDates(currentBook);
  for (const day of ["friday", "saturday", "sunday"]) {
    document.querySelectorAll(`.day-date[data-day="${day}"]`).forEach((input) => {
      if (document.activeElement !== input) input.value = dates[day];
    });
    document.querySelectorAll(`.day-open[data-day="${day}"]`).forEach((input) => {
      if (document.activeElement !== input) input.checked = dates.open[day];
    });
  }
}

function eventDayLabel(day) {
  const name = day === undefined ? todayEventDay() : day;
  if (!name) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function todayTickets(person) {
  const day = todayEventDay();
  return orderView(person).items.filter((item) => TicketLedger.itemDay(item.id) === day);
}

function todayPickup(person) {
  const items = todayTickets(person);
  const taken = items.filter((item) => item.taken).length;
  return { total: items.length, taken, ratio: items.length ? taken / items.length : 0 };
}

function nameLetter(person) {
  const initial = String(person.name || "").trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(initial) ? initial : "#";
}

function letterGroups(people) {
  const groups = new Map();
  for (const person of people) {
    const letter = nameLetter(person);
    if (!groups.has(letter)) groups.set(letter, { letter, total: 0, picked: 0, partial: 0, waiting: 0 });
    const group = groups.get(letter);
    group.total += 1;
    const pickup = todayPickup(person);
    if (pickup.total && pickup.taken === pickup.total) group.picked += 1;
    else if (pickup.taken > 0) group.partial += 1;
    else group.waiting += 1;
  }
  return [...groups.values()].sort((left, right) => left.letter.localeCompare(right.letter));
}

function renderLetterBoard(box, people, selected, onPick, shownNames) {
  if (!box) return;
  box.replaceChildren();
  const day = eventDayLabel();
  const live = day === "Friday" || day === "Saturday" || day === "Sunday";
  const hint = document.createElement("p");
  hint.className = "note letter-hint";
  hint.textContent = selected ? "Tap the letter to see every card." : (live ? `Today is ${day}. Tap a letter.` : "Tap a letter.");
  box.append(hint);
  const groups = letterGroups(people);
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.textContent = "No names in this list.";
    box.append(empty);
    return;
  }
  const visible = selected ? groups.filter((group) => group.letter === selected) : groups;
  const grid = document.createElement("div");
  grid.className = selected ? "letter-board is-picked" : "letter-board";
  for (const group of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = selected === group.letter ? "letter-card is-on" : "letter-card";
    const letter = document.createElement("span");
    letter.className = "letter-card-letter";
    letter.textContent = group.letter;
    const count = document.createElement("span");
    count.className = "letter-card-count";
    count.textContent = String(group.total);
    const detail = document.createElement("span");
    detail.className = "letter-card-detail";
    detail.textContent = `${group.total} total, ${group.picked} done, ${group.partial} part, ${group.waiting} left`;
    button.append(letter, count, detail);
    button.addEventListener("click", () => onPick(selected === group.letter ? "" : group.letter));
    grid.append(button);
    if (selected === group.letter) {
      const names = document.createElement("div");
      names.className = "letter-names";
      grid.append(names);
      renderNameList(names, shownNames || [], false);
    }
  }
  box.append(grid);
}

function wasScanned(person) {
  const saved = currentBook.orders[person.code];
  return Boolean(saved && saved.scannedAt);
}

function listedPeople(filter, tab, letter) {
  const tokens = normalized(filter).split(" ").filter(Boolean);
  const searching = tokens.length > 0;
  const people = Object.values(activeOrders()).filter((person) => {
    if (!searching && tab === "scanned" && !wasScanned(person)) return false;
    if (!searching && tab !== "scanned" && wasScanned(person)) return false;
    if (letter && nameLetter(person) !== letter) return false;
    if (!searching) return true;
    const hay = normalized(`${person.name} ${person.email} ${person.full} ${person.code}`);
    return tokens.every((token) => hay.includes(token));
  });
  return people.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function renderNameList(box, people, searching) {
  const token = (box.renderToken || 0) + 1;
  box.renderToken = token;
  box.replaceChildren();
  if (!people.length) {
    const empty = document.createElement("p");
    empty.textContent = searching ? "No matching names." : "No names in this list.";
    box.append(empty);
    return;
  }
  const started = Date.now();
  const status = document.createElement("p");
  status.className = "spinner-row";
  status.innerHTML = `<span class="spinner"></span><span class="load-timer">Loading names… 0s</span>`;
  box.append(status);
  const timer = window.setInterval(() => {
    const label = status.querySelector(".load-timer");
    if (label) label.textContent = `Loading names… ${Math.max(1, Math.round((Date.now() - started) / 1000))}s`;
  }, 200);
  const sorted = people.slice();
    let index = 0;
  function step() {
    if (box.renderToken !== token) {
      window.clearInterval(timer);
      return;
    }
    if (index === 0) status.remove();
    const slice = sorted.slice(index, index + 30);
    for (const person of slice) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary name-row";
      button.textContent = `${person.name} · ${person.code}`;
      button.addEventListener("click", () => paintOpen(person));
      box.append(button);
      if (box.id === "recent-orders") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "text-button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteRecent(person.code));
        box.append(remove);
      }
    }
    index += slice.length;
    if (index < sorted.length) window.requestAnimationFrame(step);
    else window.clearInterval(timer);
  }
  window.requestAnimationFrame(step);
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
  paintDemo();
  paintEventDays();
  renderSkus();
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
  const filter = document.querySelector("#order-query");
  const siteFilter = document.querySelector("#site-orders-search");
  const query = filter ? filter.value : "";
  const siteQuery = siteFilter ? siteFilter.value : "";
  const pool = listedPeople("", flowTab, "");
  const people = listedPeople(query, flowTab, query.trim() ? "" : deskLetter);
  const sitePeople = listedPeople(siteQuery, flowTab, siteQuery.trim() ? "" : siteLetter);
  const deskPicked = query.trim() ? "" : deskLetter;
  const sitePicked = siteQuery.trim() ? "" : siteLetter;
  renderLetterBoard(document.querySelector("#letter-cards"), pool, deskPicked, (letter) => {
    deskLetter = letter;
    if (letter && filter) filter.value = "";
    renderOrders();
  }, deskPicked ? people : null);
  renderLetterBoard(document.querySelector("#site-letter-cards"), listedPeople("", flowTab, ""), sitePicked, (letter) => {
    siteLetter = letter;
    if (letter && siteFilter) siteFilter.value = "";
    renderOrders();
  }, sitePicked ? sitePeople : null);
  if (heading) heading.textContent = `${title} (${query.trim() || deskLetter ? people.length : pool.length})`;
  if (siteHeading) siteHeading.textContent = `${title} (${siteQuery.trim() || siteLetter ? sitePeople.length : pool.length})`;
  if (orders) {
    if (deskPicked) orders.replaceChildren();
    else if (!query.trim()) {
      orders.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "Choose a letter to see those names.";
      orders.append(empty);
    } else renderNameList(orders, people, true);
  }
  if (openedCode && ticketScreen && !ticketScreen.hidden) {
    const person = catalogPerson(openedCode);
    if (person) paintOpen(person);
  }
  renderLog();
  renderRecent();
  renderSoldQrs();
  renderEntries();
  renderSaleAudit();
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

const PINNED_SALE_ITEMS = [
  { name: "Friday Veg", lane: "food", tone: "veg" },
  { name: "Friday Non-Vegetarian", lane: "food", tone: "nonveg" },
];
const FRIDAY_STOCK = {
  "Friday Veg": 10,
  "Friday Non-Vegetarian": 90,
};
const FRIDAY_FOOD_CAP = 100;

function soldQty(name, exceptCode) {
  let total = 0;
  Object.values(currentBook.walkups || {}).forEach((person) => {
    if (exceptCode && person.code === exceptCode) return;
    (person.items || []).forEach((item) => {
      if (item && item.name === name) total += Number(item.qty) || 0;
    });
  });
  return total;
}

function fridaySold(exceptCode) {
  return Object.keys(FRIDAY_STOCK).reduce((sum, name) => sum + soldQty(name, exceptCode), 0);
}

function fridayLeft(name) {
  const cap = FRIDAY_STOCK[name];
  if (cap == null) return Infinity;
  const inCart = cart.filter((row) => row.name === name).reduce((sum, row) => sum + row.qty, 0);
  const otherCart = cart.filter((row) => FRIDAY_STOCK[row.name] && row.name !== name).reduce((sum, row) => sum + row.qty, 0);
  const itemLeft = cap - soldQty(name, editingSaleCode) - inCart;
  const totalLeft = FRIDAY_FOOD_CAP - fridaySold(editingSaleCode) - inCart - otherCart;
  return Math.max(0, Math.min(itemLeft, totalLeft));
}

function fridayCountText() {
  const vegLeft = Math.max(0, FRIDAY_STOCK["Friday Veg"] - soldQty("Friday Veg", editingSaleCode));
  const nonvegLeft = Math.max(0, FRIDAY_STOCK["Friday Non-Vegetarian"] - soldQty("Friday Non-Vegetarian", editingSaleCode));
  const totalLeft = Math.max(0, FRIDAY_FOOD_CAP - fridaySold(editingSaleCode));
  return `Friday food ${totalLeft} of ${FRIDAY_FOOD_CAP} left. Non-veg ${nonvegLeft} of 90. Veg ${vegLeft} of 10.`;
}

let cart = [];
let editingSaleCode = "";

function hiddenSaleItem(name) {
  const text = String(name || "").toLowerCase().replace(/\s+/g, " ");
  if (text.includes("chinese") && /non-?veg/.test(text)) return true;
  if (text.includes("chicken roll") || text.includes("mutton roll") || text.includes("paneer roll")) return true;
  return false;
}

function normalizeSku(raw) {
  if (!raw) return null;
  const day = ["friday", "saturday", "sunday"].includes(raw.day) ? raw.day : "";
  let name = String(raw.name || "").replace(/\s+/g, " ").trim();
  if (!name || !day) return null;
  const dayWord = day.charAt(0).toUpperCase() + day.slice(1);
  if (!new RegExp(`\\b${day}\\b`, "i").test(name)) name = `${dayWord} ${name}`;
  const lane = raw.lane === "entry" ? "entry" : "food";
  const id = String(raw.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-|-$/g, "").slice(0, 60);
  if (!id) return null;
  return { id, name: name.slice(0, 80), day, lane, enabled: raw.enabled !== false };
}

function storedSkuRows() {
  const fromDays = currentBook.eventDays && currentBook.eventDays.skus;
  if (Array.isArray(fromDays)) return fromDays;
  if (Array.isArray(currentBook.skus)) return currentBook.skus;
  try {
    const local = JSON.parse(localStorage.getItem(storeKey("skus")) || "null");
    if (Array.isArray(local)) return local;
  } catch {
    /* catalog tickets still show */
  }
  return null;
}

function mergedSkus() {
  const map = new Map();
  ((window.TicketCatalog && window.TicketCatalog.skus) || []).forEach((sku) => {
    const clean = normalizeSku(sku);
    if (clean) map.set(clean.id, clean);
  });
  (storedSkuRows() || []).forEach((sku) => {
    const clean = normalizeSku(sku);
    if (!clean) return;
    map.set(clean.id, { ...map.get(clean.id), ...clean });
  });
  return [...map.values()];
}

function skuNote(message) {
  document.querySelectorAll(".sku-note, #admin-note, #admin-message").forEach((node) => {
    if (!node) return;
    node.hidden = false;
    node.textContent = message;
  });
}

function persistSkus(list, message) {
  const clean = list.map(normalizeSku).filter(Boolean);
  try { localStorage.setItem(storeKey("skus"), JSON.stringify(clean)); } catch { /* Drive still receives it */ }
  const applied = queueWrite((book) => {
    const days = eventDates(book);
    book.eventDays = {
      friday: days.friday,
      saturday: days.saturday,
      sunday: days.sunday,
      open: days.open,
      skus: clean,
    };
    book.skus = clean;
    return { write: true, book, message: message || "Tickets saved." };
  });
  skuStamp = "";
  skuNote(applied.message);
  renderSkus();
  paintSaleTiles();
}

function setDaysOpen(openMap, message) {
  const applied = queueWrite((book) => {
    const days = eventDates(book);
    const skus = (book.eventDays && Array.isArray(book.eventDays.skus) && book.eventDays.skus) || storedSkuRows() || mergedSkus();
    book.eventDays = {
      friday: days.friday,
      saturday: days.saturday,
      sunday: days.sunday,
      open: { ...days.open, ...openMap },
      skus,
    };
    return { write: true, book, message };
  });
  paintEventDays();
  paintDemo();
  paintSaleTiles();
  skuNote(applied.message);
  const person = catalogPerson(openedCode);
  if (person) paintOpen(person);
}

let skuStamp = "";
function renderSkus() {
  const rows = mergedSkus().sort((left, right) => left.day.localeCompare(right.day) || left.name.localeCompare(right.name));
  const stamp = JSON.stringify(rows);
  if (stamp === skuStamp) return;
  skuStamp = stamp;
  document.querySelectorAll(".sku-list").forEach((host) => {
    host.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "No extra tickets yet.";
      host.append(empty);
      return;
    }
    rows.forEach((sku) => {
      const line = document.createElement("label");
      line.className = "check-line";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = sku.enabled !== false;
      input.addEventListener("change", () => {
        if (!can("admin")) return;
        const next = mergedSkus().map((item) => (item.id === sku.id ? { ...item, enabled: input.checked } : item));
        persistSkus(next, `${sku.name} is ${input.checked ? "on" : "off"} for ${sku.day}.`);
      });
      line.append(input, document.createTextNode(` ${sku.name} · ${sku.day} · ${sku.lane === "entry" ? "entry" : "food"}`));
      host.append(line);
    });
  });
}

function menuItems() {
  const names = new Map();
  Object.values(catalogSource()).forEach((person) => {
    (person.items || []).forEach((item) => {
      if (item.lane !== "food" && item.lane !== "entry") return;
      if (hiddenSaleItem(item.name)) return;
      if (!names.has(item.name)) names.set(item.name, { name: item.name, lane: item.lane, tone: item.tone || item.lane });
    });
  });
  mergedSkus().forEach((sku) => {
    if (sku.enabled === false || hiddenSaleItem(sku.name)) return;
    if (!names.has(sku.name)) names.set(sku.name, { name: sku.name, lane: sku.lane, tone: sku.lane });
  });
  PINNED_SALE_ITEMS.forEach((item) => {
    names.set(item.name, { name: item.name, lane: item.lane, tone: item.tone });
  });
  return [...names.values()].sort((left, right) => {
    if (left.lane !== right.lane) return left.lane === "entry" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function addSaleItem(item) {
  if (item && item.open === false) return;
  if (FRIDAY_STOCK[item.name] != null && fridayLeft(item.name) < 1) {
    const note = document.querySelector("#sale-note");
    if (note) note.textContent = `${item.name} is sold out. ${fridayCountText()}`;
    return;
  }
  const found = cart.find((row) => row.name === item.name);
  if (found) found.qty += 1;
  else cart.push({ name: item.name, qty: 1, lane: item.lane, tone: item.tone || "" });
  paintSaleTiles();
  paintCart();
}

function changeSaleQty(name, delta) {
  const index = cart.findIndex((row) => row.name === name);
  if (index < 0) return;
  cart[index].qty += delta;
  if (cart[index].qty <= 0) cart.splice(index, 1);
  paintSaleTiles();
  paintCart();
}

function saleMenu() {
  return [
    { name: "Saturday Veg", lane: "food", tone: "veg", when: "Saturday", open: true },
    { name: "Sunday Veg", lane: "food", tone: "veg", when: "Sunday", open: false },
    { name: "Sunday Non-Vegetarian", lane: "food", tone: "nonveg", when: "Sunday", open: false },
  ];
}

function paintSaleTiles() {
  const host = document.querySelector("#sale-tiles");
  if (!host) return;
  host.replaceChildren();
  const items = saleMenu();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "No meals are on sale right now.";
    host.append(empty);
    return;
  }
  const hint = document.createElement("p");
  hint.className = "note";
  hint.textContent = "Saturday veg is open. Sunday is closed.";
  host.append(hint);
  for (const when of ["Saturday", "Sunday"]) {
    const group = items.filter((item) => item.when === when);
    if (!group.length) continue;
    const heading = document.createElement("h2");
    heading.className = "sale-lane";
    heading.textContent = when;
    const grid = document.createElement("div");
    grid.className = "sale-tiles";
    group.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sale-tile coupon-${item.tone}`;
      button.dataset.name = item.name;
      button.disabled = !item.open;
      const title = document.createElement("span");
      title.className = "sale-tile-name";
      title.textContent = item.open ? (item.tone === "nonveg" ? "Non-veg" : "Veg") : `${item.tone === "nonveg" ? "Non-veg" : "Veg"} · closed`;
      const badge = document.createElement("span");
      badge.className = "sale-qty";
      badge.hidden = true;
      button.append(title, badge);
      button.addEventListener("click", () => addSaleItem(item));
      grid.append(button);
    });
    host.append(heading, grid);
  }
}

function openSale() {
  if (!can("sell")) return;
  editingSaleCode = "";
  const submit = document.querySelector("#sale-submit");
  if (submit) submit.textContent = "Create QR";
  const cancel = document.querySelector("#sale-cancel");
  if (cancel) cancel.hidden = true;
  cart = [];
  document.querySelector("#sale-name").value = "";
  const email = document.querySelector("#sale-email");
  const noEmail = document.querySelector("#sale-no-email");
  if (email) {
    email.value = "";
    email.disabled = false;
  }
  if (noEmail) noEmail.checked = false;
  document.querySelector("#sale-note").textContent = "Opening Saturday meals…";
  show(saleScreen);
  refreshOrders({ force: true }).then(() => {
    paintSaleTiles();
    paintCart();
    document.querySelector("#sale-note").textContent = "Saturday veg is open. Sunday is closed.";
  });
}

function startEditSale(person) {
  if (!can("sell") || !person) return;
  editingSaleCode = person.code;
  cart = (person.items || []).map((item) => ({
    name: item.name,
    qty: Number(item.qty) || 1,
    lane: item.lane === "entry" ? "entry" : "food",
    tone: item.tone || "",
  }));
  const saleName = document.querySelector("#sale-name");
  if (saleName) saleName.value = person.name || "";
  const email = document.querySelector("#sale-email");
  const noEmail = document.querySelector("#sale-no-email");
  if (email) {
    email.value = person.email || "";
    email.disabled = !person.email;
  }
  if (noEmail) noEmail.checked = !person.email;
  const submit = document.querySelector("#sale-submit");
  if (submit) submit.textContent = "Save changes";
  const cancel = document.querySelector("#sale-cancel");
  if (cancel) cancel.hidden = false;
  const note = document.querySelector("#sale-note");
  if (note) note.textContent = `Changing ${person.full || person.code}. The QR number stays the same. Changing the tickets clears pickup marks on this order.`;
  show(saleScreen);
  refreshOrders({ force: true }).then(() => {
    const latest = currentBook.walkups && currentBook.walkups[person.code];
    if (!latest) {
      editingSaleCode = "";
      if (note) note.textContent = "That sale is no longer on the shared list.";
      return;
    }
    paintSaleTiles();
    paintCart();
  });
}

async function deleteSale(person) {
  if (!can("sell") || !person) return;
  if (!window.confirm(`Delete ${person.full || person.code} for ${person.name}? This QR will stop working.`)) return;
  await refreshOrders({ force: true });
  const at = new Date().toISOString();
  queueWrite((book) => {
    const next = TicketLedger.deleteWalkup(book, person.code, at, holderNow().actor);
    return { write: next.changed, book: next.book, message: `Order ${person.code} deleted.` };
  });
  const saved = await flushWrites();
  if (!saved) return;
  if (editingSaleCode === person.code) editingSaleCode = "";
  if (openedCode === person.code) closeTicket();
  renderOrders();
}

function paintCart() {
  document.querySelectorAll(".sale-tile").forEach((button) => {
    const row = cart.find((item) => item.name === button.dataset.name);
    const badge = button.querySelector(".sale-qty");
    const qty = row ? row.qty : 0;
    if (!badge) return;
    badge.hidden = qty < 1;
    badge.textContent = String(qty);
    button.classList.toggle("is-picked", qty > 0);
  });
  const box = document.querySelector("#sale-checkout");
  if (!box) return;
  box.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "Checkout";
  const who = document.createElement("p");
  const saleName = document.querySelector("#sale-name");
  who.textContent = saleName && saleName.value.trim() ? saleName.value.trim() : "Add a name for this sale.";
  box.append(title, who);
  if (!cart.length) {
    const empty = document.createElement("p");
    empty.textContent = "Tap a meal to add it. Tap it again to add another.";
    box.append(empty);
    return;
  }
  const tickets = cart.reduce((sum, item) => sum + item.qty, 0);
  cart.forEach((item) => {
    const line = document.createElement("div");
    line.className = "checkout-line";
    const label = document.createElement("span");
    label.textContent = `${item.name} × ${item.qty}`;
    const fewer = document.createElement("button");
    fewer.type = "button";
    fewer.className = "text-button";
    fewer.textContent = "Minus";
    fewer.addEventListener("click", () => changeSaleQty(item.name, -1));
    line.append(label, fewer);
    box.append(line);
  });
  const total = document.createElement("p");
  total.className = "checkout-total";
  total.textContent = `${tickets} ticket${tickets === 1 ? "" : "s"}`;
  box.append(total);
}

function nextWalkCode() {
  const used = new Set(Object.keys(activeOrders()));
  let code = 90001;
  while (used.has(String(code))) code += 1;
  return String(code);
}

async function submitSale() {
  if (!can("sell")) return;
  const name = document.querySelector("#sale-name").value.trim();
  const noEmail = document.querySelector("#sale-no-email");
  const email = noEmail && noEmail.checked ? "" : document.querySelector("#sale-email").value.trim();
  const note = document.querySelector("#sale-note");
  if (!name || !cart.length) {
    note.textContent = "Add a name and at least one meal.";
    return;
  }
  if (cart.some((item) => /^Sunday\b/.test(item.name))) {
    note.textContent = "Sunday meals are closed.";
    return;
  }
  note.textContent = "Saving this sale to the shared list…";
  await refreshOrders({ force: true });
  const except = editingSaleCode;
  const over = cart.find((item) => FRIDAY_STOCK[item.name] != null && item.qty > Math.max(0, FRIDAY_STOCK[item.name] - soldQty(item.name, except)));
  if (over || cart.reduce((sum, item) => sum + (FRIDAY_STOCK[item.name] ? item.qty : 0), 0) > Math.max(0, FRIDAY_FOOD_CAP - fridaySold(except))) {
    note.textContent = `Not enough Friday meals left. ${fridayCountText()}`;
    paintSaleTiles();
    paintCart();
    return;
  }
  const code = except || nextWalkCode();
  const existing = except && currentBook.walkups && currentBook.walkups[code];
  if (except && !existing) {
    note.textContent = "That sale is no longer on the shared list.";
    editingSaleCode = "";
    return;
  }
  const person = {
    code,
    full: `WALK${code}`,
    name,
    email,
    event: "On site",
    date: existing && existing.date || new Date().toLocaleDateString(),
    amount: "",
    items: cart.map((item) => ({ name: item.name, qty: item.qty, lane: item.lane === "entry" ? "entry" : "food", tone: item.tone || item.lane })),
  };
  const at = new Date().toISOString();
  const saleMessage = except ? `Order ${code} changed.` : `Order ${code} created.`;
  const previous = existing ? structuredClone(existing) : null;
  queueWrite((book) => {
    const next = except
      ? TicketLedger.updateWalkup(book, person, at, holderNow().actor)
      : TicketLedger.addWalkup(book, person, at, holderNow().actor);
    return { write: next.changed, book: next.book, message: saleMessage };
  });
  const saved = await flushWrites();
  if (!saved) {
    if (except && previous && currentBook.walkups) currentBook.walkups[code] = previous;
    else if (currentBook.walkups) delete currentBook.walkups[code];
    pendingWrites = pendingWrites.filter((mutate) => {
      const applied = mutate(structuredClone(currentBook));
      return applied.message !== saleMessage;
    });
    note.textContent = except
      ? "The change did not save. This sale is unchanged."
      : "The shared list did not save this sale. The QR is not ready. Tap Create QR again.";
    paintSaleTiles();
    paintCart();
    return;
  }
  cart = [];
  editingSaleCode = "";
  const submit = document.querySelector("#sale-submit");
  if (submit) submit.textContent = "Create QR";
  const cancel = document.querySelector("#sale-cancel");
  if (cancel) cancel.hidden = true;
  const copies = person.items.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  note.textContent = except
    ? `Order ${code} was updated. The same QR still works.`
    : `Order ${code} is in the shared list. ${copies} meal${copies === 1 ? "" : "s"} use this QR.`;
  paintOpen(person, { allTickets: true, showGuest: true });
}

function receiptText(person) {
  const view = orderView(person);
  const lines = [`Uttoron ${person.full}`, person.name, person.email || "", ...view.items.map((item) => `${item.taken ? "DONE" : "OPEN"} ${item.parts > 1 ? `${item.id} ${item.unit + 1}/${item.parts}` : item.id}`)];
  return lines.filter(Boolean).join("\n");
}

function printTicket() {
  const person = catalogPerson(openedCode);
  if (!person) return;
  runPrint(printSlips(person));
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
let sheetQuery = "";
let sheetFilter = "all";
let sheetSortCol = 2;
let sheetSortDir = 1;
let sheetToolbarBound = false;

function sheetPickupRatio(person) {
  if (!person) return { total: 0, taken: 0, ratio: 0 };
  const items = orderView(person).items;
  const taken = items.filter((item) => item.taken).length;
  return { total: items.length, taken, ratio: items.length ? taken / items.length : 0 };
}

function bindSheetToolbar() {
  if (sheetToolbarBound) return;
  sheetToolbarBound = true;
  document.querySelectorAll(".sheet-search").forEach((input) => {
    input.addEventListener("input", () => {
      sheetQuery = input.value;
      document.querySelectorAll(".sheet-search").forEach((other) => {
        if (other !== input) other.value = sheetQuery;
      });
      renderLiveSheet();
    });
  });
  document.querySelectorAll(".sheet-filter").forEach((select) => {
    select.addEventListener("change", () => {
      sheetFilter = select.value || "all";
      document.querySelectorAll(".sheet-filter").forEach((other) => { other.value = sheetFilter; });
      renderLiveSheet();
    });
  });
}

function renderLiveSheet() {
  bindSheetToolbar();
  const rows = statusGrid();
  const url = currentBook.sheetUrl || "";
  const header = rows[0] || [];
  const nameIndex = header.indexOf("Name");
  const codeIndex = header.indexOf("Code");
  const salesBreak = rows.findIndex((row, index) => index > 0 && row[0] === "On site sales");
  const mainRows = salesBreak > 0 ? rows.slice(1, salesBreak) : rows.slice(1).filter((row) => row[0] !== "On site sales");
  const saleRows = salesBreak > 0 ? rows.slice(salesBreak + 1) : [];
  const tokens = normalized(sheetQuery).split(" ").filter(Boolean);
  const statusIndex = header.indexOf("Status");
  function matches(row) {
    const status = statusIndex >= 0 ? row[statusIndex] : "";
    if (sheetFilter === "done" && status !== "Taken completely") return false;
    if (sheetFilter === "open" && status === "Taken completely") return false;
    if (!tokens.length) return true;
    const hay = normalized(row.join(" "));
    return tokens.every((token) => hay.includes(token));
  }
  function sortRows(list) {
    const col = Math.max(0, Math.min(sheetSortCol, Math.max(0, header.length - 1)));
    return list.slice().sort((left, right) => {
      const a = String(left[col] ?? "");
      const b = String(right[col] ?? "");
      const asNum = Number(a);
      const bsNum = Number(b);
      const cmp = Number.isFinite(asNum) && Number.isFinite(bsNum) && a !== "" && b !== ""
        ? asNum - bsNum
        : a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
      return cmp * sheetSortDir;
    });
  }
    const shownMain = sortRows(mainRows.filter(matches));
  const shownSales = sortRows(saleRows.filter(matches));
  const shownCount = shownMain.length + shownSales.length;
  const totalCount = mainRows.length + saleRows.length;
  const editing = canEditSource();
  const sourceOrders = rawCatalogOrders();

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
    header.forEach((label, index) => {
      const cell = document.createElement("th");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sheet-sort";
      button.textContent = sheetSortCol === index
        ? `${label} ${sheetSortDir > 0 ? "▲" : "▼"}`
        : label;
      button.addEventListener("click", () => {
        if (sheetSortCol === index) sheetSortDir *= -1;
        else {
          sheetSortCol = index;
          sheetSortDir = 1;
        }
        renderLiveSheet();
      });
      cell.append(button);
      headRow.append(cell);
    });
    if (editing) {
      const cell = document.createElement("th");
      cell.textContent = "Edit";
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    function appendDataRows(list) {
      list.forEach((row) => {
        const line = document.createElement("tr");
        const person = codeIndex >= 0 ? catalogPerson(row[codeIndex]) : null;
        const pickup = sheetPickupRatio(person);
        const lockedText = codeIndex >= 0 ? lockLabel(row[codeIndex]) : "";
        if (lockedText) {
          line.className = "sheet-locked";
          line.title = lockedText;
        } else if (pickup.ratio >= 1 && pickup.total) {
          line.className = "sheet-done";
          line.title = "All tickets picked up";
        } else if (pickup.ratio > 0) {
          line.className = "sheet-picked sheet-partial";
          line.style.setProperty("--pick", `${Math.round(pickup.ratio * 100)}%`);
          line.title = `${pickup.taken} of ${pickup.total} tickets picked up`;
        }
        row.forEach((value, index) => {
          const cell = document.createElement("td");
          const label = header[index];
          if (label === "Name" || label === "Email" || label === "Pending items" || label === "Picked up items" || label === "Status") {
            cell.classList.add("sheet-wrap");
          }
          if (index === nameIndex) cell.classList.add("sheet-name-cell");
          if (index === nameIndex) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "text-button sheet-name";
            button.textContent = value;
            button.addEventListener("click", () => {
              const match = catalogPerson(row[codeIndex]);
              if (match) paintOpen(match, { allActivity: true });
            });
            cell.append(button);
            if (pickup.total) {
              const mark = document.createElement("span");
              mark.className = "today-mark";
              mark.textContent = pickup.ratio === 1 ? "Complete" : `${Math.round(pickup.ratio * 100)}% picked`;
              cell.append(mark);
            }
          } else {
            cell.textContent = value;
          }
          line.append(cell);
        });
        if (editing && person && sourceOrders[person.code]) {
          const cell = document.createElement("td");
          cell.className = "sheet-edit";
          const removeOrder = document.createElement("button");
          removeOrder.type = "button";
          removeOrder.className = "secondary";
          removeOrder.textContent = "Delete order";
          removeOrder.addEventListener("click", () => editSource({ type: "delete-order", code: person.code }));
          cell.append(removeOrder);
          (person.items || []).forEach((item) => {
            const removeItem = document.createElement("button");
            removeItem.type = "button";
            removeItem.className = "text-button";
            removeItem.textContent = `Remove ${item.name} x ${item.qty}`;
            removeItem.addEventListener("click", () => editSource({ type: "delete-item", code: person.code, name: item.name }));
            cell.append(removeItem);
          });
          line.append(cell);
        }
        body.append(line);
      });
    }
    appendDataRows(shownMain);
    if (shownSales.length) {
      const line = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = header.length || 1;
      cell.textContent = "On site sales";
      cell.className = "sheet-break";
      line.append(cell);
      body.append(line);
      appendDataRows(shownSales);
    }
    table.append(head, body);
  });
  document.querySelectorAll(".sheet-day-note").forEach((node) => {
    node.textContent = `Showing ${shownCount} of ${totalCount} orders. Green means done. A green bar means partly picked up. Yellow means locked. Click a column title to sort.`;
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

function saleActor(code) {
  const lines = (currentBook.log || []).filter((item) => String(item.text || "").startsWith(`${code} `));
  const last = lines[lines.length - 1];
  const match = last && String(last.text).match(/ by (.+)$/);
  return match ? match[1] : "";
}

function saleCreatedAt(code) {
  const line = (currentBook.log || []).find((item) => String(item.text || "").startsWith(`${code} new sale`));
  const when = Date.parse(line && line.at);
  return Number.isFinite(when) ? when : Number(code) || 0;
}

function fridaySaleRows() {
  return Object.values(currentBook.walkups || {}).sort((left, right) => saleCreatedAt(right.code) - saleCreatedAt(left.code) || Number(right.code) - Number(left.code));
}

function saleIssues(sales) {
  const issues = [];
  const nonveg = soldQty("Friday Non-Vegetarian");
  const veg = soldQty("Friday Veg");
  const total = nonveg + veg;
  if (nonveg > FRIDAY_STOCK["Friday Non-Vegetarian"]) issues.push(`Non-veg is over the cap by ${nonveg - 90}.`);
  if (veg > FRIDAY_STOCK["Friday Veg"]) issues.push(`Veg is over the cap by ${veg - 10}.`);
  if (total > FRIDAY_FOOD_CAP) issues.push(`Friday food is over 100 by ${total - 100}.`);
  const byName = new Map();
  sales.forEach((person) => {
    const name = String(person.name || "").trim();
    const key = name.toLowerCase();
    if (!name) issues.push(`${person.full || person.code} has no name.`);
    else {
      const list = byName.get(key) || [];
      list.push(person.full || person.code);
      byName.set(key, list);
    }
    const items = person.items || [];
    if (!items.length) issues.push(`${person.full || person.code} has no tickets.`);
    items.forEach((item) => {
      if (!item || !(Number(item.qty) > 0)) issues.push(`${person.full || person.code} has a ticket with no count.`);
    });
  });
  byName.forEach((codes, name) => {
    if (codes.length > 1) issues.push(`${name} is on ${codes.length} sales: ${codes.join(", ")}.`);
  });
  const listed = sales.reduce((sum, person) => sum + (person.items || []).reduce((inner, item) => {
    if (!item || !FRIDAY_STOCK[item.name]) return inner;
    return inner + (Number(item.qty) || 0);
  }, 0), 0);
  if (listed !== total) issues.push(`The name list adds up to ${listed}, but the Friday count is ${total}.`);
  return issues;
}

function saleAuditNode() {
  const section = document.createElement("section");
  const sales = fridaySaleRows();
  const nonveg = soldQty("Friday Non-Vegetarian");
  const veg = soldQty("Friday Veg");
  const total = nonveg + veg;
  const counts = document.createElement("p");
  counts.className = "sale-check";
  counts.textContent = `Non-veg ${nonveg} of 90. Veg ${veg} of 10. Friday total ${total} of 100. ${FRIDAY_FOOD_CAP - total} left.`;
  section.append(counts);
  const issues = saleIssues(sales);
  const flag = document.createElement("p");
  flag.className = issues.length ? "sale-issue" : "sale-check";
  flag.textContent = issues.length ? `Discrepancy: ${issues.join(" ")}` : "No discrepancy. The names add up to the counts.";
  section.append(flag);
  if (!sales.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No new sales yet.";
    section.append(empty);
    return section;
  }
  sales.forEach((person) => {
    const row = document.createElement("p");
    row.className = `sale-check sale-${mealKind(person)}`;
    const items = (person.items || []).map((item) => `${item.name} × ${item.qty || 0}`).join(", ") || "no tickets";
    const actor = saleActor(person.code);
    row.textContent = `${person.name || "No name"} · ${person.full || person.code} · ${items}${actor ? ` · sold by ${actor}` : ""}`;
    section.append(row);
  });
  return section;
}

function mealKind(person) {
  let veg = 0;
  let nonveg = 0;
  for (const item of person.items || []) {
    const qty = Number(item && item.qty) || 0;
    if (qty <= 0) continue;
    const label = String(item.name || "");
    if (/non-?vegetarian/i.test(label)) nonveg += qty;
    else if (/\bveg\b/i.test(label)) veg += qty;
  }
  if (veg && nonveg) return "mixed";
  if (veg) return "veg";
  if (nonveg) return "nonveg";
  return "mixed";
}

function soldButtonClass(person) {
  const kind = mealKind(person);
  if (kind === "veg") return "sold-veg";
  if (kind === "nonveg") return "sold-nonveg";
  return "btn-orange";
}

function appendSoldRow(box, person) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = soldButtonClass(person);
  const items = (person.items || []).map((item) => `${item.name} × ${item.qty || 1}`).join(", ");
  button.textContent = `${person.name} · ${person.full || person.code}${items ? ` · ${items}` : ""}`;
  button.addEventListener("click", () => paintOpen(person, { allTickets: true, showGuest: true }));
  const change = document.createElement("button");
  change.type = "button";
  change.className = "secondary";
  change.textContent = "Change";
  change.addEventListener("click", () => startEditSale(person));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => { deleteSale(person); });
  const row = document.createElement("div");
  row.className = "sold-row";
  row.append(button, change, remove);
  box.append(row);
}

function entryDoneRows() {
  return Object.values(activeOrders()).map((person) => {
    const items = orderView(person).items.filter((item) => item.lane === "entry" && item.taken);
    if (!items.length) return null;
    const saved = currentBook.orders[person.code] || {};
    const when = items.reduce((latest, item) => Math.max(latest, Date.parse(item.takenAt || 0) || 0), 0)
      || Date.parse(saved.updatedAt || saved.scannedAt || 0)
      || 0;
    return { person, items, when };
  }).filter(Boolean).sort((left, right) => right.when - left.when || String(right.person.code).localeCompare(String(left.person.code)));
}

function renderEntries() {
  const box = document.querySelector("#entry-done");
  if (!box) return;
  box.replaceChildren();
  const all = entryDoneRows();
  const query = document.querySelector("#entry-query") ? document.querySelector("#entry-query").value : "";
  const tokens = normalized(query).split(" ").filter(Boolean);
  const searching = tokens.length > 0;
  const matches = all.filter((row) => {
    if (!searching) return true;
    const items = row.items.map((item) => item.name).join(" ");
    const hay = normalized(`${row.person.name} ${row.person.full} ${row.person.code} ${items}`);
    return tokens.every((token) => hay.includes(token));
  });
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = all.length ? `${all.length} checked in. Newest first.` : "No entries are done yet.";
  box.append(note);
  const showRows = (rows) => {
    rows.forEach((row) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary name-row";
      const items = row.items.map((item) => item.name).join(", ");
      button.textContent = `${row.person.name} · ${row.person.code}${items ? ` · ${items}` : ""}`;
      button.addEventListener("click", () => paintOpen(row.person));
      box.append(button);
    });
  };
  if (!searching && all.length > 50) {
    const counts = new Map();
    all.forEach((row) => {
      const letter = nameLetter(row.person);
      counts.set(letter, (counts.get(letter) || 0) + 1);
    });
    if (entryLetter && !counts.has(entryLetter)) entryLetter = "";
    const hint = document.createElement("p");
    hint.className = "note";
    hint.textContent = entryLetter ? "Tap the letter to see every letter." : "More than 50 entries. Tap a letter.";
    box.append(hint);
    const board = document.createElement("div");
    board.className = entryLetter ? "letter-board is-picked" : "letter-board sale-letters";
    const letters = [...counts.keys()].sort((left, right) => left.localeCompare(right));
    (entryLetter ? letters.filter((letter) => letter === entryLetter) : letters).forEach((letter) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = entryLetter === letter ? "letter-card is-on" : "letter-card";
      const mark = document.createElement("span");
      mark.className = "letter-card-letter";
      mark.textContent = letter;
      const count = document.createElement("span");
      count.className = "letter-card-count";
      count.textContent = String(counts.get(letter));
      button.append(mark, count);
      button.addEventListener("click", () => {
        entryLetter = entryLetter === letter ? "" : letter;
        renderEntries();
      });
      board.append(button);
    });
    box.append(board);
    if (!entryLetter) return;
    showRows(matches.filter((row) => nameLetter(row.person) === entryLetter));
    return;
  }
  if (!matches.length) {
    if (searching) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No matching entries.";
      box.append(empty);
    }
    return;
  }
  showRows(matches);
}

function renderSoldQrs() {
  const box = document.querySelector("#sold-qrs");
  const search = document.querySelector("#sold-query");
  const searchLabel = search && search.closest("label");
  if (searchLabel) searchLabel.hidden = !can("sell");
  if (!box) return;
  box.replaceChildren();
  if (!can("sell")) return;
  const all = fridaySaleRows();
  const query = document.querySelector("#sold-query") ? document.querySelector("#sold-query").value : "";
  const tokens = normalized(query).split(" ").filter(Boolean);
  const searching = tokens.length > 0;
  const matches = all.filter((person) => {
    if (!searching) return true;
    const items = (person.items || []).map((item) => `${item.name} ${item.qty || ""}`).join(" ");
    const hay = normalized(`${person.name} ${person.full} ${person.code} ${items}`);
    return tokens.every((token) => hay.includes(token));
  });
  const heading = document.createElement("h2");
  heading.className = "sale-lane";
  heading.textContent = "Sold QR codes";
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = all.length
    ? "Newest first. Red is non-veg, green is veg, orange is both."
    : "New sales appear here so you can open the QR again.";
  box.append(heading, note);
  if (!searching && all.length > 50) {
    const counts = new Map();
    all.forEach((person) => {
      const letter = nameLetter(person);
      counts.set(letter, (counts.get(letter) || 0) + 1);
    });
    if (saleLetter && !counts.has(saleLetter)) saleLetter = "";
    const hint = document.createElement("p");
    hint.className = "note";
    hint.textContent = saleLetter ? "Tap the letter to see every letter." : "More than 50 sales. Tap a letter.";
    box.append(hint);
    const board = document.createElement("div");
    board.className = saleLetter ? "letter-board is-picked" : "letter-board sale-letters";
    const letters = [...counts.keys()].sort((left, right) => left.localeCompare(right));
    (saleLetter ? letters.filter((letter) => letter === saleLetter) : letters).forEach((letter) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = saleLetter === letter ? "letter-card is-on" : "letter-card";
      const mark = document.createElement("span");
      mark.className = "letter-card-letter";
      mark.textContent = letter;
      const count = document.createElement("span");
      count.className = "letter-card-count";
      count.textContent = String(counts.get(letter));
      button.append(mark, count);
      button.addEventListener("click", () => {
        saleLetter = saleLetter === letter ? "" : letter;
        renderSoldQrs();
      });
      board.append(button);
    });
    box.append(board);
    if (!saleLetter) return;
    matches.filter((person) => nameLetter(person) === saleLetter).forEach((person) => appendSoldRow(box, person));
    return;
  }
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = searching ? "No matching sales." : "";
    if (searching) box.append(empty);
    return;
  }
  matches.forEach((person) => appendSoldRow(box, person));
}

function renderRecent() {
  const recent = document.querySelector("#recent-orders");
  if (!recent) return;
  const filter = document.querySelector("#site-orders-search");
  const query = filter ? filter.value : "";
  if (siteLetter && !query.trim()) {
    recent.replaceChildren();
    return;
  }
  if (!query.trim()) {
    recent.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "Choose a letter to see those names.";
    recent.append(empty);
    return;
  }
  renderNameList(recent, listedPeople(query, flowTab, ""), true);
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

function rawCatalogOrders() {
  return (window.TicketCatalog && window.TicketCatalog.orders) || {};
}

function editSource(action) {
  if (!canEditSource()) return;
  const label = action.type === "delete-order"
    ? `Delete order ${action.code} from the source sheet?`
    : `Remove ${action.name} from order ${action.code}?`;
  if (!window.confirm(label)) return;
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const orders = rawCatalogOrders();
  const applied = queueWrite((book) => {
    const prepared = TicketLedger.prepareSourceSheet(book, orders);
    return TicketLedger.editSourceSheet(prepared, action, at, actor);
  });
  if (applied.book && applied.book.sheet) {
    try { localStorage.setItem(storeKey("sheet"), JSON.stringify(applied.book.sheet)); } catch { /* Drive still has it */ }
  }
  const message = document.querySelector("#admin-note") || document.querySelector("#admin-message");
  if (message) {
    message.hidden = false;
    message.textContent = applied.write ? "Source sheet updated." : "That row was already gone.";
  }
  renderOrders();
}

function roleSelect(selected) {
  const select = document.createElement("select");
  select.className = "login-role";
  ROLE_OPTIONS.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    select.append(option);
  });
  return select;
}

function renderLogins() {
  const list = document.querySelector("#login-list");
  if (!list) return;
  list.replaceChildren();
  accountList().forEach((account) => {
    const row = document.createElement("div");
    row.className = "login-row";
    const name = document.createElement("input");
    name.className = "login-username";
    name.value = account.username;
    name.autocomplete = "off";
    name.autocapitalize = "none";
    const password = document.createElement("input");
    password.className = "login-password";
    password.type = "password";
    password.autocomplete = "new-password";
    password.placeholder = "New password, leave blank to keep";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-teal";
    save.textContent = "Save login";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove";
    const abilities = abilityBox(abilitiesFor(account));
    save.addEventListener("click", () => saveLoginRow(account, name.value, row.querySelector(".login-role").value, password.value, readAbilities(abilities)));
    remove.addEventListener("click", () => removeLogin(account.username));
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Username";
    nameLabel.append(name);
    const passLabel = document.createElement("label");
    passLabel.textContent = "Password";
    passLabel.append(password);
    const roleLabel = document.createElement("label");
    roleLabel.textContent = "Role";
    const role = roleSelect(account.role);
    role.addEventListener("change", () => {
      const next = defaultAbilities(role.value);
      abilities.querySelectorAll("[data-ability]").forEach((input) => { input.checked = Boolean(next[input.dataset.ability]); });
    });
    roleLabel.append(role);
    row.append(nameLabel, passLabel, roleLabel, abilities, save, remove);
    list.append(row);
  });
}

async function accountFromFields(username, role, password, previous, abilities) {
  const name = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) return { error: "Username needs 2 to 32 letters or numbers." };
  if (!["records", "scanner", "desk", "food"].includes(role)) return { error: "Choose a role." };
  if (!password && !previous) return { error: "Enter a password for the new login." };
  const hash = password ? await sha256(password) : previous.hash;
  return { account: { username: name, role, hash, abilities: abilities || defaultAbilities(role) } };
}

async function persistAccounts(accounts, message) {
  const at = new Date().toISOString();
  const actor = readSession()?.username || "siteadmin";
  const applied = queueWrite((book) => TicketLedger.saveAccounts(book, accounts, at, actor));
  const noteBox = document.querySelector("#login-note");
  if (!applied.write) {
    if (noteBox) {
      noteBox.hidden = false;
      noteBox.textContent = "Keep at least one site admin login.";
    }
    return;
  }
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(applied.book.accounts));
  if (noteBox) {
    noteBox.hidden = false;
    noteBox.textContent = message;
  }
  const session = readSession();
  const still = session && applied.book.accounts.some((account) => account.username === session.username && account.role === session.role);
  if (session && !still) {
    const renamed = applied.book.accounts.find((account) => account.role === "records");
    if (renamed) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, username: renamed.username, role: renamed.role }));
    }
  }
  renderLogins();
  enterApp();
}

async function saveLoginRow(previous, username, role, password, abilities) {
  const built = await accountFromFields(username, role, password, previous, abilities);
  const noteBox = document.querySelector("#login-note");
  if (built.error) {
    if (noteBox) {
      noteBox.hidden = false;
      noteBox.textContent = built.error;
    }
    return;
  }
  const accounts = accountList().filter((account) => account.username !== previous.username);
  if (accounts.some((account) => account.username === built.account.username)) {
    if (noteBox) {
      noteBox.hidden = false;
      noteBox.textContent = "That username is already used.";
    }
    return;
  }
  accounts.push(built.account);
  await persistAccounts(accounts, `Saved ${built.account.username}.`);
}

async function removeLogin(username) {
  const session = readSession();
  if (session && session.username === username) {
    const noteBox = document.querySelector("#login-note");
    noteBox.hidden = false;
    noteBox.textContent = "Sign in as another site admin before removing this login.";
    return;
  }
  if (!window.confirm(`Remove login ${username}?`)) return;
  const accounts = accountList().filter((account) => account.username !== username);
  await persistAccounts(accounts, `Removed ${username}.`);
}

async function createLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const built = await accountFromFields(
    form.querySelector("#new-username").value,
    form.querySelector("#new-role").value,
    form.querySelector("#new-password").value,
    null,
    readAbilities(form),
  );
  const noteBox = document.querySelector("#login-note");
  if (built.error) {
    noteBox.hidden = false;
    noteBox.textContent = built.error;
    return;
  }
  if (accountList().some((account) => account.username === built.account.username)) {
    noteBox.hidden = false;
    noteBox.textContent = "That username is already used.";
    return;
  }
  await persistAccounts(accountList().concat(built.account), `Created ${built.account.username}.`);
  form.reset();
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

let showedCache = false;
let readingRecord = false;
let recordRead = Promise.resolve();
async function refreshOrders(options) {
  const force = Boolean(options && options.force);
  if (!showedCache) {
    showedCache = true;
    renderOrders();
  }
  if (readingRecord) {
    try { await recordRead; } catch { /* the in-flight check reports its own result */ }
    if (!force) return false;
  }
  const run = loadRecord(force);
  recordRead = run;
  return run;
}

async function loadRecord(force) {
  if (!force && flushing) return false;
  while (flushing) await new Promise((resolve) => setTimeout(resolve, 40));
  readingRecord = true;
  try {
  if (pendingWrites.length) await flushWrites();
  const options = recordOptions();
  if (!TicketRecord.recordUrl(options.recordUrl)) return false;
  const loaded = await TicketRecord.commit(options, (book) => ({
    write: false,
    book,
    message: "",
    commitMessage: "",
  }));
  if (loaded.missing) return false;
  if (!loaded.ok) {
    const message = document.querySelector("#admin-message");
    if (message) {
      message.hidden = false;
      message.textContent = loaded.message || "Could not save—retry";
    }
    return false;
  }
  currentBook = loaded.book;
  if (stripPrepaidCopy(currentBook)) {
    queueWrite((book) => {
      stripPrepaidCopy(book);
      return { write: true, book, message: "" };
    });
  }
  cacheLiveBook(currentBook);
  cacheAccounts(loaded.book);
  if (readSession() && readSession().role !== "records") applyRoleUi();
  if (readSession() && readSession().role !== "records") applyRoleUi();
  const preview = TicketLedger.cleanSheetBook(loaded.book);
  if (preview.changed) {
    queueWrite((book) => {
      const next = TicketLedger.cleanSheetBook(book);
      return { write: next.changed, book: next.book, message: "Cleaned old scans" };
    });
  }
  renderOrders();
  return true;
  } finally {
    readingRecord = false;
  }
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

function foodKindLabel(kind) {
  const labels = {
    fish: "Fish",
    chicken: "Chicken",
    mutton: "Mutton",
    veg: "Vegetarian",
    paneer: "Paneer",
    snack: "Snacks",
    nonveg: "Non-veg",
    "food-other": "Other food",
  };
  if (labels[kind]) return labels[kind];
  if (String(kind).startsWith("entry-")) return "Entry";
  return kind || "Other";
}

function ticketKindStats() {
  const groups = new Map();
  for (const person of Object.values(activeOrders())) {
    for (const item of orderView(person).items) {
      const kind = TicketLedger.couponKind(item.id, item.lane);
      const label = foodKindLabel(kind);
      if (!groups.has(label)) groups.set(label, { label, total: 0, taken: 0, open: 0 });
      const row = groups.get(label);
      row.total += 1;
      if (item.taken) row.taken += 1;
      else row.open += 1;
    }
  }
  return [...groups.values()].sort((left, right) => right.total - left.total || left.label.localeCompare(right.label));
}

function activeLockRows() {
  const now = Date.now();
  return Object.entries(currentBook.locks || {})
    .map(([code, lock]) => {
      const age = now - Date.parse(lock && lock.at || "");
      if (!Number.isFinite(age) || age < 0 || age >= TicketLedger.LOCK_MS) return null;
      const person = catalogPerson(code);
      return {
        code,
        name: person ? person.name : code,
        actor: lock.actor || "staff",
        left: Math.max(0, TicketLedger.LOCK_MS - age),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function lockLabel(code) {
  const now = Date.now();
  const lock = currentBook.locks && currentBook.locks[code];
  if (!lock) return "";
  const age = now - Date.parse(lock.at || "");
  if (!Number.isFinite(age) || age < 0 || age >= TicketLedger.LOCK_MS) return "";
  return `Locked by ${lock.actor || "staff"}`;
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
  rows.push(["Food kind", "Total", "Taken", "Open"]);
  ticketKindStats().forEach((row) => rows.push([row.label, row.total, row.taken, row.open]));
  rows.push(["Locks", "Name", "By", "Seconds left"]);
  activeLockRows().forEach((row) => rows.push(["Locked", row.name, row.actor, Math.ceil(row.left / 1000)]));
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
  if (chart) {
    const days = dailyScans();
    const peak = Math.max(1, ...days.map((item) => item[1]));
    chart.replaceChildren();
    if (!days.length) {
      const empty = document.createElement("p");
      empty.textContent = "No scans yet.";
      chart.append(empty);
    } else {
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
  }
  const foodBox = document.querySelector("#stats-food");
  if (foodBox) {
    foodBox.replaceChildren();
    const kinds = ticketKindStats();
    if (!kinds.length) {
      const empty = document.createElement("p");
      empty.textContent = "No tickets loaded.";
      foodBox.append(empty);
    } else {
      kinds.forEach((item) => {
        const row = document.createElement("p");
        row.className = "food-stat";
        row.textContent = `${item.label}: ${item.taken} taken / ${item.total} total (${item.open} open)`;
        foodBox.append(row);
      });
    }
  }
  const lockBox = document.querySelector("#stats-locks");
  if (lockBox) {
    lockBox.replaceChildren();
    const locks = activeLockRows();
    if (!locks.length) {
      const empty = document.createElement("p");
      empty.textContent = "No rows are locked right now.";
      lockBox.append(empty);
    } else {
      locks.forEach((item) => {
        const row = document.createElement("p");
        row.className = "lock-stat";
        row.textContent = `${item.name} · ${item.code} · locked by ${item.actor} · ${Math.ceil(item.left / 1000)}s left`;
        lockBox.append(row);
      });
    }
  }
}

function renderSaleAudit() {
  const panel = document.querySelector("#sale-audit-panel");
  const box = document.querySelector("#sale-audit");
  const allowed = can("sell") || can("admin");
  if (panel && !allowed) panel.hidden = true;
  if (box) {
    box.replaceChildren();
    if (allowed) box.append(saleAuditNode());
  }
  const stats = document.querySelector("#stats-sales");
  if (stats) {
    stats.replaceChildren();
    stats.append(saleAuditNode());
  }
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
  return ["Utilized", "Total", "Name", "Order number", "Code", "Email", "Locked", "Seen", "Status", "Entry pending", "Food pending", "Pending count", "Pending items", "Picked up items", "Scanned at"];
}

function sheetLine(row) {
  return [row.utilized, row.total, row.name, row.full, row.code, row.email, lockLabel(row.code), row.seen, row.status, row.entryPending, row.foodPending, row.pendingCount, row.pendingItems, row.pickedItems, row.scannedAt];
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

function downloadExcel() {
  const rows = statusGrid();
  const stamp = new Date().toISOString().slice(0, 10);
  if (typeof XLSX !== "undefined" && XLSX.utils && typeof XLSX.writeFile === "function" && typeof XLSX.utils.book_new === "function") {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Tickets");
    XLSX.writeFile(book, `ticket-status-${stamp}.xlsx`);
    sayExport("Excel file saved to Downloads.");
    return;
  }
  const table = rows.map((row) => `<tr>${row.map((cell) => `<td>${String(cell ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join("");
  const html = `<html><head><meta charset="utf-8"></head><body><table>${table}</table></body></html>`;
  const name = `ticket-status-${stamp}.xls`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([html], { type: "application/vnd.ms-excel" }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  sayExport(`Saved ${name} to your Downloads folder.`);
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

const githubTokenButton = document.querySelector("#save-github-token");
if (githubTokenButton) {
  githubTokenButton.addEventListener("click", () => {
    const value = document.querySelector("#github-token").value.trim();
    const message = document.querySelector("#admin-message");
    if (message) {
      message.hidden = false;
      message.textContent = value ? "GitHub save key saved on this phone." : "GitHub save key cleared on this phone.";
    }
    if (value) localStorage.setItem(storeKey("github-token"), value);
    else localStorage.removeItem(storeKey("github-token"));
    document.querySelector("#github-token").value = "";
  });
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
  localStorage.setItem(storeKey("record-url"), link);
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
  localStorage.setItem(storeKey("counter"), "entry");
  paintCounter();
  renderOrders();
});
document.querySelector("#counter-food").addEventListener("click", () => {
  localStorage.setItem(storeKey("counter"), "food");
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
function showNameSpinner() {
  for (const id of ["#orders", "#recent-orders"]) {
    const box = document.querySelector(id);
    if (!box || box.offsetParent === null) continue;
    box.replaceChildren();
    const status = document.createElement("p");
    status.className = "spinner-row";
    status.innerHTML = `<span class="spinner"></span><span class="load-timer">Loading names… 0s</span>`;
    box.append(status);
  }
}
document.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target && target.closest("button, .file-btn, a.text-button");
  if (!button || button.disabled) return;
  button.classList.add("pressed");
  window.setTimeout(() => button.classList.remove("pressed"), 220);
});
document.querySelector("#site-orders-search").addEventListener("input", () => {
  siteLetter = "";
  showNameSpinner();
  window.setTimeout(renderOrders, 40);
});
document.querySelector("#site-orders-search-btn").addEventListener("click", () => { runListSearch("#site-orders-search"); });
document.querySelector("#site-orders-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runListSearch("#site-orders-search");
});
document.querySelector("#main-page").addEventListener("click", closeTicket);
document.querySelector("#search-order").addEventListener("click", searchOrder);
document.querySelector("#entry-query").addEventListener("input", () => {
  entryLetter = "";
  renderEntries();
});
document.querySelector("#sold-query").addEventListener("input", () => {
  saleLetter = "";
  renderSoldQrs();
});
document.querySelector("#order-query").addEventListener("input", () => {
  deskLetter = "";
  showNameSpinner();
  window.setTimeout(renderOrders, 40);
});
document.querySelector("#order-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchOrder();
});
function printSheet() {
  document.body.dataset.print = "sheet";
  window.print();
  delete document.body.dataset.print;
}
document.querySelectorAll(".print-sheet").forEach((button) => {
  button.addEventListener("click", printSheet);
});
document.querySelector("#admin-print").addEventListener("click", printSheet);
function dayValue(day) {
  const input = document.querySelector(`.day-date[data-day="${day}"]`);
  return input ? input.value : "";
}

function dayOpen(day) {
  const input = document.querySelector(`.day-open[data-day="${day}"]`);
  return Boolean(input && input.checked);
}

function sayAdmin(text) {
  for (const id of ["#admin-note", "#admin-message"]) {
    const noteBox = document.querySelector(id);
    if (!noteBox) continue;
    noteBox.hidden = false;
    noteBox.textContent = text;
  }
}

document.querySelectorAll(".save-event-days").forEach((button) => {
  button.addEventListener("click", () => {
  const friday = dayValue("friday");
  const saturday = dayValue("saturday");
  const sunday = dayValue("sunday");
  const open = {
    friday: dayOpen("friday"),
    saturday: dayOpen("saturday"),
    sunday: dayOpen("sunday"),
  };
  if (![friday, saturday, sunday].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    sayAdmin("Choose a date for Friday, Saturday, and Sunday.");
    return;
  }
  if (!open.friday && !open.saturday && !open.sunday) {
    sayAdmin("Turn on at least one day.");
    return;
  }
  const applied = queueWrite((book) => {
    const skus = (book.eventDays && book.eventDays.skus) || storedSkuRows() || mergedSkus();
    book.eventDays = { friday, saturday, sunday, open, skus };
    const names = ["friday", "saturday", "sunday"].filter((day) => open[day]);
    return { write: true, book, message: `Open days saved: ${names.join(", ")}.` };
  });
  sayAdmin(applied.message);
  paintDemo();
  const person = catalogPerson(openedCode);
  if (person) paintOpen(person);
  });
});
function attachVoiceSearch(button, input, after) {
  if (!button || !input) return;
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  button.addEventListener("click", () => {
    if (!Speech) {
      const search = document.querySelector("#search-result");
      const noteBox = document.querySelector("#admin-note");
      const host = search && !workspace.hidden ? search : noteBox;
      if (host) {
        host.hidden = false;
        host.textContent = "Voice search needs Chrome or Edge, and permission to use the microphone.";
        host.className = "result pending";
      }
      return;
    }
    const recognition = new Speech();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognition.onresult = (event) => {
      const said = event.results && event.results[0] && event.results[0][0] ? event.results[0][0].transcript : "";
      if (!said) return;
      input.value = said;
      if (after) after();
      else input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    recognition.onend = () => {
      button.textContent = "Mic";
      button.classList.remove("is-on");
    };
    button.textContent = "Listening…";
    button.classList.add("is-on");
    try {
      recognition.start();
    } catch {
      button.textContent = "Mic";
      button.classList.remove("is-on");
    }
  });
}
attachVoiceSearch(document.querySelector("#voice-search"), document.querySelector("#order-query"), searchOrder);
attachVoiceSearch(document.querySelector("#site-voice-search"), document.querySelector("#site-orders-search"), () => {
  runListSearch("#site-orders-search");
});
document.querySelector("#refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#admin-refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#export-csv").addEventListener("click", exportStatus);
document.querySelector("#admin-export-csv").addEventListener("click", exportStatus);
document.querySelector("#download-xlsx").addEventListener("click", downloadExcel);
document.querySelector("#admin-download-xlsx").addEventListener("click", downloadExcel);
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
  const sheet = { orders, fileName: file.name, uploadedAt: new Date().toISOString(), epoch: (window.TicketCatalog && window.TicketCatalog.epoch) || "" };
  try { localStorage.setItem(storeKey("sheet"), JSON.stringify(sheet)); } catch { /* the Drive file still receives it */ }
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
function resetScans() {
  if (!canResetScans()) return;
  if (!window.confirm("Clean up all scans? This clears every scan, lock, and log. The order sheet stays.")) return;
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  queueWrite((book) => TicketLedger.cleanupAll(book, at, actor));
  openedCode = "";
  for (const id of ["#admin-note", "#admin-message"]) {
    const noteBox = document.querySelector(id);
    if (!noteBox) continue;
    noteBox.hidden = false;
    noteBox.textContent = "Cleanup sent. Scans reset after the save. The order sheet stays.";
  }
  renderOrders();
}
document.querySelector("#cleanup-all").addEventListener("click", resetScans);
document.querySelectorAll(".cleanup-scans").forEach((button) => {
  button.addEventListener("click", resetScans);
});
const createLoginForm = document.querySelector("#create-login");
if (createLoginForm) {
  createLoginForm.addEventListener("submit", (event) => { createLogin(event); });
  const newRole = createLoginForm.querySelector("#new-role");
  if (newRole) {
    newRole.addEventListener("change", () => {
      const next = defaultAbilities(newRole.value);
      createLoginForm.querySelectorAll("[data-ability]").forEach((input) => {
        input.checked = Boolean(next[input.dataset.ability]);
      });
    });
  }
}
function resetActivityLog() {
  if (!canResetScans()) return;
  if (!window.confirm("Reset the log? Past actions are removed from this phone and the shared record. Scans and the order sheet stay.")) return;
  localStorage.removeItem(storeKey("local-log"));
  const at = new Date().toISOString();
  queueWrite((book) => TicketLedger.resetLog(book, at));
  for (const id of ["#admin-note", "#admin-message"]) {
    const noteBox = document.querySelector(id);
    if (!noteBox) continue;
    noteBox.hidden = false;
    noteBox.textContent = "Log reset sent. Past actions are cleared after the save.";
  }
  renderOrders();
}

document.querySelectorAll(".reset-log").forEach((button) => {
  button.addEventListener("click", resetActivityLog);
});
async function clearAndStart() {
  const sure = window.confirm("Clear all data and start over? This clears every scan, lock, log, walk-up sale, dispute, and uploaded order sheet on every phone. Logins stay. The order list saved in the website comes back. This cannot be undone.");
  if (!sure) return;
  if (!window.confirm("Clear the tracker now?")) return;
  localStorage.removeItem(storeKey("sheet"));
  localStorage.removeItem(storeKey("local-log"));
  localStorage.removeItem(storeKey("book-cache"));
  localStorage.removeItem(storeKey("skus"));
  for (const day of ["friday", "saturday", "sunday"]) {
    document.querySelectorAll(`.day-date[data-day="${day}"]`).forEach((input) => { input.value = DEFAULT_EVENT_DAYS[day]; });
    document.querySelectorAll(`.day-open[data-day="${day}"]`).forEach((input) => { input.checked = true; });
  }
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  queueWrite((book) => TicketLedger.factoryReset(book, at, actor));
  await flushWrites();
  const starter = ((window.TicketCatalog && window.TicketCatalog.skus) || []).map(normalizeSku).filter(Boolean);
  queueWrite((book) => {
    book.eventDays = {
      ...DEFAULT_EVENT_DAYS,
      open: { friday: true, saturday: true, sunday: true },
      skus: starter,
    };
    book.skus = starter;
    return { write: true, book, message: "Cleared. Friday, Saturday, and Sunday are open." };
  });
  await flushWrites();
  openedCode = "";
  skuStamp = "";
  showedCache = true;
  paintDemo();
  for (const id of ["#admin-note", "#admin-message"]) {
    const noteBox = document.querySelector(id);
    if (!noteBox) continue;
    noteBox.hidden = false;
    noteBox.textContent = "Cleared. The website order list is back. Friday, Saturday, and Sunday are open. New sales start from here.";
  }
  renderOrders();
  renderSkus();
}

document.querySelectorAll(".factory-reset").forEach((button) => {
  button.addEventListener("click", () => { clearAndStart(); });
});

setInterval(() => {
  if (document.hidden || !readSession() || flushing || pendingWrites.length) return;
  refreshOrders();
}, 10000);

function showWorkspacePage(page) {
  document.querySelectorAll("[data-page]").forEach((item) => {
    item.className = item.getAttribute("data-page") === page ? "btn-teal" : "btn-quiet";
  });
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    const pageOk = panel.getAttribute("data-page-panel") === page;
    const tool = panel.getAttribute("data-tool-panel");
    panel.hidden = !pageOk || Boolean(tool && tool !== toolTab);
  });
  document.querySelectorAll("[data-tool]").forEach((item) => {
    item.className = item.getAttribute("data-tool") === toolTab ? "btn-teal" : "btn-quiet";
  });
  const back = document.querySelector("#workspace-back");
  if (back) back.hidden = page === "desk";
}

function showSitePage(tab) {
  siteTab = tab || "orders";
  document.querySelectorAll("[data-site-tab]").forEach((item) => {
    item.className = item.getAttribute("data-site-tab") === siteTab ? "btn-teal" : "btn-quiet";
  });
  document.querySelectorAll("#admin-screen [data-site-panel]").forEach((panel) => {
    panel.hidden = panel.getAttribute("data-site-panel") !== siteTab;
  });
  if (siteTab === "logins") renderLogins();
  const back = document.querySelector("#site-back");
  if (back) back.hidden = siteTab === "orders";
}

const workspaceBack = document.querySelector("#workspace-back");
if (workspaceBack) workspaceBack.addEventListener("click", () => { showWorkspacePage("desk"); });
const siteBack = document.querySelector("#site-back");
if (siteBack) siteBack.addEventListener("click", () => { showSitePage("orders"); });
document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    showWorkspacePage(button.getAttribute("data-page"));
  });
});
document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    toolTab = button.getAttribute("data-tool") || "sheet";
    showWorkspacePage("admin");
  });
});
document.querySelectorAll("[data-site-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    showSitePage(button.getAttribute("data-site-tab"));
  });
});
document.querySelector("#home-save-qr").addEventListener("click", () => { saveQrImage(); });
document.querySelector("#home-whatsapp").addEventListener("click", () => { shareQrImage("whatsapp"); });
document.querySelector("#home-email-qr").addEventListener("click", () => { shareQrImage("email"); });
document.querySelector("#export-stats").addEventListener("click", exportStats);
document.querySelector("#new-sale").addEventListener("click", openSale);
document.querySelector("#sale-back").addEventListener("click", () => show(workspace));
document.querySelector("#sale-name").addEventListener("input", paintCart);
document.querySelector("#sale-submit").addEventListener("click", submitSale);
const saleCancel = document.querySelector("#sale-cancel");
if (saleCancel) {
  saleCancel.addEventListener("click", () => {
    editingSaleCode = "";
    cart = [];
    saleCancel.hidden = true;
    const submit = document.querySelector("#sale-submit");
    if (submit) submit.textContent = "Create QR";
    show(workspace);
    renderOrders();
  });
}
const saleNoEmail = document.querySelector("#sale-no-email");
if (saleNoEmail) {
  saleNoEmail.addEventListener("change", () => {
    const email = document.querySelector("#sale-email");
    if (!email) return;
    email.disabled = saleNoEmail.checked;
    if (saleNoEmail.checked) email.value = "";
  });
}
document.querySelector("#print-ticket").addEventListener("click", printTicket);
document.querySelector("#bluetooth-print").addEventListener("click", () => { bluetoothPrint(); });
document.querySelector("#share-ticket").addEventListener("click", () => { shareTicket(); });
document.querySelector("#screenshot-qr").addEventListener("click", () => { saveQrImage(); });
document.querySelector("#whatsapp-share").addEventListener("click", () => { shareQrImage("whatsapp"); });
document.querySelector("#email-share").addEventListener("click", () => { shareQrImage("email"); });

document.querySelector("#show-colors").addEventListener("click", () => {
  const key = document.querySelector(".legend");
  if (key) key.classList.toggle("is-open");
});
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

window.setInterval(() => {
  const button = document.querySelector("#revert-last");
  if (!button || !openedCode || !isVolunteer()) return;
  const left = volunteerRevertLeft(openedCode);
  button.disabled = left <= 0;
  button.textContent = left > 0 ? `Revert last (${Math.ceil(left / 1000)}s)` : "Revert closed";
}, 1000);

document.querySelectorAll(".sku-form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!can("admin")) return;
    const name = form.querySelector(".sku-name").value;
    const day = form.querySelector(".sku-day").value;
    const lane = form.querySelector(".sku-lane").value;
    const clean = normalizeSku({ name, day, lane, enabled: true });
    const noteBox = form.parentElement && form.parentElement.querySelector(".sku-note");
    if (!clean) {
      if (noteBox) {
        noteBox.hidden = false;
        noteBox.textContent = "Enter a ticket name and a day.";
      }
      return;
    }
    const next = mergedSkus().filter((sku) => sku.id !== clean.id);
    next.push(clean);
    form.querySelector(".sku-name").value = "";
    persistSkus(next, `${clean.name} is on for ${clean.day}.`);
  });
});
document.querySelectorAll(".close-day").forEach((button) => {
  button.addEventListener("click", () => {
    if (!can("admin")) return;
    const day = button.getAttribute("data-day");
    const label = day ? day.charAt(0).toUpperCase() + day.slice(1) : "That day";
    if (!window.confirm(`Close all ${label} sales? ${label} tickets cannot be sold or scanned until you open that day again.`)) return;
    setDaysOpen({ [day]: false }, `${label} sales are closed.`);
  });
});
document.querySelectorAll(".open-all-days").forEach((button) => {
  button.addEventListener("click", () => {
    if (!can("admin")) return;
    setDaysOpen({ friday: true, saturday: true, sunday: true }, "Friday, Saturday, and Sunday are open.");
  });
});
document.querySelectorAll(".show-pay").forEach((button) => {
  button.addEventListener("click", () => {
    const pay = document.querySelector("#pay-screen");
    if (pay) pay.hidden = false;
  });
});
const payClose = document.querySelector("#pay-close");
if (payClose) payClose.addEventListener("click", () => {
  const pay = document.querySelector("#pay-screen");
  if (pay) pay.hidden = true;
});

async function startApp() {
  await loadPackagedLive();
  restoreCachedBook();
  paintDemo();
  show(gate);
  if (readSession()) enterApp();
}
startApp();
