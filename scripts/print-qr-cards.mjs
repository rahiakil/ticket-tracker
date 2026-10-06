import { readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const laneFilter = flags.has("--food-only") ? "food"
  : flags.has("--entry-only") ? "entry"
  : null;
const source = args[0] || "E:\\Downloads\\order_list_10_06_2026_.csv";
const outPath = args[1] || (laneFilter === "food"
  ? "E:\\Downloads\\uttaron-qr-cards-food-10-06-2026.doc"
  : laneFilter === "entry"
    ? "E:\\Downloads\\uttaron-qr-cards-entry-10-06-2026.doc"
    : "E:\\Downloads\\uttaron-qr-cards-10-06-2026.doc");

function parseTable(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
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
    else if (char === delimiter) {
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
  return rows.filter((item) => item.some((value) => String(value || "").trim()));
}

function laneOf(name) {
  return /\bentry\b/i.test(name) ? "entry" : "food";
}

function couponKind(name, lane) {
  const text = String(name || "").toLowerCase();
  const entry = lane === "entry" || /\bentry\b/.test(text);
  if (entry) {
    const day = /\bfriday\b/.test(text) ? "fri" : /\bsaturday\b/.test(text) ? "sat" : /\bsunday\b/.test(text) ? "sun" : "any";
    const role = /\bkid|\bchild|years old|below\b/.test(text) ? "kids"
      : /\bstudent\b/.test(text) ? "student"
      : /\bsenior\b/.test(text) ? "senior"
      : /\bparent/.test(text) ? "parents"
      : "adult";
    return `entry-${day}-${role}`;
  }
  if (/\bsnacks?\b/.test(text)) return "snack";
  if (/\bpaneer\b/.test(text)) return "paneer";
  if (/\bmutton\b/.test(text)) return "mutton";
  if (/\bchicken\b/.test(text)) return "chicken";
  if (/\bfish\b|\bmachh|\bmaach/.test(text)) return "fish";
  if (/non-?veg/.test(text)) return "nonveg";
  if (/\bvegetarian\b|\bveg\b/.test(text)) return "veg";
  return "food-other";
}

function colorOf(kind, name) {
  const map = {
    mutton: { bg: "#7f1d1d", fg: "#ffffff" },
    chicken: { bg: "#f07167", fg: "#1f2937" },
    nonveg: { bg: "#b91c1c", fg: "#ffffff" },
    fish: { bg: "#f97316", fg: "#1f2937" },
    veg: { bg: "#15803d", fg: "#ffffff" },
    paneer: { bg: "#f3e6c8", fg: "#3f2e12" },
    snack: { bg: "#facc15", fg: "#1f2937" },
    "food-other": { bg: "#0f766e", fg: "#ffffff" },
    "entry-fri-adult": { bg: "#0f766e", fg: "#ffffff" },
    "entry-fri-kids": { bg: "#99f6e4", fg: "#134e4a" },
    "entry-fri-student": { bg: "#14b8a6", fg: "#ffffff" },
    "entry-fri-senior": { bg: "#115e59", fg: "#ffffff" },
    "entry-fri-parents": { bg: "#0d9488", fg: "#ffffff" },
    "entry-sat-adult": { bg: "#6d28d9", fg: "#ffffff" },
    "entry-sat-kids": { bg: "#ddd6fe", fg: "#4c1d95" },
    "entry-sat-student": { bg: "#8b5cf6", fg: "#ffffff" },
    "entry-sat-senior": { bg: "#4c1d95", fg: "#ffffff" },
    "entry-sat-parents": { bg: "#7c3aed", fg: "#ffffff" },
    "entry-sun-adult": { bg: "#1e40af", fg: "#ffffff" },
    "entry-sun-kids": { bg: "#bfdbfe", fg: "#1e3a8a" },
    "entry-sun-student": { bg: "#3b82f6", fg: "#ffffff" },
    "entry-sun-senior": { bg: "#1e3a8a", fg: "#ffffff" },
    "entry-sun-parents": { bg: "#2563eb", fg: "#ffffff" },
  };
  if (map[kind]) return map[kind];
  if (String(kind).startsWith("entry-any")) {
    let hash = 0;
    const text = String(name || "").toLowerCase();
    for (let index = 0; index < text.length; index += 1) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
    const hue = 165 + (hash % 115);
    return { bg: `hsl(${hue} 42% 36%)`, fg: "#ffffff" };
  }
  return { bg: "#64748b", fg: "#ffffff" };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const rows = parseTable(readFileSync(source, "utf8"), ",");
const [header, ...body] = rows;
const index = Object.fromEntries(header.map((name, position) => [String(name || "").trim(), position]));
const cards = [];
for (const row of body) {
  const full = (row[index["Order Number"]] || "").trim();
  if (!full) continue;
  const code = full.slice(-5);
  if (!/^\d{5}$/.test(code)) continue;
  const name = (row[index["Full Name"]] || "").replace(/\s+/g, " ").trim();
  const email = (row[index.Email] || "").trim();
  let rest = (row[index.Items] || "").trim();
  while (rest) {
    const match = rest.match(/^(.+?)\sx\s(\d+)\s*(?:,\s*|$)/i);
    if (!match) break;
    const itemName = match[1].trim();
    const qty = Math.max(1, Number(match[2]) || 1);
    rest = rest.slice(match[0].length).trim();
    const lane = laneOf(itemName);
    if (laneFilter && lane !== laneFilter) continue;
    const kind = couponKind(itemName, lane);
    for (let unit = 0; unit < qty; unit += 1) {
      cards.push({
        code,
        full,
        name,
        email,
        itemName,
        unit: unit + 1,
        parts: qty,
        lane,
        kind,
        color: colorOf(kind, itemName),
        letter: /[A-Z]/i.test(name.charAt(0)) ? name.charAt(0).toUpperCase() : "#",
      });
    }  }
}

cards.sort((left, right) => {
  const byLetter = left.letter.localeCompare(right.letter);
  if (byLetter) return byLetter;
  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (byName) return byName;
  return left.itemName.localeCompare(right.itemName, undefined, { sensitivity: "base" });
});

for (const card of cards) {
  card.qr = await QRCode.toDataURL(card.code, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: { dark: "#111111", light: "#ffffff" },
  });
}

const groups = new Map();
for (const card of cards) {
  if (!groups.has(card.letter)) groups.set(card.letter, []);
  groups.get(card.letter).push(card);
}

const sections = [...groups.entries()].map(([letter, list]) => {
  const cells = list.map((card) => {
    const itemLabel = card.parts > 1 ? `${card.itemName} (${card.unit} of ${card.parts})` : card.itemName;
    return `<td class="card" style="background:${card.color.bg};color:${card.color.fg};">
      <div class="inner">
        <img src="${card.qr}" width="110" height="110" alt="QR ${escapeHtml(card.code)}">
        <div class="meta">
          <div class="name">${escapeHtml(card.name)}</div>
          <div class="item">${escapeHtml(itemLabel)}</div>
          <div class="code">${escapeHtml(card.code)} · ${escapeHtml(card.lane)}</div>
        </div>
      </div>
    </td>`;
  });
  const rowsHtml = [];
  for (let index = 0; index < cells.length; index += 3) {
    const slice = cells.slice(index, index + 3);
    while (slice.length < 3) slice.push('<td class="empty"></td>');
    rowsHtml.push(`<tr>${slice.join("")}</tr>`);
  }
  return `<h1 class="letter">Letter ${escapeHtml(letter)} · ${list.length} tickets</h1>
<table class="grid" width="100%">${rowsHtml.join("")}</table>`;
}).join("\n");

const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<title>Uttoron QR cards${laneFilter ? ` (${laneFilter} only)` : ""}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: letter; margin: 0.45in; }
  body { font-family: Calibri, Arial, sans-serif; color: #111; }
  h1.letter { page-break-before: always; font-size: 22pt; margin: 8pt 0 10pt; }
  h1.letter:first-of-type { page-break-before: auto; }
  .cover { margin-bottom: 18pt; }
  .grid { border-collapse: separate; border-spacing: 8pt; width: 100%; }
  .card { width: 33%; vertical-align: top; border: 1pt solid #111; border-radius: 8pt; padding: 0; }
  .empty { width: 33%; border: none; }
  .inner { padding: 8pt; text-align: center; }
  .meta { margin-top: 6pt; text-align: left; }
  .name { font-size: 12pt; font-weight: 700; line-height: 1.2; }
  .item { font-size: 11pt; font-weight: 650; margin-top: 3pt; line-height: 1.2; }
  .code { font-size: 9pt; margin-top: 3pt; opacity: 0.92; }
  img { display: block; margin: 0 auto; background: #fff; padding: 4pt; }
</style>
</head>
<body>
<div class="cover">
  <h1>Uttoron Sharodotsav QR cards${laneFilter ? ` — ${laneFilter} only` : ""}</h1>
  <p>Source: ${escapeHtml(source)}</p>
  <p>${cards.length} single-item cards from ${new Set(cards.map((card) => card.code)).size} orders${laneFilter ? ` (${laneFilter} only, no ${laneFilter === "food" ? "entry" : "food"})` : ""}. Grouped A to Z. Each box is one ticket with its own QR (order code).</p>
  <p>Print on letter paper. Cut on the box borders for handout.</p>
</div>
${sections}
</body>
</html>`;

writeFileSync(outPath, html, "utf8");
console.log(JSON.stringify({
  source,
  outPath,
  laneFilter: laneFilter || "all",
  orders: new Set(cards.map((card) => card.code)).size,
  cards: cards.length,
  letters: [...groups.keys()],
}, null, 2));
