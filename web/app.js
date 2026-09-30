const config = window.TICKET_TRACKER_CONFIG || { publicPageUrl: "" };
const CODE_RE = /^[A-Za-z0-9_-]{22,80}$/;
const USERNAME = "siteadmin";
const PASSWORD_SHA256 = "4b4d84a924bee4381c8cba1badfe3aa96cd7746ec02e36f862fab18caf42dafc";
const SESSION_KEY = "ticket-tracker-session";
const SESSION_MS = 3 * 24 * 60 * 60 * 1000;
const OUTCOMES = {
  recorded: "Recorded",
  already_seen: "Already seen",
  invalid: "Invalid code",
  save_failed: "Could not save—retry",
  closed: "Event closed",
};

const gate = document.querySelector("#gate");
const login = document.querySelector("#login");
const workspace = document.querySelector("#workspace");
const ledger = TicketLedger.openLedger(localStorage);
const resultEl = document.querySelector("#result");
const retryButton = document.querySelector("#retry");
const reader = document.querySelector("#reader");
const fileReader = document.querySelector("#file-reader");
const cameraHelp = document.querySelector("#camera-help");
const scanButton = document.querySelector("#scan-btn");
const cancelButton = document.querySelector("#cancel-scan");
const confirmPanel = document.querySelector("#confirm");
const dialog = document.querySelector("#dialog");

let scanLock = false;
let scanGeneration = 0;
let camera = null;
let cameraOn = false;
let lastAttempt = null;
let eventStatus = "open";

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
  showDeepLink();
  loadAdmin();
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
  if (eventStatus !== "open" || cameraOn || scanLock) return;
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
    lastAttempt = { raw: text, requestId: requestId() };
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
  if (!file || scanLock || eventStatus !== "open") return;
  const Scanner = library();
  if (!Scanner) return;
  scanLock = true;
  await stopCamera();
  const scanner = new Scanner("file-reader", { verbose: false });
  try {
    const text = await scanner.scanFile(file, false);
    try { await scanner.clear(); } catch { /* no preview to clear */ }
    lastAttempt = { raw: text, requestId: requestId() };
    await submitAttempt();
  } catch {
    showOutcome("invalid", "Could not read a QR code from that image.");
  } finally {
    scanLock = false;
  }
});

function showDeepLink() {
  const code = new URLSearchParams(location.search).get("c") || "";
  const usable = CODE_RE.test(code) && eventStatus === "open";
  confirmPanel.hidden = !usable;
}

document.querySelector("#confirm-seen").addEventListener("click", () => {
  const code = new URLSearchParams(location.search).get("c") || "";
  if (!CODE_RE.test(code) || scanLock) return;
  let raw = code;
  try {
    const url = new URL(config.publicPageUrl);
    url.searchParams.set("c", code);
    url.hash = "";
    raw = url.toString();
  } catch {
    raw = code;
  }
  lastAttempt = { raw, requestId: requestId() };
  submitAttempt();
});

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function showOutcome(outcome, message) {
  const unreadable = message === "Could not read a QR code from that image.";
  resultEl.textContent = unreadable ? message : (OUTCOMES[outcome] || OUTCOMES.save_failed);
  resultEl.className = `result ${OUTCOMES[outcome] ? outcome : "save_failed"}`;
  retryButton.hidden = outcome !== "save_failed";
}

function submitAttempt() {
  if (!lastAttempt) return;
  resultEl.textContent = "Saving…";
  resultEl.className = "result pending";
  retryButton.hidden = true;
  const data = ledger.scan(lastAttempt.raw, lastAttempt.requestId, USERNAME);
  if (!data || !data.outcome) {
    showOutcome("save_failed");
    return;
  }
  showOutcome(data.outcome, data.message);
  if (data.outcome === "recorded" || data.outcome === "already_seen") loadAdmin();
}

retryButton.addEventListener("click", () => { if (!scanLock) submitAttempt(); });

document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
window.addEventListener("pagehide", () => { stopCamera(); });

function ask(title, withReason, confirmLabel) {
  const titleEl = document.querySelector("#dialog-title");
  const reasonWrap = document.querySelector("#reason-wrap");
  const reason = document.querySelector("#reason");
  const confirmButton = document.querySelector("#dialog-confirm");
  const cancelButton = document.querySelector("#dialog-cancel");
  titleEl.textContent = title;
  confirmButton.textContent = confirmLabel;
  reasonWrap.hidden = !withReason;
  reason.value = "";
  dialog.hidden = false;
  return new Promise((resolve) => {
    const finish = (value) => {
      confirmButton.removeEventListener("click", onConfirm);
      cancelButton.removeEventListener("click", onCancel);
      dialog.hidden = true;
      resolve(value);
    };
    const onConfirm = () => finish({ reason: reason.value });
    const onCancel = () => finish(null);
    confirmButton.addEventListener("click", onConfirm);
    cancelButton.addEventListener("click", onCancel);
  });
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function renderAdmin(data) {
  eventStatus = data.event?.status || "open";
  const closed = eventStatus !== "open";
  document.querySelector("#closed-note").hidden = !closed;
  document.querySelector("#scan-btn").disabled = closed;
  document.querySelector("#confirm-seen").disabled = closed;
  document.querySelector("#event-toggle").textContent = closed ? "Open event" : "Close event";
  showDeepLink();
  const codes = document.querySelector("#codes");
  codes.replaceChildren();
  if (!data.codes?.length) {
    const empty = document.createElement("p");
    empty.textContent = "No QR codes issued yet.";
    codes.append(empty);
  }
  for (const code of data.codes || []) {
    const card = document.createElement("article");
    card.className = "card";
    const status = document.createElement("p");
    status.className = code.seen ? "seen" : "unseen";
    status.textContent = code.seen ? "Seen" : "Unseen";
    const id = document.createElement("p");
    id.textContent = code.id;
    const seen = document.createElement("p");
    seen.textContent = `First seen this cycle: ${formatTime(code.firstSeenAt)}`;
    card.append(status, id, seen);
    if (code.seen) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Mark as unseen";
      button.addEventListener("click", () => markUnseen(code.id));
      card.append(button);
    }
    const qr = document.createElement("button");
    qr.type = "button";
    qr.className = "secondary";
    qr.textContent = "Download QR";
    qr.addEventListener("click", () => saveFile(`${code.id}.svg`, TicketLedger.qrSvg(TicketLedger.codeUrl(code.id)), "image/svg+xml"));
    card.append(qr);
    codes.append(card);
  }
  const history = document.querySelector("#history");
  history.replaceChildren();
  if (!data.history?.length) {
    const empty = document.createElement("p");
    empty.textContent = "No activity yet.";
    history.append(empty);
  }
  for (const item of [...(data.history || [])].reverse()) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("p");
    title.textContent = historyLabel(item);
    const meta = document.createElement("p");
    meta.textContent = `${formatTime(item.at)} · ${item.actor || "system"}${item.code ? ` · ${item.code}` : ""}`;
    card.append(title, meta);
    if (item.reason) {
      const reason = document.createElement("p");
      reason.textContent = item.reason;
      card.append(reason);
    }
    history.append(card);
  }
}

function historyLabel(item) {
  if (item.type === "scan") return "Seen";
  if (item.type === "reversal") return "Marked unseen";
  if (item.type === "issue") return `Issued ${item.count} codes`;
  if (item.type === "event_status") return item.status === "closed" ? "Event closed" : "Event opened";
  return item.type || "Activity";
}

function loadAdmin() {
  const data = ledger.view();
  if (data) renderAdmin(data);
}

document.querySelector("#refresh").addEventListener("click", () => { loadAdmin(); });

async function markUnseen(code) {
  const answer = await ask("Mark this code as unseen?", true, "Mark as unseen");
  if (!answer) return;
  const data = ledger.unsee(code, requestId(), answer.reason, USERNAME);
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.className = "result pending";
  message.textContent = data?.message || "Could not save—retry";
  loadAdmin();
}

document.querySelector("#event-toggle").addEventListener("click", async () => {
  const next = eventStatus === "open" ? "closed" : "open";
  const answer = await ask(next === "closed" ? "Close the event to new scans?" : "Open the event to new scans?", false, next === "closed" ? "Close event" : "Open event");
  if (!answer) return;
  const data = ledger.setEvent(next, requestId(), USERNAME);
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = data?.message || "Could not save—retry";
  loadAdmin();
});

function saveFile(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.querySelector("#download-json").addEventListener("click", () => {
  const report = ledger.report();
  if (report) saveFile("ticket-tracker-report.json", report.json, "application/json");
});
document.querySelector("#download-csv").addEventListener("click", () => {
  const report = ledger.report();
  if (report) saveFile("ticket-tracker-report.csv", report.csv, "text/csv");
});

document.querySelector("#issue-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const count = Number(document.querySelector("#issue-count").value);
  const data = ledger.issue(count, requestId(), USERNAME);
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = data?.message || "Could not save—retry";
  if (!data?.ok || !data.codes) return;
  const cards = data.codes.map((id) => {
    const url = TicketLedger.codeUrl(id);
    const svg = TicketLedger.qrSvg(url);
    return { id, url, svg };
  });
  const sheet = document.querySelector("#sheet");
  sheet.replaceChildren();
  const downloadSheet = document.createElement("button");
  downloadSheet.type = "button";
  downloadSheet.className = "secondary";
  downloadSheet.textContent = "Download printable sheet";
  downloadSheet.addEventListener("click", () => {
    const html = `<!DOCTYPE html><meta charset="utf-8"><title>Ticket Tracker QR codes</title>${cards.map((code) => (
      code.svg.includes("<svg") ? `<section>${code.svg}<p>${code.url.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p></section>` : ""
    )).join("")}`;
    saveFile("ticket-tracker-qr-sheet.html", html, "text/html");
  });
  sheet.append(downloadSheet);
  loadAdmin();
});

show(gate);
if (readSession()) enterApp();
