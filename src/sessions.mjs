import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual, timingSafeEqualText } from "./encoding.mjs";

const textEncoder = new TextEncoder();
const SESSION_MS = 8 * 60 * 60 * 1000;

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return new Uint8Array(signature);
}

export async function createSession(secret, user, now) {
  const csrfBytes = new Uint8Array(32);
  crypto.getRandomValues(csrfBytes);
  const payload = {
    u: user.username,
    r: user.role,
    exp: now + SESSION_MS,
    csrf: bytesToBase64Url(csrfBytes),
    mcp: user.mustChangePassword ? 1 : 0,
  };
  const body = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmac(secret, body));
  return { token: `${body}.${signature}`, csrfToken: payload.csrf, expiresAt: payload.exp };
}

export async function readSession(secret, token, now) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!body || !signature || token.slice(dot + 1).includes(".")) return null;
  let expected;
  try {
    expected = await hmac(secret, body);
  } catch {
    return null;
  }
  let actual;
  try {
    actual = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  if (!timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    if (!payload || typeof payload.u !== "string" || typeof payload.r !== "string") return null;
    if (typeof payload.csrf !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= now) return null;
    return {
      username: payload.u,
      role: payload.r,
      csrfToken: payload.csrf,
      expiresAt: payload.exp,
      mustChangePassword: payload.mcp === 1,
    };
  } catch {
    return null;
  }
}

export function csrfMatches(session, header) {
  if (!session) return false;
  return timingSafeEqualText(session.csrfToken, header || "");
}

export function sessionCookie(token, { maxAge, secure, sameSite }) {
  const parts = [`tt_session=${token}`, "HttpOnly", "Path=/", `SameSite=${sameSite}`, `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie({ secure, sameSite }) {
  return sessionCookie("", { maxAge: 0, secure, sameSite });
}

export function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export const SESSION_MAX_AGE = Math.floor(SESSION_MS / 1000);
