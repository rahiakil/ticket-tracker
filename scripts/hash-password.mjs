import fs from "node:fs";
import { hashPassword } from "../src/passwords.mjs";

const password = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!password) {
  console.error("Pipe the password on stdin. It is not saved by this command.");
  process.exit(1);
}
process.stdout.write(`${await hashPassword(password)}\n`);
