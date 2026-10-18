import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = dirname(new URL("../package.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = join(root, "web", "archive", "events");
const pacific = -7 * 60 * 60 * 1000;

function catalogOrders(file) {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(file, "utf8"), context);
  return context.window.TicketCatalog.orders || {};
}

function hourLabel(iso) {
  const date = new Date(new Date(iso).getTime() + pacific);
  const hour = date.getUTCHours();
  const suffix = hour >= 12 ? "PM" : "AM";
  const clock = hour % 12 || 12;
  return `${clock} ${suffix}`;
}

function hourSort(label) {
  const match = String(label).match(/^(\d+)\s+(AM|PM)$/);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[2] === "PM") hour += 12;
  return hour;
}

function classify(text) {
  if (/food picked up/i.test(text)) return "food";
  if (/reverted/i.test(text) && !/entry/i.test(text)) return "food";
  return "desk";
}

function staffOf(text) {
  const match = String(text).match(/ by (.+)$/);
  return match ? match[1] : "";
}

function summarizeLog(log) {
  const hours = new Map();
  const staff = new Map();
  let desk = 0;
  let food = 0;
  for (const item of log || []) {
    const text = String(item.text || "");
    const section = classify(text);
    if (section === "food") food += 1;
    else desk += 1;
    const label = hourLabel(item.at);
    if (!hours.has(label)) hours.set(label, { hour: label, desk: 0, food: 0 });
    hours.get(label)[section] += 1;
    const who = staffOf(text) || "system";
    if (!staff.has(who)) staff.set(who, { name: who, desk: 0, food: 0 });
    staff.get(who)[section] += 1;
  }
  return {
    desk,
    food,
    hours: [...hours.values()].sort((left, right) => hourSort(left.hour) - hourSort(right.hour)),
    staff: [...staff.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
  };
}

function summarizeItems(orders, book) {
  const bought = new Map();
  const picked = new Map();
  for (const person of Object.values(orders || {})) {
    for (const [index, item] of (person.items || []).entries()) {
      const qty = Number(item.qty) || 0;
      if (!qty) continue;
      const key = `${item.lane || "other"}:${item.name}`;
      bought.set(key, (bought.get(key) || 0) + qty);
      const saved = book && book.orders && book.orders[person.code];
      let taken = 0;
      for (let unit = 0; unit < qty; unit += 1) {
        const variant = saved && saved.variants && saved.variants[`item:${index}:${unit}:${item.name}`];
        if (variant && variant.taken) taken += 1;
      }
      picked.set(key, (picked.get(key) || 0) + taken);
    }
  }
  const rows = [...bought.entries()].map(([key, count]) => {
    const split = key.indexOf(":");
    return {
      lane: key.slice(0, split),
      name: key.slice(split + 1),
      bought: count,
      picked: picked.get(key) || 0,
      left: count - (picked.get(key) || 0),
    };
  });
  const food = rows.filter((row) => row.lane === "food").sort((left, right) => right.bought - left.bought || left.name.localeCompare(right.name));
  const entry = rows.filter((row) => row.lane === "entry").sort((left, right) => right.picked - left.picked || left.name.localeCompare(right.name));
  return { food, entry };
}

function writeEvent(folder, summary) {
  const dir = join(outDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

function durgaBook() {
  const raw = execFileSync("git", ["show", "origin/live:archive/durga-puja-2026-scans.json"], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw.toString("utf8"));
}

async function galaBook() {
  const response = await fetch("https://ticket-tracker.uttoron-tickets.workers.dev/api/live");
  const body = await response.json();
  return body.book;
}

const durgaOrders = catalogOrders(join(root, "web", "archive", "durga-puja-2026", "catalog.js"));
const galaOrders = catalogOrders(join(root, "web", "catalog.js"));
const durga = durgaBook();
const gala = await galaBook();
const durgaLog = summarizeLog(durga.log);
const galaLog = summarizeLog(gala.log);
const durgaItems = summarizeItems(durgaOrders, durga);
const galaItems = summarizeItems(galaOrders, gala);

writeEvent("sharodotsav-2026", {
  id: "sharodotsav-2026",
  name: "Sharodotsav",
  when: "October 9–11, 2026",
  status: "closed",
  totals: {
    orders: Object.keys(durgaOrders).length,
    scans: Object.keys(durga.orders || {}).length,
    desk: durgaLog.desk,
    food: durgaLog.food,
    entryMarked: durgaItems.entry.reduce((sum, row) => sum + row.picked, 0),
    foodPicked: durgaItems.food.reduce((sum, row) => sum + row.picked, 0),
  },
  hours: durgaLog.hours,
  food: durgaItems.food,
  entry: durgaItems.entry.filter((row) => row.picked > 0),
  staff: durgaLog.staff,
});

writeEvent("external-artist-gala-2026", {
  id: "external-artist-gala-2026",
  name: "External Artist Gala",
  when: "October 17, 2026",
  place: "Highline Performing Arts Center, Burien",
  status: "closed",
  totals: {
    orders: Object.keys(galaOrders).length,
    scans: Object.keys(gala.orders || {}).length,
    desk: galaLog.desk,
    food: galaLog.food,
    entryMarked: galaItems.entry.reduce((sum, row) => sum + row.picked, 0),
    foodPicked: galaItems.food.reduce((sum, row) => sum + row.picked, 0),
  },
  hours: galaLog.hours,
  food: galaItems.food.filter((row) => !/lunch|pizza|snacks|kalia|roll|chop/i.test(row.name)),
  entry: galaItems.entry.filter((row) => row.picked > 0),
  staff: galaLog.staff,
});

writeEvent("kali-pujo-2027", {
  id: "kali-pujo-2027",
  name: "Kali Pujo",
  when: "November 8, 2027",
  status: "upcoming",
  note: "This folder is ready. Analytics will be filed here when Kali Pujo runs. Nothing is collected yet.",
  totals: { orders: 0, scans: 0, desk: 0, food: 0, entryMarked: 0, foodPicked: 0 },
  hours: [],
  food: [],
  entry: [],
  staff: [],
});

writeFileSync(join(outDir, "index.json"), `${JSON.stringify({
  events: [
    { id: "kali-pujo-2027", name: "Kali Pujo", when: "November 8, 2027", status: "upcoming", file: "kali-pujo-2027/summary.json" },
    { id: "external-artist-gala-2026", name: "External Artist Gala", when: "October 17, 2026", status: "closed", file: "external-artist-gala-2026/summary.json" },
    { id: "sharodotsav-2026", name: "Sharodotsav", when: "October 9–11, 2026", status: "closed", file: "sharodotsav-2026/summary.json" },
  ],
}, null, 2)}\n`);

console.log("archive written", outDir);
