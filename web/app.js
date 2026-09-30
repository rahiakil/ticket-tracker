const config = window.TICKET_TRACKER_CONFIG || { apiBase: "", publicPageUrl: "" };
const CODE_RE = /^[A-Za-z0-9_-]{22,80}$/;
const OUTCOMES = {
  recorded: "Recorded",
  already_seen: "Already seen",
  invalid: "Invalid code",
  save_failed: "Could not save—retry",
  closed: "Event closed",
};

const gate = document.querySelector("#gate");
const login = document.querySelector("#login");
const changeView = document.querySelector("#change-password");
const workspace = document.querySelector("#workspace");
const resultEl = document.querySelector("#result");
const retryButton = document.querySelector("#retry");
const reader = document.querySelector("#reader");
const fileReader = document.querySelector("#file-reader");
const cameraHelp = document.querySelector("#camera-help");
const scanButton = document.querySelector("#scan-btn");
const cancelButton = document.querySelector("#cancel-scan");
const confirmPanel = document.querySelector("#confirm");
const dialog = document.querySelector("#dialog");

let csrfToken = "";
let scanLock = false;
let scanGeneration = 0;
let camera = null;
let cameraOn = false;
let lastAttempt = null;
let eventStatus = "open";

function apiUrl(path) {
  const base = String(config.apiBase || "").replace(/\/$/, "");
  return `${base}${path}`;
}

function show(view) {
  gate.hidden = view !== gate;
  login.hidden = view !== login;
  changeView.hidden = view !== changeView;
  workspace.hidden = view !== workspace;
}

function showGate() {
  csrfToken = "";
  stopCamera();
  show(gate);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    credentials: "include",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });
  const data = await response.clone().json().catch(() => null);
  if (response.status === 401 && path !== "/api/login" && path !== "/api/password") showGate();
  return { response, data };
}

function applySession(data) {
  csrfToken = data.csrfToken || "";
  document.querySelector("#who").textContent = `Signed in as ${data.username}`;
  document.querySelector("#demo-banner").hidden = !data.demo;
  if (data.mustChangePassword) {
    show(changeView);
    return;
  }
  show(workspace);
  showDeepLink();
  loadAdmin();
}

async function restoreSession() {
  try {
    const { response, data } = await api("/api/session");
    if (response.ok && data?.authenticated) applySession(data);
  } catch {
    showGate();
  }
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
  try {
    const { response, data } = await api("/api/login", {
      method: "POST",
      json: {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      },
    });
    document.querySelector("#password").value = "";
    if (!response.ok || !data?.ok) {
      error.hidden = false;
      error.textContent = data?.message || "The sign-in service is not connected yet.";
      return;
    }
    applySession(data);
  } catch {
    error.hidden = false;
    error.textContent = "The sign-in service is not connected yet.";
  } finally {
    button.disabled = false;
  }
});

async function logout() {
  try {
    await api("/api/logout", { method: "POST", json: {} });
  } catch {
    // Clearing the screen still ends the visit on this phone.
  }
  showGate();
}

document.querySelector("#logout").addEventListener("click", logout);
document.querySelector("#change-logout").addEventListener("click", logout);

async function changePassword(currentPassword, newPassword, messageEl) {
  const { response, data } = await api("/api/password", {
    method: "POST",
    json: { currentPassword, newPassword },
  });
  messageEl.hidden = false;
  messageEl.className = `result ${response.ok ? "recorded" : "invalid"}`;
  messageEl.textContent = data?.message || "Could not save—retry";
  if (response.ok && data?.csrfToken) {
    csrfToken = data.csrfToken;
    if (!data.mustChangePassword) {
      show(workspace);
      showDeepLink();
      loadAdmin();
    }
  }
  return response.ok;
}

document.querySelector("#change-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await changePassword(
    document.querySelector("#current-password").value,
    document.querySelector("#new-password").value,
    document.querySelector("#change-message"),
  );
  if (ok) {
    document.querySelector("#current-password").value = "";
    document.querySelector("#new-password").value = "";
  }
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await changePassword(
    document.querySelector("#later-current").value,
    document.querySelector("#later-new").value,
    document.querySelector("#admin-message"),
  );
  if (ok) event.target.reset();
});

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

async function submitAttempt() {
  if (!lastAttempt) return;
  resultEl.textContent = "Saving…";
  resultEl.className = "result pending";
  retryButton.hidden = true;
  try {
    const { response, data } = await api("/api/scans", { method: "POST", json: lastAttempt });
    if (response.status === 401) return;
    if (!data || !data.outcome) {
      showOutcome("save_failed");
      return;
    }
    showOutcome(data.outcome, data.message);
    if (data.outcome === "recorded" || data.outcome === "already_seen") loadAdmin();
  } catch {
    showOutcome("save_failed");
  }
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
    qr.addEventListener("click", () => download(`/api/codes/${code.id}/qr.svg`, `${code.id}.svg`));
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

async function loadAdmin() {
  const { response, data } = await api("/api/admin");
  if (response.ok && data?.ok) renderAdmin(data);
}

document.querySelector("#refresh").addEventListener("click", () => { loadAdmin(); });

async function markUnseen(code) {
  const answer = await ask("Mark this code as unseen?", true, "Mark as unseen");
  if (!answer) return;
  const { data } = await api("/api/unsee", {
    method: "POST",
    json: { code, reason: answer.reason, requestId: requestId() },
  });
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
  const { data } = await api("/api/event", { method: "POST", json: { status: next, requestId: requestId() } });
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = data?.message || "Could not save—retry";
  loadAdmin();
});

async function download(path, filename) {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (response.status === 401) { showGate(); return; }
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.querySelector("#download-json").addEventListener("click", () => download("/api/report.json", "ticket-tracker-report.json"));
document.querySelector("#download-csv").addEventListener("click", () => download("/api/report.csv", "ticket-tracker-report.csv"));

document.querySelector("#issue-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const count = Number(document.querySelector("#issue-count").value);
  const { data, response } = await api("/api/codes", {
    method: "POST",
    json: { count, requestId: requestId() },
  });
  const message = document.querySelector("#admin-message");
  message.hidden = false;
  message.textContent = data?.message || "Could not save—retry";
  if (!response.ok || !data?.codes) return;
  const sheet = document.querySelector("#sheet");
  sheet.replaceChildren();
  const downloadSheet = document.createElement("button");
  downloadSheet.type = "button";
  downloadSheet.className = "secondary";
  downloadSheet.textContent = "Download printable sheet";
  downloadSheet.addEventListener("click", () => {
    const html = `<!DOCTYPE html><meta charset="utf-8"><title>Ticket Tracker QR codes</title>${data.codes.map((code) => (
      code.svg.includes("<svg") ? `<section>${code.svg}<p>${code.url.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p></section>` : ""
    )).join("")}`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ticket-tracker-qr-sheet.html";
    link.click();
    URL.revokeObjectURL(url);
  });
  sheet.append(downloadSheet);
  loadAdmin();
});

show(gate);
restoreSession();
