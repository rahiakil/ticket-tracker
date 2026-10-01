import { readFileSync, writeFileSync } from "node:fs";

function parseTsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    if (quoted) {
      if (char === '"') {
        if (src[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim()));
}

function toneOf(name) {
  const text = name.toLowerCase();
  if (text.includes("entry")) return "entry";
  const nonVeg = /non-veg|non veg|chicken|mutton|fish/.test(text);
  const veg = !nonVeg && /vegetarian|\bveg\b|paneer/.test(text);
  const saturday = text.includes("saturday");
  const sunday = text.includes("sunday");
  if (saturday && veg) return "sat-veg";
  if (saturday) return "sat-nonveg";
  if (sunday && veg) return "sun-veg";
  if (sunday) return "sun-nonveg";
  if (veg) return "veg";
  if (nonVeg) return "nonveg";
  return "other";
}

function laneOf(name) {
  return name.toLowerCase().includes("entry") ? "entry" : "food";
}

const source = process.argv[2] || "E:\\Downloads\\order2.txt";
const rows = parseTsv(readFileSync(source, "utf8"));
const [header, ...body] = rows;
const index = Object.fromEntries(header.map((name, position) => [name.trim(), position]));
const orders = {};
const itemNames = new Map();
for (const row of body) {
  const full = (row[index["Order Number"]] || "").trim();
  const code = full.slice(-5);
  if (!/^\d{5}$/.test(code)) throw new Error(`Bad order number ${full}`);
  if (orders[code]) throw new Error(`Last 5 digits collide: ${code}`);
  const items = [];
  let rest = (row[index.Items] || "").trim();
  while (rest) {
    const match = rest.match(/^(.+?)\sx\s(\d+)\s*(?:,\s*|$)/i);
    if (!match) break;
    const name = match[1].trim();
    const qty = Number(match[2]);
    itemNames.set(name, (itemNames.get(name) || 0) + qty);
    items.push({ name, qty, lane: laneOf(name), tone: toneOf(name) });
    rest = rest.slice(match[0].length);
  }
  orders[code] = {
    code,
    full,
    name: (row[index["Full Name"]] || "").replace(/\s+/g, " ").trim(),
    email: (row[index.Email] || "").trim(),
    event: (row[index["Event Name"]] || "").trim(),
    date: (row[index["Order Date"]] || "").trim(),
    amount: (row[index["Total Amount"]] || "").trim(),
    items,
  };
}

const out = `window.TicketCatalog = ${JSON.stringify({ orders }, null, 2)};
window.TicketCatalog.lookup = function lookup(raw) {
  const text = String(raw || "").trim();
  const orderCode = text.match(/order-(\\d+)/i);
  if (orderCode) return this.orders[orderCode[1].slice(-5)] || null;
  const utt = text.match(/UTT(\\d{8,})/i);
  if (utt) return this.orders[utt[1].slice(-5)] || null;
  if (/^\\d{5}$/.test(text)) return this.orders[text] || null;
  const tail = text.match(/(\\d{5})\\s*$/);
  if (tail && text.length <= 80) return this.orders[tail[1]] || null;
  return null;
};
`;
writeFileSync(new URL("../web/catalog.js", import.meta.url), out);
console.log(JSON.stringify({
  orders: Object.keys(orders).length,
  items: [...itemNames.entries()].sort((left, right) => right[1] - left[1]),
}, null, 2));
