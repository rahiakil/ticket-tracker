import { readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { allowedQty } from "./refunds.mjs";

const args = [];
const flags = new Set();
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) flags.add(arg);
  else args.push(arg);
}
const laneFilter = flags.has("--food-only") ? "food"
  : flags.has("--entry-only") ? "entry"
  : null;
// --sort groups A–Z. --letter-page starts each new letter on its own page.
// Both stay on unless turned off, matching the sheets we already print.
const sortCards = !flags.has("--no-sort");
const letterPage = !flags.has("--no-letter-page");
const noSpace = flags.has("--nospace");
const source = args[0] || "E:\\Downloads\\order_list_10_08_2026_.csv";
const dated = (source.match(/(\d{2}_\d{2}_\d{4})/) || ["", "10_08_2026"])[1].replaceAll("_", "-");
const outPath = args[1] || (laneFilter === "food"
  ? `E:\\Downloads\\uttaron-qr-cards-food-${dated}.pdf`
  : laneFilter === "entry"
    ? `E:\\Downloads\\uttaron-qr-cards-entry-${dated}.pdf`
    : `E:\\Downloads\\uttaron-qr-cards-${dated}.pdf`);
const htmlPath = /\.html?$/i.test(outPath)
  ? outPath
  : outPath.replace(/\.(docx|doc|pdf)$/i, ".htm");

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
    const qty = allowedQty(code, itemName, ordered);
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

if (sortCards) {
  cards.sort((left, right) => {
    const byLetter = left.letter.localeCompare(right.letter);
    if (byLetter) return byLetter;
    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    if (byName) return byName;
    return left.itemName.localeCompare(right.itemName, undefined, { sensitivity: "base" });
  });
}

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
const QR_PX = noSpace ? 108 : 84;
const pageMarginIn = noSpace ? 0.12 : 0.3;

function cellsFor(list) {
  return list.map((card) => {
    const itemLabel = card.parts > 1 ? `${card.itemName} (${card.unit} of ${card.parts})` : card.itemName;
    return `<td class="card" style="background:${card.color.bg};color:${card.color.fg};padding:${cardPad};">
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
}

function tableFor(list) {
  const cells = cellsFor(list);
  const rowsHtml = [];
  for (let index = 0; index < cells.length; index += COLS) {
    const slice = cells.slice(index, index + COLS);
    while (slice.length < COLS) slice.push('<td class="empty"></td>');
    rowsHtml.push(`<tr>${slice.join("")}</tr>`);
  }
  return `<table class="grid" width="100%">${rowsHtml.join("")}</table>`;
}

const gridSpacing = noSpace ? "4pt 5pt" : "18pt 21pt";
const cardPad = noSpace ? "3pt 4pt 3pt 4pt" : "6pt 8pt 7pt 8pt";

const sections = letterPage
  ? [...groups.entries()].map(([letter, list], sectionIndex) => {
    const breakHtml = sectionIndex === 0 ? "" : `<br clear="all" style="page-break-before:always">`;
    return `${breakHtml}<div class="letter-page">${tableFor(list)}</div>`;
  }).join("\n")
  : `<div class="letter-page">${tableFor(cards)}</div>`;

const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<title>Uttoron QR cards — food</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: letter; margin: ${pageMarginIn}in; }
  body { font-family: Calibri, Arial, sans-serif; color: #111; margin: 0; }
  .letter-page { page-break-before: always; }
  .letter-page:first-of-type { page-break-before: auto; }
  .grid { border-collapse: separate; border-spacing: ${gridSpacing}; width: 100%; table-layout: fixed; }
  .card { width: 25%; vertical-align: top; border: 1pt solid #111; border-radius: 5pt; padding: ${cardPad}; mso-padding-alt: ${cardPad}; }
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
${sections}
</body>
</html>`;

writeFileSync(htmlPath, html, "utf8");

const wantsPdf = /\.pdf$/i.test(outPath);
const docxPath = wantsPdf
  ? outPath.replace(/\.pdf$/i, ".docx")
  : (/\.docx$/i.test(outPath) ? outPath : outPath.replace(/\.(htm|html|doc)$/i, ".docx"));
const pdfPath = wantsPdf ? outPath : outPath.replace(/\.(docx|doc|htm|html)$/i, ".pdf");
if (docxPath.toLowerCase() !== htmlPath.toLowerCase()) {
  const margin = pageMarginIn;
  const ps = `
$ErrorActionPreference = 'Stop'
$htmlPath = '${htmlPath.replace(/'/g, "''")}'
$docxPath = '${docxPath.replace(/'/g, "''")}'
$pdfPath = '${pdfPath.replace(/'/g, "''")}'
$marginIn = ${margin}
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($htmlPath, $false, $true)
  $pts = $word.InchesToPoints($marginIn)
  $doc.PageSetup.TopMargin = $pts
  $doc.PageSetup.BottomMargin = $pts
  $doc.PageSetup.LeftMargin = $pts
  $doc.PageSetup.RightMargin = $pts
  $doc.PageSetup.HeaderDistance = 0
  $doc.PageSetup.FooterDistance = 0
  # 16 = wdFormatXMLDocument (.docx), 17 = wdFormatPDF
  if (-not '${wantsPdf ? "pdf" : "docx"}'.Equals('pdf')) {
    $doc.SaveAs([ref]$docxPath, [ref]16)
  }
  $doc.SaveAs([ref]$pdfPath, [ref]17)
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
    throw new Error(`Word failed to save the print file (exit ${result.status})`);
  }
}

console.log(JSON.stringify({
  source,
  htmlPath,
  pdfPath,
  outPath: wantsPdf ? pdfPath : docxPath,
  sort: sortCards,
  letterPage,
  noSpace,
  pageMarginIn,
  laneFilter: laneFilter || "all",
  skipped,
  orders: new Set(cards.map((card) => card.code)).size,
  cards: cards.length,
  kinds: kindCounts,
  letters: [...groups.keys()],
}, null, 2));
