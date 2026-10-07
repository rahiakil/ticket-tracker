import { readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { refundQty } from "./refunds.mjs";

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const laneFilter = flags.has("--food-only") ? "food"
  : flags.has("--entry-only") ? "entry"
  : null;
const source = args[0] || "E:\\Downloads\\order_list_10_06_2026_.csv";
const outPath = args[1] || (laneFilter === "food"
  ? "E:\\Downloads\\uttaron-qr-cards-food-10-06-2026.docx"
  : laneFilter === "entry"
    ? "E:\\Downloads\\uttaron-qr-cards-entry-10-06-2026.docx"
    : "E:\\Downloads\\uttaron-qr-cards-10-06-2026.docx");
const htmlPath = /\.html?$/i.test(outPath)
  ? outPath
  : outPath.replace(/\.(docx|doc)$/i, ".htm");

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

function dayOf(name) {
  const text = String(name || "").toLowerCase();
  if (/\bfriday\b/.test(text)) return "fri";
  if (/\bsaturday\b/.test(text)) return "sat";
  if (/\bsunday\b/.test(text)) return "sun";
  return "any";
}

function shouldSkipItem(name, lane) {
  const text = String(name || "").toLowerCase();
  // Kids pizza is not handed out on the food QR sheets.
  if (/\bpizza\b/.test(text) && /\bkids?\b/.test(text)) return true;
  // Food sheets never include entry (also covered by --food-only).
  if (laneFilter !== "entry" && (lane === "entry" || /\bentry\b/.test(text))) return true;
  return false;
}

function couponKind(name, lane) {
  const text = String(name || "").toLowerCase();
  const day = dayOf(name);
  const entry = lane === "entry" || /\bentry\b/.test(text);
  if (entry) {
    const role = /\bkid|\bchild|years old|below\b/.test(text) ? "kids"
      : /\bstudent\b/.test(text) ? "student"
      : /\bsenior\b/.test(text) ? "senior"
      : /\bparent/.test(text) ? "parents"
      : "adult";
    return `entry-${day}-${role}`;
  }
  if (/\bsnacks?\b/.test(text)) return `snack-${day}`;
  if (/\bpaneer\b/.test(text)) return `paneer-${day}`;
  if (/\bmutton\b/.test(text)) return `mutton-${day}`;
  if (/\bchicken\b/.test(text)) return `chicken-${day}`;
  if (/\bfish\b|\bmachh|\bmaach/.test(text)) return `fish-${day}`;
  if (/non-?veg/.test(text)) return `nonveg-${day}`;
  if (/\bvegetarian\b|\bveg\b/.test(text)) return `veg-${day}`;
  return `food-other-${day}`;
}

function colorOf(kind, name) {
  const text = String(name || "").toLowerCase();
  const day = dayOf(name);
  const base = String(kind || "").replace(/-(fri|sat|sun|any)$/, "");

  // Same-day food variants stay clearly different.
  if (base === "fish") return { bg: "#ea580c", fg: "#ffffff" }; // orange
  if (base === "nonveg" || base === "mutton" || base === "chicken") {
    return { bg: "#b91c1c", fg: "#ffffff" }; // red
  }
  if (base === "veg" || base === "paneer") {
    // Saturday veg uses a distinct green vs Sunday veg.
    if (day === "sat") return { bg: "#65a30d", fg: "#ffffff" }; // lime green
    return { bg: "#15803d", fg: "#ffffff" }; // forest green
  }
  if (base === "snack") return { bg: "#facc15", fg: "#1f2937" };
  if (base === "food-other") return { bg: "#0f766e", fg: "#ffffff" };

  const map = {
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
const skipped = { entry: 0, pizzaKids: 0 };
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
    const ordered = Math.max(1, Number(match[2]) || 1);
    const qty = Math.max(0, ordered - refundQty(code, itemName));
    rest = rest.slice(match[0].length).trim();
    if (qty < 1) continue;
    const lane = laneOf(itemName);
    if (laneFilter && lane !== laneFilter) continue;
    if (shouldSkipItem(itemName, lane)) {
      if (lane === "entry" || /\bentry\b/i.test(itemName)) skipped.entry += qty;
      else skipped.pizzaKids += qty;
      continue;
    }
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
    }
  }
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
    width: 160,
    color: { dark: "#111111", light: "#ffffff" },
  });
}

const groups = new Map();
for (const card of cards) {
  if (!groups.has(card.letter)) groups.set(card.letter, []);
  groups.get(card.letter).push(card);
}

const kindCounts = {};
for (const card of cards) kindCounts[card.kind] = (kindCounts[card.kind] || 0) + 1;

const COLS = 4;
const QR_PX = 84;

const sections = [...groups.entries()].map(([letter, list]) => {
  const cells = list.map((card) => {
    const itemLabel = card.parts > 1 ? `${card.itemName} (${card.unit} of ${card.parts})` : card.itemName;
    return `<td class="card" style="background:${card.color.bg};color:${card.color.fg};padding:6pt 8pt 7pt 8pt;">
      <div class="inner">
        <img src="${card.qr}" width="${QR_PX}" height="${QR_PX}" alt="QR ${escapeHtml(card.code)}">
        <div class="meta">
          <div class="name">${escapeHtml(card.name)}</div>
          <div class="item">${escapeHtml(itemLabel)}</div>
          <div class="code">${escapeHtml(card.code)}</div>
        </div>
      </div>
    </td>`;
  });
  const rowsHtml = [];
  for (let index = 0; index < cells.length; index += COLS) {
    const slice = cells.slice(index, index + COLS);
    while (slice.length < COLS) slice.push('<td class="empty"></td>');
    rowsHtml.push(`<tr>${slice.join("")}</tr>`);
  }
  return `<h2 class="letter">Letter ${escapeHtml(letter)} · ${list.length}</h2>
<table class="grid" width="100%">${rowsHtml.join("")}</table>`;
}).join("\n");

const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<title>Uttoron QR cards — food</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: letter; margin: 0.3in; }
  body { font-family: Calibri, Arial, sans-serif; color: #111; }
  h2.letter { page-break-before: auto; font-size: 11pt; margin: 8pt 0 4pt; border-bottom: 1pt solid #333; padding-bottom: 2pt; }
  .cover { margin-bottom: 8pt; }
  .grid { border-collapse: separate; border-spacing: 18pt 21pt; width: 100%; table-layout: fixed; }
  .card { width: 25%; vertical-align: top; border: 1pt solid #111; border-radius: 5pt; padding: 6pt 8pt; mso-padding-alt: 6pt 8pt 7pt 8pt; }
  .empty { width: 25%; border: none; }
  .inner { padding: 0; text-align: center; }
  .meta { margin-top: 4pt; padding: 0 4pt 0 6pt; text-align: left; mso-padding-alt: 0 4pt 0 6pt; }
  .name { font-size: 8pt; font-weight: 700; line-height: 1.15; margin: 0 2pt; word-wrap: break-word; }
  .item { font-size: 7pt; font-weight: 650; margin: 2pt 2pt 0; line-height: 1.15; word-wrap: break-word; }
  .code { font-size: 6.5pt; margin: 2pt 2pt 0; opacity: 0.92; }
  img { display: block; margin: 0 auto; background: #fff; padding: 2pt; }
</style>
</head>
<body>
<div class="cover">
  <h1>Uttoron Sharodotsav QR cards — food only</h1>
  <p>Source: ${escapeHtml(source)}</p>
  <p>${cards.length} food cards from ${new Set(cards.map((card) => card.code)).size} orders. No entry. No kids pizza. Layout: ${COLS} per row.</p>
  <p>Colors: fish = orange, non-veg = red, Sunday veg = forest green, Saturday veg = lime green.</p>
  <p>Print on letter paper. Cut in the white gaps between boxes.</p>
</div>
${sections}
</body>
</html>`;

writeFileSync(htmlPath, html, "utf8");

const docxPath = /\.docx$/i.test(outPath) ? outPath : outPath.replace(/\.(htm|html|doc)$/i, ".docx");
if (docxPath.toLowerCase() !== htmlPath.toLowerCase()) {
  const ps = `
$ErrorActionPreference = 'Stop'
$htmlPath = '${htmlPath.replace(/'/g, "''")}'
$docxPath = '${docxPath.replace(/'/g, "''")}'
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($htmlPath, $false, $true)
  # 16 = wdFormatXMLDocument (.docx)
  $doc.SaveAs([ref]$docxPath, [ref]16)
} finally {
  if ($doc) { $doc.Close($false) | Out-Null }
  if ($word) { $word.Quit() | Out-Null }
  if ($doc) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null }
  if ($word) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`;
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`Word failed to save DOCX (exit ${result.status})`);
  }
}

console.log(JSON.stringify({
  source,
  htmlPath,
  outPath: docxPath,
  laneFilter: laneFilter || "all",
  skipped,
  orders: new Set(cards.map((card) => card.code)).size,
  cards: cards.length,
  kinds: kindCounts,
  letters: [...groups.keys()],
}, null, 2));
