import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = dirname(new URL("../package.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function args() {
  const out = { dates: [] };
  const list = process.argv.slice(2);
  for (let index = 0; index < list.length; index += 1) {
    const key = list[index];
    const value = list[index + 1];
    if (key === "--dates") {
      out.dates.push(value);
      index += 1;
    } else if (key === "--id") {
      out.id = value;
      index += 1;
    } else if (key === "--name") {
      out.name = value;
      index += 1;
    } else if (key === "--when") {
      out.when = value;
      index += 1;
    } else if (key === "--place") {
      out.place = value;
      index += 1;
    }
  }
  if (!out.id || !out.name || !out.when || !out.dates.length) {
    throw new Error("Use --id --name --when --dates YYYY-MM-DD");
  }
  return out;
}

function pacific(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type).value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const suffix = hour >= 12 ? "PM" : "AM";
  const clock = hour % 12 || 12;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: `${clock} ${suffix}`,
    hourSort: hour,
    time: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso)),
  };
}

function classify(text) {
  if (/food picked up/i.test(text) || (/reverted/i.test(text) && !/entry/i.test(text))) return "food";
  return "desk";
}

function actionOf(text) {
  if (/food picked up/i.test(text)) return "Food picked up";
  if (/reverted/i.test(text) && !/entry/i.test(text)) return "Food reverted";
  if (/scanned again/i.test(text)) return "Scanned again";
  if (/scanned at/i.test(text)) return "Scanned";
  if (/entry done/i.test(text)) return "Entry done";
  if (/reverted/i.test(text)) return "Entry reverted";
  if (/new sale/i.test(text)) return "New sale";
  if (/sale changed/i.test(text)) return "Sale changed";
  if (/Bhoomi book/i.test(text)) return "Bhoomi book";
  if (/cleared all scans/i.test(text)) return "Cleared practice scans";
  return "Desk note";
}

function codeOf(text) {
  const match = String(text).match(/^(\d{5})\b/);
  return match ? match[1] : "";
}

function itemOf(text) {
  const match = String(text).match(/(?:entry done|food picked up|reverted(?: Saturday| Sunday)?(?: entry)?): (.+) by /i);
  return match ? match[1] : "";
}

function staffOf(text) {
  const match = String(text).match(/ by (.+)$/);
  return match ? match[1] : "system";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function peopleMap() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(join(root, "web", "catalog.js"), "utf8"), context);
  const people = {};
  for (const person of Object.values(context.window.TicketCatalog.orders || {})) {
    people[person.code] = { name: person.name || "", email: person.email || "" };
  }
  return people;
}

const options = args();
const live = await (await fetch("https://ticket-tracker.uttoron-tickets.workers.dev/api/live")).json();
const book = live.book || { log: [], orders: {} };
const people = peopleMap();
for (const person of Object.values(book.walkups || {})) people[person.code] = { name: person.name || "", email: person.email || "" };
const wanted = new Set(options.dates);
const rows = [];
for (const item of book.log || []) {
  if (!item.at) continue;
  const when = pacific(item.at);
  if (!wanted.has(when.date)) continue;
  const text = String(item.text || "");
  const code = codeOf(text);
  const person = people[code] || {};
  rows.push({
    section: classify(text),
    action: actionOf(text),
    hour: when.hour,
    hourSort: when.hourSort,
    time: when.time,
    code,
    guest: person.name || "",
    email: person.email || "",
    item: itemOf(text),
    staff: staffOf(text),
    text,
  });
}
rows.sort((left, right) => left.hourSort - right.hourSort || left.guest.localeCompare(right.guest, undefined, { sensitivity: "base" }) || left.time.localeCompare(right.time));

const hours = new Map();
const staff = new Map();
for (const row of rows) {
  if (!hours.has(row.hour)) hours.set(row.hour, { hour: row.hour, desk: 0, food: 0, sort: row.hourSort });
  hours.get(row.hour)[row.section] += 1;
  if (!staff.has(row.staff)) staff.set(row.staff, { name: row.staff, desk: 0, food: 0 });
  staff.get(row.staff)[row.section] += 1;
}

const summary = {
  id: options.id,
  name: options.name,
  when: options.when,
  place: options.place || "",
  status: rows.length ? "closed" : "upcoming",
  note: rows.length ? "" : "This folder is ready. Analytics will be filed here when the event runs. Nothing is collected yet.",
  totals: {
    orders: 0,
    scans: new Set(rows.filter((row) => row.action.startsWith("Scanned")).map((row) => row.code)).size,
    desk: rows.filter((row) => row.section === "desk").length,
    food: rows.filter((row) => row.section === "food").length,
    entryMarked: rows.filter((row) => row.action === "Entry done").length,
    foodPicked: rows.filter((row) => row.action === "Food picked up").length,
  },
  hours: [...hours.values()].sort((left, right) => left.sort - right.sort).map(({ hour, desk, food }) => ({ hour, desk, food })),
  food: [],
  entry: [],
  staff: [...staff.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
};

const eventDir = join(root, "web", "archive", "events", options.id);
mkdirSync(eventDir, { recursive: true });
writeFileSync(join(eventDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const indexPath = join(root, "web", "archive", "events", "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const card = { id: options.id, name: options.name, when: options.when, status: summary.status, file: `${options.id}/summary.json` };
index.events = [card, ...(index.events || []).filter((event) => event.id !== options.id)];
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

const reportDir = join(root, "reports", options.id);
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const header = "Section,Hour,Time,Order,Name,Email,Action,Item,Staff";
function dump(section) {
  const lines = [header];
  for (const row of rows.filter((item) => item.section === section)) {
    lines.push([row.section, row.hour, row.time, row.code, row.guest, row.email, row.action, row.item, row.staff].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
writeFileSync(join(reportDir, "desk.csv"), dump("desk"));
writeFileSync(join(reportDir, "food.csv"), dump("food"));

console.log(JSON.stringify({
  id: options.id,
  status: summary.status,
  rows: rows.length,
  hours: summary.hours,
  site: `web/archive/events/${options.id}/summary.json`,
  driveFolder: `reports/${options.id}`,
}, null, 2));
