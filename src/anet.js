/**
 * Authorize.net helpers shared by the Realm talk APIs.
 *
 * - anetPublicConfig: what the page needs for Accept.js / AcceptUI (API Login ID + public Client Key).
 *   Card numbers go from the browser straight to Authorize.net; this Worker only sees the one-time token.
 * - recordPaid: after a successful server-priced charge, issue a plan code and store
 *   plan:<CODE> and txn:<transId> in the ORDERS KV (site, plan, invoice, ref/rclid).
 * - handleAnetWebhook: POST /anet-webhook. Verifies X-ANET-Signature (HMAC-SHA512 with
 *   AUTHORIZE_SIGNATURE_KEY). On refund or void of one of OUR transactions it reverses the
 *   affiliate commission (reportReversal) and, on a full refund/void, turns the plan code off.
 * - handleAnetAdmin: anet-status / anet-webhook-register, guarded by ANET_ADMIN_TOKEN.
 */
import { authnetEnv } from "./charge.js";
import { reportReversal } from "./affiliate.js";

const XML_PROD = "https://api.authorize.net/xml/v1/request.api";
const XML_TEST = "https://apitest.authorize.net/xml/v1/request.api";
const REST_PROD = "https://api.authorize.net/rest/v1";
const REST_TEST = "https://apitest.authorize.net/rest/v1";
export const ANET_EVENTS = ["net.authorize.payment.refund.created", "net.authorize.payment.void.created"];

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}
function out(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", ...cors() } });
}

export function anetPublicConfig(env) {
  const c = authnetEnv(env);
  return {
    apiLoginID: c.login || "",
    clientKey: c.client || "",
    sandbox: !!c.sandbox,
    acceptUI: c.sandbox ? "https://jstest.authorize.net/v3/AcceptUI.js" : "https://js.authorize.net/v3/AcceptUI.js",
  };
}

export function makeCode(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return String(prefix || "REALM").toUpperCase() + "-" + s;
}

/** Store the paid order. Returns the plan code, or "" if no ORDERS KV is bound. */
export async function recordPaid(env, siteHost, prefix, order, paid) {
  if (!env.ORDERS || typeof env.ORDERS.put !== "function") return "";
  const code = makeCode(prefix);
  const rec = {
    site: siteHost,
    sku: order.sku,
    amount: order.amount,
    invoice: order.invoiceNumber,
    transId: String(paid.transId || ""),
    email: order.email || "",
    name: order.name || "",
    ref: order.ref || "",
    rclid: order.rclid || "",
    created: Date.now(),
    status: "paid",
  };
  await env.ORDERS.put("plan:" + code, JSON.stringify(rec));
  if (rec.transId) await env.ORDERS.put("txn:" + rec.transId, JSON.stringify({ ...rec, code }));
  if (rec.email) await env.ORDERS.put("email:" + rec.email.toLowerCase(), code);
  return code;
}

function hexToBytes(hex) {
  const h = String(hex).trim();
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2) return null;
  const outB = new Uint8Array(h.length / 2);
  for (let i = 0; i < outB.length; i++) outB[i] = parseInt(h.substr(i * 2, 2), 16);
  return outB;
}
async function hmac512Hex(keyBytes, raw) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** Authorize.net sends X-ANET-Signature: sha512=<HEX>. Accept the key as hex bytes or as text. */
export async function verifyAnetSignature(signatureKey, raw, header) {
  const got = String(header || "").replace(/^sha512=/i, "").trim().toUpperCase();
  if (!signatureKey || !got) return false;
  const keys = [];
  const hb = hexToBytes(signatureKey);
  if (hb) keys.push(hb);
  keys.push(new TextEncoder().encode(String(signatureKey).trim()));
  for (const k of keys) if (sameHex(await hmac512Hex(k, raw), got)) return true;
  return false;
}

async function xmlApi(env, payload) {
  const c = authnetEnv(env);
  const res = await fetch(c.sandbox ? XML_TEST : XML_PROD, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  return JSON.parse((await res.text()).replace(/^\uFEFF/, ""));
}
function auth(env) {
  const c = authnetEnv(env);
  return { name: c.login, transactionKey: c.key };
}
export async function getTransactionDetails(env, transId) {
  const d = await xmlApi(env, { getTransactionDetailsRequest: { merchantAuthentication: auth(env), transId: String(transId) } });
  return d && d.transaction ? d.transaction : null;
}

async function loadTxn(env, transId) {
  if (!transId || !env.ORDERS) return null;
  const raw = await env.ORDERS.get("txn:" + String(transId));
  return raw ? JSON.parse(raw) : null;
}

export async function handleAnetWebhook(req, env, hooks) {
  const key = String(env.AUTHORIZE_SIGNATURE_KEY || "").trim();
  if (!key) return out({ ok: false, error: "signature key not set" }, 503);
  const raw = await req.text();
  const ok = await verifyAnetSignature(key, raw, req.headers.get("x-anet-signature"));
  if (!ok) {
    if (env.ORDERS) await env.ORDERS.put("wh:last-bad", JSON.stringify({ at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 30 });
    return out({ ok: false, error: "bad signature" }, 401);
  }
  let evt = {};
  try { evt = JSON.parse(raw); } catch (e) { return out({ ok: false, error: "bad json" }, 400); }
  const type = String(evt.eventType || "");
  if (env.ORDERS) await env.ORDERS.put("wh:last", JSON.stringify({ at: Date.now(), type }), { expirationTtl: 60 * 60 * 24 * 30 });
  if (!ANET_EVENTS.includes(type)) return out({ ok: true, ignored: type || "no eventType" });
  if (!env.ORDERS) return out({ ok: true, ignored: "no ORDERS store" });
  const nid = String(evt.notificationId || "");
  if (nid && (await env.ORDERS.get("wh:" + nid))) return out({ ok: true, duplicate: true });
  const p = evt.payload || {};
  const id = String(p.id || "");
  let txn = null;
  let refundCents = null;
  let full = true;
  if (type.endsWith("void.created")) {
    txn = await loadTxn(env, id);
  } else {
    // Refund: the webhook carries the refund's own id; the original charge comes from transaction details.
    txn = await loadTxn(env, id);
    if (!txn) {
      try {
        const det = await getTransactionDetails(env, id);
        if (det && det.refTransId) txn = await loadTxn(env, det.refTransId);
      } catch (e) {
        console.log("anet details lookup failed", String((e && e.message) || e));
      }
    }
    const amt = Number(p.authAmount || 0);
    if (txn && amt > 0) {
      refundCents = Math.round(amt * 100);
      full = refundCents >= Math.round(Number(txn.amount || 0) * 100);
    }
  }
  if (!txn) {
    if (nid) await env.ORDERS.put("wh:" + nid, "not-ours", { expirationTtl: 60 * 60 * 24 * 30 });
    return out({ ok: true, ignored: "not a transaction from this site" });
  }
  let aff = { ok: true, skipped: "no affiliate" };
  if (txn.ref || txn.rclid) {
    try {
      aff = await reportReversal(env, { site: txn.site, orderId: txn.invoice, refundCents: full ? null : refundCents });
    } catch (e) {
      aff = { ok: false, error: String((e && e.message) || e) };
    }
    if (!aff.ok) {
      console.log("affiliate reversal failed", txn.site, aff.status || aff.error);
      return out({ ok: false, retry: true }, 500); // Authorize.net retries non-200 deliveries
    }
  }
  if (txn.code) {
    const planRaw = await env.ORDERS.get("plan:" + txn.code);
    if (planRaw) {
      const plan = JSON.parse(planRaw);
      if (full) await env.ORDERS.delete("plan:" + txn.code);
      else await env.ORDERS.put("plan:" + txn.code, JSON.stringify({ ...plan, status: "partially_refunded", refundCents }));
    }
  }
  if (hooks && typeof hooks.onReversed === "function") {
    try { await hooks.onReversed(txn, full, refundCents); } catch (e) { console.log("onReversed failed", String((e && e.message) || e)); }
  }
  await env.ORDERS.put("txn:" + id + ":" + type.split(".").slice(-2, -1)[0], JSON.stringify({ at: Date.now(), refundCents, full }));
  if (nid) await env.ORDERS.put("wh:" + nid, "done", { expirationTtl: 60 * 60 * 24 * 30 });
  return out({ ok: true, reversed: !!(txn.ref || txn.rclid), planOff: !!(full && txn.code) });
}

function tokenOk(env, given) {
  const want = String(env.ANET_ADMIN_TOKEN || "");
  const g = String(given || "");
  return want.length >= 24 && g.length === want.length && sameHex(want, g);
}

/** Admin-only: { action:"anet-status" | "anet-webhook-register" | "anet-webhook-ping", token } */
export async function handleAnetAdmin(body, env, selfUrl) {
  if (!tokenOk(env, body.token)) return out({ ok: false, error: "unauthorized" }, 401);
  const c = authnetEnv(env);
  const rest = c.sandbox ? REST_TEST : REST_PROD;
  const basic = "Basic " + btoa(c.login + ":" + c.key);
  if (body.action === "anet-status") {
    const t = await xmlApi(env, { authenticateTestRequest: { merchantAuthentication: auth(env) } });
    let hooks = null;
    try {
      const r = await fetch(rest + "/webhooks", { headers: { Authorization: basic } });
      const j = await r.json().catch(() => null);
      hooks = Array.isArray(j) ? j.map((w) => ({ url: w.url, status: w.status, eventTypes: w.eventTypes })) : { status: r.status };
    } catch (e) {
      hooks = { error: String(e.message || e) };
    }
    const last = env.ORDERS ? await env.ORDERS.get("wh:last") : null;
    const lastBad = env.ORDERS ? await env.ORDERS.get("wh:last-bad") : null;
    return out({ ok: true, sandbox: !!c.sandbox, auth: t && t.messages ? t.messages.resultCode : "unknown", signatureKey: !!env.AUTHORIZE_SIGNATURE_KEY, orders: !!env.ORDERS, webhooks: hooks, lastWebhook: last ? JSON.parse(last) : null, lastBadSignature: lastBad ? JSON.parse(lastBad) : null });
  }
  if (body.action === "anet-webhook-register") {
    const url = selfUrl.replace(/\/+$/, "") + "/anet-webhook";
    const list = await fetch(rest + "/webhooks", { headers: { Authorization: basic } }).then((r) => r.json()).catch(() => []);
    if (Array.isArray(list) && list.some((w) => w.url === url)) return out({ ok: true, already: true, url });
    const r = await fetch(rest + "/webhooks", { method: "POST", headers: { Authorization: basic, "Content-Type": "application/json" }, body: JSON.stringify({ name: "realm_refunds", url, eventTypes: ANET_EVENTS, status: "active" }) });
    const j = await r.json().catch(() => ({}));
    return out({ ok: r.ok, status: r.status, url, webhookId: j.webhookId || null, message: r.ok ? "" : (j.message || j.reason || ""), details: r.ok ? undefined : (Array.isArray(j.details) ? j.details.map((d) => String(d.message || "").slice(0, 200)) : undefined) }, r.ok ? 200 : 502);
  }
  if (body.action === "anet-webhook-ping") {
    // Authorize.net sends a signed test notification to our URL; the result lands in wh:last / wh:last-bad.
    const url = selfUrl.replace(/\/+$/, "") + "/anet-webhook";
    const list = await fetch(rest + "/webhooks", { headers: { Authorization: basic } }).then((r) => r.json()).catch(() => []);
    const mine = Array.isArray(list) ? list.find((w) => w.url === url) : null;
    if (!mine) return out({ ok: false, error: "webhook not registered", url }, 404);
    const before = env.ORDERS ? await env.ORDERS.get("wh:last") : null;
    const r = await fetch(rest + "/webhooks/" + mine.webhookId + "/pings", { method: "POST", headers: { Authorization: basic, "Content-Type": "application/json" } });
    const txt = (await r.text()).slice(0, 300);
    await new Promise((res) => setTimeout(res, 2500));
    const after = env.ORDERS ? await env.ORDERS.get("wh:last") : null;
    const lastBad = env.ORDERS ? await env.ORDERS.get("wh:last-bad") : null;
    return out({ ok: r.ok, pingStatus: r.status, pingBody: txt, webhookId: mine.webhookId, webhookStatus: mine.status, signedPingReceived: !!after && after !== before, lastWebhook: after ? JSON.parse(after) : null, lastBadSignature: lastBad ? JSON.parse(lastBad) : null });
  }
  return out({ ok: false, error: "unknown admin action" }, 400);
}
