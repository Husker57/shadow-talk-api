// Server-side price table for card charges (Authorize.net).
// The amount charged comes ONLY from this table (keyed by site + plan/SKU id).
// Any price/amount the browser sends is ignored for charging; if one is sent and it
// does not match the table, the charge is refused so the buyer is never charged a
// different amount than the page showed.
//
// Optional override without a code change: set a Worker variable or secret
// PRICES_JSON, e.g. {"shadowrealm":{"gold":"9.99"}} or
// {"shadowrealm":{"gold":{"amount":"9.99","label":"..."}}}.
// Entries in PRICES_JSON replace or add to the table below. Invalid JSON is ignored.

export const PRICES = {
  "shadowrealm": {
    "free": { amount: "0.00", label: "Free" },
    "gold": { amount: "9.99", label: "Gold (1 month)" },
    "platinum": { amount: "12.99", label: "Platinum (1 month)" },
    "diamond": { amount: "19.99", label: "Diamond (1 month)" }
  }
};

function normAmount(v) {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return n.toFixed(2);
}

export function priceTable(env) {
  const table = {};
  for (const site of Object.keys(PRICES)) table[site] = { ...PRICES[site] };
  const raw = env && env.PRICES_JSON;
  if (!raw) return table;
  let extra;
  try { extra = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return table; }
  if (!extra || typeof extra !== "object") return table;
  for (const site of Object.keys(extra)) {
    const items = extra[site];
    if (!items || typeof items !== "object") continue;
    table[site] = table[site] || {};
    for (const sku of Object.keys(items)) {
      const v = items[sku];
      const amount = normAmount(v && typeof v === "object" ? v.amount : v);
      if (amount === null) continue;
      const label = v && typeof v === "object" && v.label ? String(v.label).slice(0, 120) : (table[site][sku] && table[site][sku].label) || sku;
      table[site][String(sku).trim().toLowerCase()] = { amount, label };
    }
  }
  return table;
}

export function lookupPrice(site, sku, env) {
  const id = String(sku || "").trim().toLowerCase();
  const items = priceTable(env)[site] || {};
  const item = Object.prototype.hasOwnProperty.call(items, id) ? items[id] : null;
  if (!item) return { ok: false, error: "unknown_plan", message: "That plan is not for sale here. Refresh the page and pick a plan again." };
  return { ok: true, sku: id, amount: item.amount, label: item.label };
}

// Returns { ok:true, order } with order.amount set from the server table,
// or { ok:false, error, message } (send as HTTP 400; nothing is charged).
export function priceOrder(order, body, env) {
  const p = lookupPrice(order.site, body.sku || body.plan || order.sku, env);
  if (!p.ok) return p;
  if (!(Number(p.amount) > 0)) return { ok: false, error: "free_plan", message: "This plan is free. No card is needed." };
  const claimedRaw = body.price != null && body.price !== "" ? body.price : body.amount;
  if (claimedRaw != null && claimedRaw !== "") {
    const claimed = normAmount(claimedRaw);
    if (claimed === null || Math.round(Number(claimed) * 100) !== Math.round(Number(p.amount) * 100)) {
      return { ok: false, error: "price_mismatch", message: "The price changed. Refresh the page and try again.", sku: p.sku, amount: p.amount };
    }
  }
  return { ok: true, order: { ...order, sku: p.sku, amount: p.amount, priceSource: "server", description: ((order.siteLabel || order.siteCode || "") + " " + p.label).trim() } };
}
