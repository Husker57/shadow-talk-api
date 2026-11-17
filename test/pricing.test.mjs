// Server-side pricing for checkout-charge. Run: node --test test/*.test.mjs (Node 20+, no dependencies)
// No network: Authorize.net is replaced by a fake fetch that records the request.
import test from "node:test";
import assert from "node:assert/strict";

import { PRICES, lookupPrice, priceOrder, priceTable } from "../src/prices.js";
import { chargeCard } from "../src/charge.js";
import worker from "../src/index.js";

const SITE = Object.keys(PRICES)[0];
const ENV = { AUTHORIZE_API_LOGIN_ID: "test-login", AUTHORIZE_TRANSACTION_KEY: "test-key", AUTHORIZE_SANDBOX: "true" };
const PAID = Object.entries(PRICES[SITE]).find(([, v]) => Number(v.amount) > 0);
const FREE = Object.entries(PRICES[SITE]).find(([, v]) => Number(v.amount) === 0);

function fakeAuthnet(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ transactionResponse: { responseCode: "1", transId: "T1", authCode: "A1" } }), { status: 200 });
  };
}
async function post(body, env) {
  const res = await worker.fetch(new Request("https://x.test/", { method: "POST", body: JSON.stringify(body) }), env);
  return { status: res.status, data: await res.json() };
}
function chargeBody(extra) {
  return { action: "checkout-charge", site: SITE, dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: "opaque", name: "A", email: "a@b.c", ...extra };
}

test("price table: every amount is a 2-decimal string and SKUs are lowercase", () => {
  for (const [sku, v] of Object.entries(PRICES[SITE])) {
    assert.match(v.amount, /^\d+\.\d{2}$/, sku);
    assert.equal(sku, sku.toLowerCase());
  }
  assert.equal(lookupPrice(SITE, PAID[0].toUpperCase()).amount, PAID[1].amount);
  assert.equal(lookupPrice(SITE, "no-such-plan").ok, false);
  assert.equal(lookupPrice(SITE, "__proto__").ok, false);
  assert.equal(lookupPrice("other-site", PAID[0]).ok, false);
});

test("checkout-charge charges the server price when the browser sends only a plan id", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = fakeAuthnet(calls);
  try {
    const r = await post(chargeBody({ sku: PAID[0] }), ENV);
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.amount, PAID[1].amount);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.createTransactionRequest.transactionRequest.amount, PAID[1].amount);
  } finally { globalThis.fetch = realFetch; }
});

test("checkout-charge accepts a matching browser price (12 == 12.00) and still charges the table amount", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = fakeAuthnet(calls);
  try {
    const r = await post(chargeBody({ sku: PAID[0], price: String(Number(PAID[1].amount)) }), ENV);
    assert.equal(r.status, 200);
    assert.equal(calls[0].body.createTransactionRequest.transactionRequest.amount, PAID[1].amount);
  } finally { globalThis.fetch = realFetch; }
});

test("checkout-charge refuses a tampered price, an unknown plan, a free plan, and a missing plan; nothing is charged", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = fakeAuthnet(calls);
  try {
    const cases = [
      [chargeBody({ sku: PAID[0], price: "0.01" }), "price_mismatch"],
      [chargeBody({ sku: PAID[0], amount: "1" }), "price_mismatch"],
      [chargeBody({ sku: PAID[0], price: "abc" }), "price_mismatch"],
      [chargeBody({ sku: "made-up", price: "0.01" }), "unknown_plan"],
      [chargeBody({ price: "5.00" }), "unknown_plan"]
    ];
    if (FREE) cases.push([chargeBody({ sku: FREE[0] }), "free_plan"]);
    for (const [body, err] of cases) {
      const r = await post(body, ENV);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.ok, false);
      assert.equal(r.data.error, err, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("chargeCard refuses an order whose amount did not come from the price table", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = fakeAuthnet(calls);
  try {
    const r = await chargeCard(ENV, { site: SITE, amount: "0.01", invoiceNumber: "X" }, chargeBody({ price: "0.01" }));
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("PRICES_JSON can change or add a price without a code change; bad JSON is ignored", () => {
  const env = { PRICES_JSON: JSON.stringify({ [SITE]: { [PAID[0]]: "99.5", "new-plan": { amount: "7", label: "New" } } }) };
  assert.equal(priceTable(env)[SITE][PAID[0]].amount, "99.50");
  assert.equal(lookupPrice(SITE, "new-plan", env).amount, "7.00");
  assert.equal(lookupPrice(SITE, PAID[0], { PRICES_JSON: "{not json" }).amount, PAID[1].amount);
  const p = priceOrder({ site: SITE, sku: PAID[0] }, { sku: PAID[0] }, env);
  assert.equal(p.ok, true);
  assert.equal(p.order.amount, "99.50");
  assert.equal(p.order.priceSource, "server");
});
