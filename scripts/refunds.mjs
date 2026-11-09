/** Orders removed from the door list. Last 5 digits of the order number. */
export const CANCELLED = [];

/** Remaining quantity allowed after refund. keep is the number that should still exist. */
export const REFUNDS = [
  { code: "12771", item: "Non-Veg Food", keep: 0, note: "Soumya Banerjee food cancelled" },
  { code: "12771", item: "Veg Pulao Food", keep: 0, note: "Soumya Banerjee food cancelled" },
  { code: "12771", item: "Kids Pizza", keep: 0, note: "Soumya Banerjee food cancelled" },
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
