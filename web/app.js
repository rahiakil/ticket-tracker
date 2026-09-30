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

function submitAttempt() {
  if (!lastAttempt) return;
  const parsed = TicketLedger.parseQr(lastAttempt.raw);
  if (!parsed) {
    showMessage("Invalid QR", "invalid");
    return;
  }
  const at = new Date().toISOString();
  const actor = readSession()?.username || "admin";
  const applied = queueWrite((book) => {
    const next = TicketLedger.rememberScan(book, parsed, at, actor);
    const order = next.book.orders[parsed.orderId];
    const detail = TicketLedger.statusDetail(order);
    return {
      write: next.changed,
      book: next.book,
      message: next.already ? `Order ${parsed.orderId} already scanned. ${detail}` : `Order ${parsed.orderId}. ${detail}`,
    };
  });
  const already = String(applied.message || "").includes("already scanned");
  showMessage(applied.message, already ? "already_seen" : "pending");
  renderOrders();
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

function fillCount(id, value) {
  const node = document.querySelector(id);
  if (node) node.textContent = String(value);
}

function fillVariantCounts(elementId, counts) {
  const variantList = document.querySelector(elementId);
  if (!variantList) return;
  variantList.replaceChildren();
  const variantIds = Object.keys(counts.variants).sort((left, right) => Number(left) - Number(right));
  if (!variantIds.length) {
    const empty = document.createElement("p");
    empty.textContent = "No variant IDs yet.";
    variantList.append(empty);
    return;
  }
  for (const id of variantIds) {
    const item = counts.variants[id];
    const line = document.createElement("p");
    line.textContent = `Variant ${id}: ${item.orders} QR codes, ${item.taken} taken, ${item.notTaken} not taken`;
    variantList.append(line);
  }
}

function renderOrders() {
  const counts = TicketLedger.countsOf(currentBook);
  fillCount("#people-count", counts.peopleScanned);
  fillCount("#site-people-count", counts.peopleScanned);
  fillCount("#item-count", counts.itemTotal);
  fillCount("#site-item-count", counts.itemTotal);
  fillCount("#taken-count", counts.ticketsTaken);
  fillCount("#site-taken-count", counts.ticketsTaken);
  fillVariantCounts("#variant-counts", counts);
  fillVariantCounts("#site-variant-counts", counts);
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
  order.variants.forEach((variant, index) => {
    if (index > 0) list.append(", ");
    const part = document.createElement("span");
    part.textContent = variant.id;
    if (variant.taken) part.className = "taken-variant";
    list.append(part);
  });
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
