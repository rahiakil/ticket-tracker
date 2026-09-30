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
let currentBook = TicketLedger.emptyBook();

function show(view) {
  gate.hidden = view !== gate;
  login.hidden = view !== login;
  workspace.hidden = view !== workspace;
  adminScreen.hidden = view !== adminScreen;
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

async function submitAttempt() {
  if (!lastAttempt) return;
  const parsed = TicketLedger.parseQr(lastAttempt.raw);
  if (!parsed) {
    showMessage("Invalid QR", "invalid");
    return;
  }
  resultEl.textContent = "Saving…";
  resultEl.className = "result pending";
  retryButton.hidden = true;
  const saved = await TicketRecord.commit(recordOptions(), (book) => {
    const at = new Date().toISOString();
    const next = TicketLedger.rememberScan(book, parsed, at, readSession()?.username || "siteadmin");
    next.book.baseWriteId = book.lastWriteId || "";
    const order = next.book.orders[parsed.orderId];
    const detail = TicketLedger.statusDetail(order);
    return {
      write: next.changed,
      book: next.book,
      message: next.already ? `Order ${parsed.orderId} already scanned. ${detail}` : `Order ${parsed.orderId}. ${detail}`,
      commitMessage: `Scan order ${parsed.orderId}`,
    };
  });
  if (!saved.ok) {
    note(saved.message || "Could not save—retry");
    showMessage(saved.message || "Could not save—retry", "save_failed");
    return;
  }
  currentBook = saved.book;
  const already = String(saved.message || "").includes("already scanned");
  showMessage(saved.message, already ? "already_seen" : "pending");
  renderOrders();
}

retryButton.addEventListener("click", () => { if (!scanLock) submitAttempt(); });

document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
window.addEventListener("pagehide", () => { stopCamera(); });

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

function renderOrders() {
  const counts = TicketLedger.countsOf(currentBook);
  document.querySelector("#people-count").textContent = String(counts.peopleScanned);
  const siteCount = document.querySelector("#site-people-count");
  if (siteCount) siteCount.textContent = String(counts.peopleScanned);
  const variantList = document.querySelector("#variant-counts");
  variantList.replaceChildren();
  const variantIds = Object.keys(counts.variants).sort((left, right) => Number(left) - Number(right));
  if (!variantIds.length) {
    const empty = document.createElement("p");
    empty.textContent = "No variant IDs yet.";
    variantList.append(empty);
  }
  for (const id of variantIds) {
    const item = counts.variants[id];
    const line = document.createElement("p");
    line.textContent = `Variant ${id}: ${item.orders} people`;
    variantList.append(line);
  }
  const orders = document.querySelector("#orders");
  orders.replaceChildren();
  const rows = TicketLedger.summary(currentBook);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No orders scanned yet.";
    orders.append(empty);
    return;
  }
  for (const order of rows) orders.append(orderCard(order));
  renderLog();
  renderRecent();
}

function orderCard(order) {
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("p");
  title.textContent = `Order ${order.orderId}`;
  const status = document.createElement("p");
  status.className = order.status === "Taken" ? "seen" : "unseen";
  status.textContent = order.detail || order.status;
  const row = document.createElement("div");
  row.className = "taken-row";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = String(order.total);
  input.inputMode = "numeric";
  input.value = String(order.taken);
  input.setAttribute("aria-label", `How many taken for order ${order.orderId}`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Save picked up";
  button.addEventListener("click", () => saveTaken(order.orderId, input.value));
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "text-button";
  expand.textContent = "Show variants";
  const list = document.createElement("p");
  list.className = "variant-list";
  list.hidden = true;
  list.textContent = order.variants.map((variant) => variant.id).join(", ");
  expand.addEventListener("click", () => {
    list.hidden = !list.hidden;
    expand.textContent = list.hidden ? "Show variants" : "Hide variants";
  });
  row.append(input, button);
  card.append(title, status, row, expand, list);
  return card;
}

function renderRecent() {
  const box = document.querySelector("#recent-orders");
  if (!box) return;
  box.replaceChildren();
  const rows = TicketLedger.summary(currentBook).slice(0, 30);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No recent scans.";
    box.append(empty);
    return;
  }
  for (const order of rows) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("p");
    title.textContent = `Order ${order.orderId}`;
    const status = document.createElement("p");
    status.textContent = order.detail || order.status;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Delete";
    button.addEventListener("click", () => deleteRecent(order.orderId));
    card.append(title, status, button);
    box.append(card);
  }
}

async function saveTaken(orderId, rawCount) {
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = "Saving…";
  const saved = await TicketRecord.commit(recordOptions(), (book) => {
    const next = TicketLedger.setTakenCount(book, orderId, rawCount, new Date().toISOString(), readSession()?.username || "siteadmin");
    next.book.baseWriteId = book.lastWriteId || "";
    const order = next.book.orders[orderId];
    return {
      write: next.changed,
      book: next.book,
      message: order ? TicketLedger.statusDetail(order) : "Could not save—retry",
      commitMessage: `Update taken count for order ${orderId}`,
    };
  });
  message.textContent = saved.ok ? saved.message : (saved.message || "Could not save—retry");
  if (!saved.ok) note(message.textContent);
  if (saved.ok) {
    currentBook = saved.book;
    renderOrders();
  }
}

async function deleteRecent(orderId) {
  const message = document.querySelector("#admin-note");
  message.hidden = false;
  message.textContent = "Saving…";
  const saved = await TicketRecord.commit(recordOptions(), (book) => {
    const next = TicketLedger.deleteOrder(book, orderId, new Date().toISOString(), "admin");
    next.book.baseWriteId = book.lastWriteId || "";
    return {
      write: next.changed,
      book: next.book,
      message: `Order ${orderId} deleted`,
      commitMessage: `Delete order ${orderId}`,
    };
  });
  message.textContent = saved.ok ? saved.message : (saved.message || "Could not save—retry");
  if (!saved.ok) note(message.textContent);
  if (saved.ok) {
    currentBook = saved.book;
    renderOrders();
  }
}

async function refreshOrders() {
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
  renderOrders();
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

document.querySelector("#refresh").addEventListener("click", () => { refreshOrders(); });
document.querySelector("#admin-refresh").addEventListener("click", () => { refreshOrders(); });

show(gate);
if (readSession()) enterApp();
