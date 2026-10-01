import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import XLSX from "xlsx";

const root = new URL("..", import.meta.url);
const context = {};
vm.runInNewContext(readFileSync(new URL("../web/sheet.js", import.meta.url), "utf8"), context);
const sheet = context.TicketSheet;

function latestOrderList(directory) {
  const names = readdirSync(directory).filter((name) => /^order_list/i.test(name));
  if (!names.length) throw new Error(`No order_list file in ${directory}`);
  names.sort((left, right) => statSync(join(directory, right)).mtimeMs - statSync(join(directory, left)).mtimeMs);
  return join(directory, names[0]);
}

function rowsFromFile(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".csv")) return sheet.parseTable(readFileSync(file, "utf8"), ",");
  if (lower.endsWith(".tsv") || lower.endsWith(".txt")) return sheet.parseTable(readFileSync(file, "utf8"), "\t");
  const book = XLSX.readFile(file, { cellDates: false });
  const first = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(first, { header: 1, raw: false, defval: "" });
}

const file = process.argv[2] || latestOrderList(process.argv[3] || "E:\\Downloads");
const orders = sheet.ordersFromRows(rowsFromFile(file));
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
const friday = Object.values(orders).filter((order) => order.items.some((item) => /friday/i.test(item.name))).length;
console.log(JSON.stringify({ file, orders: Object.keys(orders).length, fridayOrders: friday }, null, 2));
