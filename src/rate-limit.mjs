export function createRateLimiter() {
  const buckets = new Map();

  function recent(key, windowMs, now) {
    const items = (buckets.get(key) || []).filter((time) => now - time < windowMs);
    buckets.set(key, items);
    return items;
  }

  return {
    tooMany(key, limit, windowMs, now) {
      return recent(key, windowMs, now).length >= limit;
    },
    hit(key, windowMs, now) {
      const items = recent(key, windowMs, now);
      items.push(now);
      buckets.set(key, items);
    },
  };
}
