/** Remaining quantity allowed after refund. keep is the number that should still exist. */
export const REFUNDS = [
  { code: "11911", item: "Sunday Machher Kalia", keep: 2, note: "Diby Mukherjee bought 13, refund 11" },
  { code: "11809", item: "Saturday Lunch Vegetarian", keep: 0, note: "Asitava Saturday food $16 x 3" },
  { code: "11992", item: "Saturday Lunch Vegetarian", keep: 0, note: "Samarpita Anand Saturday Lunch 2" },
  { code: "11992", item: "Friday Kids Non-Member Entry", keep: 0, note: "Samarpita Anand kids entry" },
  { code: "11992", item: "Saturday Kids Non-Member Entry", keep: 0, note: "Samarpita Anand kids entry" },
  { code: "11970", item: "Saturday Lunch Vegetarian", keep: 0, note: "Ananya Roy Saturday Lunch 2" },
  { code: "11970", item: "Sunday Lunch Non-Vegetarian", keep: 0, note: "Ananya Roy Sunday Lunch Non-Vegetarian 2" },
  { code: "11970", item: "Sunday Machher Kalia", keep: 0, note: "Ananya Roy Sunday Machher Kalia 2" },
  { code: "12382", item: "Saturday Lunch Vegetarian", keep: 0, note: "Pradip Saha Saturday Lunch Vegetarian 3" },
  { code: "12264", item: "Saturday Lunch Vegetarian", keep: 0, note: "Maitreyi Paul Saturday Lunch Vegetarian 3" },
  { code: "12264", item: "Saturday Adult Non-Member Entry", keep: 0, note: "Maitreyi Paul Saturday Entry 3" },
  { code: "11807", item: "Friday Adult Non-Member Entry", keep: 0, note: "Kaushik Chatterjee Friday 2 adults" },
  { code: "11807", item: "Friday Kids Non-Member Entry", keep: 0, note: "Kaushik Chatterjee Friday 2 kids" },
  { code: "12368", item: "Sunday Adult Non-Member Entry", keep: 0, note: "Vishal Bajaj Sunday 2 adults" },
  { code: "12368", item: "Sunday Kids Non-Member Entry", keep: 0, note: "Vishal Bajaj Sunday 1 kid" },
];

export function allowedQty(code, itemName, ordered) {
  const caps = REFUNDS.filter((row) => row.code === code && row.item === itemName).map((row) => row.keep);
  if (!caps.length) return ordered;
  return Math.max(0, Math.min(ordered, ...caps));
}

export function applyOrderRefunds(orders) {
  const applied = [];
  for (const [code, order] of Object.entries(orders)) {
    const next = [];
    for (const item of order.items || []) {
      const qty = allowedQty(code, item.name, item.qty);
      if (qty !== item.qty) {
        applied.push({ code, name: order.name, item: item.name, before: item.qty, after: qty });
      }
      if (qty > 0) next.push({ ...item, qty });
    }
    order.items = next;
  }
  return applied;
}
