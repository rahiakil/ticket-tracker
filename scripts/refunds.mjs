/** Partial refunds applied on top of the order CSV. qty is how many units to remove. */
export const REFUNDS = [
  { code: "11911", item: /machher kalia/i, qty: 11, note: "Diby Mukherjee — 11 Machher Kalia" },
  { code: "11809", item: /saturday lunch vegetarian/i, qty: 3, note: "Asitava — Saturday food $16 x 3" },
  { code: "11992", item: /saturday lunch vegetarian/i, qty: 2, note: "Samarpita Anand — Saturday Lunch 2" },
  { code: "11992", item: /kids .* entry/i, qty: 99, note: "Samarpita Anand — kids entry (Fri + Sat on this order)" },
  { code: "11970", item: /saturday lunch vegetarian/i, qty: 2, note: "Ananya Roy — Saturday Lunch 2" },
  { code: "11970", item: /sunday lunch non-vegetarian/i, qty: 2, note: "Ananya Roy — Sunday Lunch Non-Vegetarian 2" },
  { code: "11970", item: /machher kalia/i, qty: 2, note: "Ananya Roy — Sunday Machher Kalia 2" },
  { code: "12382", item: /saturday lunch vegetarian/i, qty: 3, note: "Pradip Saha — Saturday Lunch Vegetarian 3" },
  { code: "12264", item: /saturday lunch vegetarian/i, qty: 3, note: "Maitreyi Paul — Saturday Lunch Vegetarian 3" },
  { code: "12264", item: /saturday .* entry/i, qty: 3, note: "Maitreyi Paul — Saturday Entry 3" },
  { code: "11807", item: /friday adult .* entry/i, qty: 2, note: "Kaushik Chatterjee — Friday 2 adults" },
  { code: "11807", item: /friday kids .* entry/i, qty: 2, note: "Kaushik Chatterjee — Friday 2 kids" },
  { code: "12368", item: /sunday adult .* entry/i, qty: 2, note: "Vishal Bajaj — Sunday 2 adults" },
  { code: "12368", item: /sunday kids .* entry/i, qty: 1, note: "Vishal Bajaj — Sunday 1 kid" },
];

export function refundQty(code, itemName) {
  return REFUNDS
    .filter((row) => row.code === code && row.item.test(itemName))
    .reduce((sum, row) => sum + row.qty, 0);
}

export function applyOrderRefunds(orders) {
  const applied = [];
  for (const [code, order] of Object.entries(orders)) {
    const next = [];
    for (const item of order.items || []) {
      const cut = refundQty(code, item.name);
      if (!cut) {
        next.push(item);
        continue;
      }
      const before = item.qty;
      const qty = Math.max(0, before - cut);
      applied.push({ code, name: order.name, item: item.name, before, cut: Math.min(cut, before), after: qty });
      if (qty > 0) next.push({ ...item, qty });
    }
    order.items = next;
  }
  return applied;
}
