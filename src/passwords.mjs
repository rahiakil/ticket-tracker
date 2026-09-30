import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { timingSafeEqual } from "./encoding.mjs";

const N = 16384;
const R = 8;
const P = 1;
const DK_LEN = 32;
const HASH_RE = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/;

let fallbackHash = "";

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    throw new Error("Password must be 1 to 200 characters.");
  }
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, { N, r: R, p: P, dkLen: DK_LEN });
  return `scrypt$${N}$${R}$${P}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

export async function warmupPasswords() {
  if (!fallbackHash) fallbackHash = await hashPassword(bytesToHex(randomBytes(32)));
}

export async function verifyPassword(password, stored) {
  if (!fallbackHash) await warmupPasswords();
  if (typeof password !== "string" || password.length === 0 || password.length > 200) return false;
  const match = typeof stored === "string" ? HASH_RE.exec(stored) : null;
  const saltHex = match?.[1] ?? HASH_RE.exec(fallbackHash)[1];
  const expectedHex = match?.[2] ?? HASH_RE.exec(fallbackHash)[2];
  let actual;
  try {
    actual = await scryptAsync(password, hexToBytes(saltHex), { N, r: R, p: P, dkLen: DK_LEN });
  } catch {
    return false;
  }
  const matches = timingSafeEqual(actual, hexToBytes(expectedHex));
  return Boolean(match) && matches;
}

export async function authenticate(users, username, password) {
  if (!users || users.schemaVersion !== 1 || !Array.isArray(users.users)) return null;
  const user = users.users.find((item) => item.username === username);
  const stored = user?.passwordHash || fallbackHash;
  const passwordMatches = await verifyPassword(password, stored);
  if (!user || !passwordMatches) return null;
  if (user.role !== "admin" && user.role !== "scanner") return null;
  return { username: user.username, role: user.role, mustChangePassword: user.mustChangePassword === true };
}
