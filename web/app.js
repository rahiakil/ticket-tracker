const config = window.TICKET_TRACKER_CONFIG || { publicPageUrl: "" };
const USERNAME = "siteadmin";
const PASSWORD_SHA256 = "4b4d84a924bee4381c8cba1badfe3aa96cd7746ec02e36f862fab18caf42dafc";
const SESSION_KEY = "ticket-tracker-session";
const SESSION_MS = 3 * 24 * 60 * 60 * 1000;

const gate = document.querySelector("#gate");
const login = document.querySelector("#login");
const workspace = document.querySelector("#workspace");
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
    if (!saved || saved.username !== USERNAME || typeof saved.exp !== "number" || saved.exp <= Date.now()) return null;
    return saved;
  } catch {
    return null;
  }
}

function enterApp() {
  document.querySelector("#who").textContent = `Signed in as ${USERNAME}`;
  show(workspace);
  refreshOrders();
}

document.querySelector("#show-login").addEventListener("click", () => {
  show(login);
  document.querySelector("#username").focus();
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
    const accepted = username === USERNAME && sameText(digest, PASSWORD_SHA256);
    if (!accepted) {
      error.hidden = false;
      error.textContent = "Incorrect username or password.";
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: USERNAME, exp: Date.now() + SESSION_MS }));
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

function remoteOptions() {
  return {
    token: config.githubToken || localStorage.getItem("ticket-tracker-data-token") || "",
    repo: config.dataRepo || "rahiakil/ticket-tracker-data",
    file: config.dataFile || "scans.txt",
    branch: "main",
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
  const saved = await TicketLedger.commitRemote(remoteOptions(), (book) => {
    const at = new Date().toISOString();
    const next = TicketLedger.rememberScan(book, parsed, at, USERNAME);
    const order = next.book.orders[parsed.orderId];
    return {
      write: next.changed,
      book: next.book,
      message: `Order ${parsed.orderId}. ${TicketLedger.statusOf(order)}`,
      commitMessage: `Scan order ${parsed.orderId}`,
    };
  });
  if (!saved.ok) {
    showMessage("Could not save—retry", "save_failed");
    return;
  }
  currentBook = saved.book;
  showMessage(saved.message, TicketLedger.statusOf(saved.book.orders[parsed.orderId]) === "Taken" ? "recorded" : "pending");
  renderOrders();
}

retryButton.addEventListener("click", () => { if (!scanLock) submitAttempt(); });

document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
window.addEventListener("pagehide", () => { stopCamera(); });

function renderOrders() {
  const orders = document.querySelector("#orders");
  orders.replaceChildren();
  const rows = TicketLedger.summary(currentBook);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.textContent = "No orders scanned yet.";
    orders.append(empty);
    return;
  }
  for (const order of rows) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("p");
    title.textContent = `Order ${order.orderId}`;
    const status = document.createElement("p");
    status.className = order.status === "Taken" ? "seen" : "unseen";
    status.textContent = order.status;
    card.append(title, status);
    for (const variant of order.variants) {
      const line = document.createElement("p");
      line.textContent = `Variant ${variant.id}: ${variant.taken ? "taken" : "not taken"}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = variant.taken ? "Mark not taken" : "Mark taken";
      button.addEventListener("click", () => setVariant(order.orderId, variant.id, !variant.taken));
      card.append(line, button);
    }
    orders.append(card);
  }
}

async function setVariant(orderId, variantId, taken) {
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = "Saving…";
  const saved = await TicketLedger.commitRemote(remoteOptions(), (book) => {
    const next = TicketLedger.markTaken(book, orderId, variantId, taken, new Date().toISOString(), USERNAME);
    const order = next.book.orders[orderId];
    return {
      write: next.changed,
      book: next.book,
      message: order ? TicketLedger.statusOf(order) : "Could not save—retry",
      commitMessage: `Update order ${orderId} variant ${variantId}`,
    };
  });
  message.textContent = saved.ok ? saved.message : "Could not save—retry";
  if (saved.ok) {
    currentBook = saved.book;
    renderOrders();
  }
}

async function refreshOrders() {
  const options = remoteOptions();
  if (!options.token) return;
  const loaded = await TicketLedger.commitRemote(options, (book) => ({
    write: false,
    book,
    message: "",
    commitMessage: "",
  }));
  if (loaded.ok) {
    currentBook = loaded.book;
    renderOrders();
  }
}

document.querySelector("#save-token").addEventListener("click", () => {
  const value = document.querySelector("#data-token").value.trim();
  document.querySelector("#data-token").value = "";
  if (!value) return;
  localStorage.setItem("ticket-tracker-data-token", value);
  document.querySelector("#admin-message").hidden = false;
  document.querySelector("#admin-message").textContent = "Token saved on this phone.";
  refreshOrders();
});

document.querySelector("#refresh").addEventListener("click", () => { refreshOrders(); });

show(gate);
if (readSession()) enterApp();
