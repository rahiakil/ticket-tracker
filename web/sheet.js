(function (root) {
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

  function itemsFromCell(cell) {
    const items = [];
    let rest = String(cell || "").trim();
    while (rest) {
      const match = rest.match(/^(.+?)\sx\s(\d+)\s*(?:,\s*|$)/i);
      if (!match) break;
      const name = match[1].trim();
      const lane = /\bentry\b/i.test(name) ? "entry" : "food";
      items.push({ name, qty: Number(match[2]), lane, tone: lane });
      rest = rest.slice(match[0].length).trim();
    }
    return items;
  }

  function headerIndex(header) {
    const index = {};
    header.forEach((name, position) => {
      index[String(name || "").trim().toLowerCase()] = position;
    });
    return index;
  }

  function cell(row, index, label) {
    const position = index[label.toLowerCase()];
    if (position === undefined) return "";
    return String(row[position] ?? "").trim();
  }

  function ordersFromRows(rows) {
    const body = (rows || []).map((row) => (Array.isArray(row) ? row : [row])).filter((row) => row.some((value) => String(value || "").trim()));
    if (!body.length) throw new Error("That sheet is empty.");
    const index = headerIndex(body[0]);
    for (const label of ["order number", "full name", "email", "items"]) {
      if (index[label] === undefined) throw new Error("The sheet needs Order Number, Full Name, Email, and Items.");
    }
    const orders = {};
    for (const row of body.slice(1)) {
      const full = cell(row, index, "order number");
      if (!full) continue;
      const code = full.slice(-5);
      if (!/^\d{5}$/.test(code)) throw new Error(`Bad order number ${full}`);
      if (orders[code]) throw new Error(`Last 5 digits collide: ${code}`);
      orders[code] = {
        code,
        full,
        name: cell(row, index, "full name").replace(/\s+/g, " ").trim(),
        email: cell(row, index, "email"),
        event: cell(row, index, "event name"),
        date: cell(row, index, "order date"),
        amount: cell(row, index, "total amount"),
        items: itemsFromCell(cell(row, index, "items")),
      };
    }
    if (!Object.keys(orders).length) throw new Error("No orders were found in that sheet.");
    return orders;
  }

  function ordersFromText(text, delimiter) {
    return ordersFromRows(parseTable(text, delimiter));
  }

  root.TicketSheet = { ordersFromRows, ordersFromText, parseTable };
})(typeof globalThis !== "undefined" ? globalThis : this);
