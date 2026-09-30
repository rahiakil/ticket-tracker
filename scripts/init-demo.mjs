import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import { emptyState } from "../src/logic.mjs";
import { hashPassword } from "../src/passwords.mjs";

const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;
const username = (process.argv[2] || "").trim();
const password = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!USER_RE.test(username) || !password) {
  console.error("Usage: node scripts/init-demo.mjs \"Ada Admin\" < password.txt");
  process.exit(1);
}
const directory = path.resolve("data-local");
await mkdir(directory, { recursive: true });
const now = new Date().toISOString();
const users = {
  schemaVersion: 1,
  users: [{
    username,
    role: "admin",
    passwordHash: await hashPassword(password),
    createdAt: now,
    mustChangePassword: true,
  }],
};
await writeFile(path.join(directory, "users.json"), `${JSON.stringify(users, null, 2)}\n`);
await writeFile(path.join(directory, "event-state.json"), `${JSON.stringify(emptyState(now), null, 2)}\n`);
console.log("Demo mode — wrote data-local/. These files stay on this computer and are not the live event record.");
