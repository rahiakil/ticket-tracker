import fs from "node:fs";
import { hashPassword } from "../src/passwords.mjs";
import { emptyUsers } from "../src/logic.mjs";

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const username = arg("--username").trim();
const role = arg("--role") || "admin";
const file = arg("--file");
const password = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");

if (!file || !USER_RE.test(username) || (role !== "admin" && role !== "scanner") || !password) {
  console.error("Usage: node scripts/upsert-user.mjs --file users.json --username \"Ada Admin\" --role admin < password.txt");
  process.exit(1);
}

const document = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : emptyUsers();
if (document.schemaVersion !== 1 || !Array.isArray(document.users)) {
  console.error("users.json must use schemaVersion 1.");
  process.exit(1);
}
const now = new Date().toISOString();
const passwordHash = await hashPassword(password);
const existing = document.users.find((user) => user.username === username);
if (existing) {
  existing.passwordHash = passwordHash;
  existing.role = role;
  existing.passwordChangedAt = now;
  existing.mustChangePassword = process.argv.includes("--must-change");
} else {
  document.users.push({
    username,
    role,
    passwordHash,
    createdAt: now,
    mustChangePassword: process.argv.includes("--must-change"),
  });
}
fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Updated ${username} in ${file}. Commit that file only in the private data repository.`);
