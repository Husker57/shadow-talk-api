// Authorize.net checkout + refund webhook tests: node --test test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { AFF_BASE_DEFAULT } from "../src/affiliate.js";

const SITE = "shadowrealm.co", SEG = "shadowrealm", SKU = "gold", AMOUNT = "9.99";
const SIGKEY = "A1B2C3D4E5F6".repeat(10) + "A1B2C3D4"; // 128 hex chars, test only

function kv() { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; }
function env(extra) {
  return Object.assign({ AUTHORIZE_API_LOGIN_ID: "login123", AUTHORIZE_TRANSACTION_KEY: "txkey-secret", AUTHORIZE_CLIENT_KEY: "pubclient", AUTHORIZE_SIGNATURE_KEY: SIGKEY, AFF_SIGNING_SECRET: "s", ORDERS: kv(), ANET_ADMIN_TOKEN: "t".repeat(32) }, extra || {});
}
function mock(calls, details) {
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push({ url: u, body: init && init.body });
    if (u.includes("authorize.net/xml")) {
      const b = JSON.parse(init.body);
      if (b.getTransactionDetailsRequest) return new Response(JSON.stringify({ transaction: details || null, messages: { resultCode: "Ok" } }));
      return new Response(JSON.stringify({ transactionResponse: { responseCode: "1", transId: "T900", authCode: "OK" }, messages: { resultCode: "Ok" } }));
    }
    if (u.startsWith(AFF_BASE_DEFAULT)) return new Response(JSON.stringify({ ok: true }));
    return new Response("{}");
  };
}
async function sign(raw) {
  const bytes = new Uint8Array(SIGKEY.match(/../g).map((h) => parseInt(h, 16)));
  const k = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw));
  return "sha512=" + [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
const post = (body) => new Request("https://api.test/", { method: "POST", body: JSON.stringify(body) });
async function hook(e, evt, badSig) {
  const raw = JSON.stringify(evt);
  return worker.fetch(new Request("https://api.test/anet-webhook", { method: "POST", body: raw, headers: { "X-ANET-Signature": badSig ? "sha512=00" : await sign(raw) } }), e, { waitUntil() {} });
}
async function buy(e, calls) {
  const r = await worker.fetch(post({ action: "checkout-charge", site: SEG, sku: SKU, price: AMOUNT, name: "T", email: "t@example.com", dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: "tok", ref: "RA-TEST1", rclid: "rcl_1" }), e, { waitUntil: (p) => p });
  return r.json();
}

test("checkout-config exposes only the public Accept.js fields", async () => {
  const r = await (await worker.fetch(post({ action: "checkout-config" }), env(), {})).json();
  assert.equal(r.apiLoginID, "login123");
  assert.equal(r.clientKey, "pubclient");
  assert.equal(r.sandbox, false);
  assert.match(r.acceptUI, /^https:\/\/js\.authorize\.net\/v3\/AcceptUI\.js$/);
  assert.ok(!JSON.stringify(r).includes("txkey-secret"));
});

test("paid charge issues a plan code and records site, plan, invoice, ref", async () => {
  const calls = []; mock(calls); const e = env();
  const d = await buy(e, calls);
  assert.equal(d.ok, true);
  assert.match(d.planCode, /^[A-Z]+-[A-Z0-9]{8}$/);
  const plan = JSON.parse(e.ORDERS.m.get("plan:" + d.planCode));
  assert.equal(plan.site, SITE); assert.equal(plan.sku, SKU); assert.equal(plan.ref, "RA-TEST1"); assert.equal(plan.transId, "T900");
  assert.equal(JSON.parse(e.ORDERS.m.get("txn:T900")).code, d.planCode);
});

test("webhook rejects a bad signature", async () => {
  const r = await hook(env(), { eventType: "net.authorize.payment.void.created", payload: { id: "T900" } }, true);
  assert.equal(r.status, 401);
});

test("void of our charge reverses the commission and turns the plan off", async () => {
  const calls = []; mock(calls); const e = env();
  const d = await buy(e, calls);
  calls.length = 0;
  const r = await hook(e, { notificationId: "n1", eventType: "net.authorize.payment.void.created", payload: { id: "T900", authAmount: Number(AMOUNT) } });
  assert.equal(r.status, 200);
  const rev = calls.find((c) => c.url === AFF_BASE_DEFAULT + "/api/conversions/reverse");
  assert.ok(rev); const b = JSON.parse(rev.body);
  assert.equal(b.site, SITE); assert.equal(b.refundCents, undefined);
  assert.equal(e.ORDERS.m.get("plan:" + d.planCode), undefined);
  const again = await (await hook(e, { notificationId: "n1", eventType: "net.authorize.payment.void.created", payload: { id: "T900" } })).json();
  assert.equal(again.duplicate, true);
});

test("partial refund (found via transaction details) reverses part and keeps the plan", async () => {
  const calls = []; mock(calls, { transId: "R1", refTransId: "T900" }); const e = env();
  const d = await buy(e, calls);
  calls.length = 0;
  const r = await hook(e, { notificationId: "n2", eventType: "net.authorize.payment.refund.created", payload: { id: "R1", authAmount: 1.0 } });
  assert.equal(r.status, 200);
  const b = JSON.parse(calls.find((c) => c.url.endsWith("/api/conversions/reverse")).body);
  assert.equal(b.refundCents, 100);
  assert.equal(JSON.parse(e.ORDERS.m.get("plan:" + d.planCode)).status, "partially_refunded");
});

test("refund of another site's transaction is ignored with 200", async () => {
  const calls = []; mock(calls, { transId: "R9", refTransId: "OTHER" });
  const r = await hook(env(), { notificationId: "n3", eventType: "net.authorize.payment.refund.created", payload: { id: "R9", authAmount: 5 } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, "not a transaction from this site");
  assert.equal(calls.filter((c) => c.url.startsWith(AFF_BASE_DEFAULT)).length, 0);
});

test("admin actions need the token", async () => {
  const r = await worker.fetch(post({ action: "anet-status", token: "nope" }), env(), {});
  assert.equal(r.status, 401);
});
