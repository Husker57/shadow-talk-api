// Affiliate hook tests: node --test test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { affFields, signBody, afterCharge, reportReversal, AFF_BASE_DEFAULT } from "../src/affiliate.js";

const SITE = "shadowrealm.co";
const SITE_KEY = "shadowrealm";
const SKU = "gold";
const AMOUNT = "9.99";

function mockFetch(calls, opts) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("authorize.net")) {
      const ok = !(opts && opts.decline);
      return new Response(JSON.stringify({ transactionResponse: ok ? { responseCode: "1", transId: "T123", authCode: "A1" } : { responseCode: "2", errors: [{ errorText: "Declined" }] }, messages: { resultCode: ok ? "Ok" : "Error" } }), { status: 200 });
    }
    if (String(url).startsWith(AFF_BASE_DEFAULT)) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
}
function env(extra) {
  const store = new Map();
  return Object.assign({ AUTHORIZE_API_LOGIN_ID: "x", AUTHORIZE_TRANSACTION_KEY: "y", AUTHORIZE_CLIENT_KEY: "z", AFF_SIGNING_SECRET: "test-secret", ORDERS: { put: async (k, v) => store.set(k, v), get: async (k) => store.get(k) || null }, _store: store }, extra || {});
}
function ctx() { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; }
function charge(extra) {
  return new Request("https://api.test/", { method: "POST", body: JSON.stringify(Object.assign({ action: "checkout-charge", site: SITE_KEY, sku: SKU, price: AMOUNT, name: "Test", email: "t@example.com", dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: "tok" }, extra || {})) });
}

test("affFields cleans ref and rclid", () => {
  assert.deepEqual(affFields({ ref: " ab-12<x> ", rclid: "c_1!" }), { ref: "AB-12X", rclid: "c_1" });
  assert.deepEqual(affFields({}), {});
});

test("paid charge with ref reports a signed conversion in waitUntil", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls);
  const c = ctx(); const e = env();
  const res = await worker.fetch(charge({ ref: "TESTREF", rclid: "clk1" }), e, c);
  assert.equal(res.status, 200);
  assert.equal(c.jobs.length, 1);
  await Promise.all(c.jobs);
  const aff = calls.find((x) => x.url === AFF_BASE_DEFAULT + "/api/conversions");
  assert.ok(aff, "conversion posted");
  const body = JSON.parse(aff.init.body);
  assert.equal(body.site, SITE);
  assert.equal(body.ref, "TESTREF");
  assert.equal(body.rclid, "clk1");
  assert.equal(body.amountCents, Math.round(Number(AMOUNT) * 100));
  assert.equal(aff.init.headers["X-Aff-Signature"], "sha256=" + (await signBody("test-secret", aff.init.body)));
});

test("browser price is not used for the commission amount", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls);
  const c = ctx();
  const res = await worker.fetch(charge({ ref: "TESTREF", price: "0.01" }), env(), c);
  assert.equal(res.status, 400); // price_mismatch, no charge, no conversion
  assert.equal(c.jobs.length, 0);
});

test("no ref, no secret, or declined card: no conversion", async () => {
  for (const [req, e, o] of [[charge(), env(), null], [charge({ ref: "TESTREF" }), env({ AFF_SIGNING_SECRET: "" }), null], [charge({ ref: "TESTREF" }), env(), { decline: true }]]) {
    const calls = []; globalThis.fetch = mockFetch(calls, o);
    const c = ctx();
    await worker.fetch(req, e, c);
    await Promise.all(c.jobs);
    assert.equal(calls.filter((x) => x.url.startsWith(AFF_BASE_DEFAULT)).length, 0);
  }
});

test("affiliate outage never breaks the charge", async () => {
  const calls = [];
  const base = mockFetch(calls);
  globalThis.fetch = async (url, init) => { if (String(url).startsWith(AFF_BASE_DEFAULT)) throw new Error("down"); return base(url, init); };
  const c = ctx();
  const res = await worker.fetch(charge({ ref: "TESTREF" }), env(), c);
  assert.equal(res.status, 200);
  await Promise.all(c.jobs); // swallowed
});

test("AFF_BASE_URL switches the endpoint; reversal is signed", async () => {
  const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
  await reportReversal(env({ AFF_BASE_URL: "https://partners.realm-studios.ai/" }), { site: SITE, orderId: "X1", refundCents: 500 });
  assert.equal(calls[0].url, "https://partners.realm-studios.ai/api/conversions/reverse");
  assert.equal(calls[0].init.headers["X-Aff-Signature"], "sha256=" + (await signBody("test-secret", calls[0].init.body)));
});
