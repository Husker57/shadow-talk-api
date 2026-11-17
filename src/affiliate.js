/**
 * Realm affiliate hooks (realm-affiliates Worker).
 * Based on realm-affiliates/src/client/sign.js.
 *
 * One config value: AFF_BASE_URL (Worker var) or AFF_BASE_DEFAULT below.
 * Switch it to https://partners.realm-studios.ai once that domain is attached.
 *
 * Secret: AFF_SIGNING_SECRET on this Worker must equal AFF_SITE_SECRETS[site]
 * on the realm-affiliates Worker. Never put it in a page.
 *
 * Reporting never blocks or breaks a charge: it runs in ctx.waitUntil,
 * has a 4 s timeout, and swallows errors.
 */
export const AFF_BASE_DEFAULT = "https://realm-affiliates.spring-fog-46d4.workers.dev";

export function affBase(env) {
  return String((env && env.AFF_BASE_URL) || AFF_BASE_DEFAULT).replace(/\/+$/, "");
}

/** ref / rclid from a checkout or lead body, cleaned the same way as ref.js. */
export function affFields(body) {
  const b = body || {};
  const ref = String(b.ref || b.affiliate || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16);
  const rclid = String(b.rclid || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const out = {};
  if (ref) out.ref = ref;
  if (rclid) out.rclid = rclid;
  return out;
}

export async function signBody(secret, raw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(raw)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(env, path, body) {
  const secret = String((env && env.AFF_SIGNING_SECRET) || "");
  if (!secret) return { ok: false, error: "AFF_SIGNING_SECRET is not set" };
  const raw = JSON.stringify(body);
  const hex = await signBody(secret, raw);
  const res = await fetch(affBase(env) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Aff-Signature": "sha256=" + hex },
    body: raw,
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function reportConversion(env, payload) {
  const body = {
    site: payload.site,
    orderId: String(payload.orderId),
    ref: payload.ref || "",
    rclid: payload.rclid || "",
    amountCents: payload.amountCents,
    currency: payload.currency || "USD",
    kind: payload.kind || "first_payment",
    occurredAt: payload.occurredAt || new Date().toISOString(),
  };
  if (payload.costCents != null) body.costCents = payload.costCents;
  return post(env, "/api/conversions", body);
}

/** Call when a charge is refunded or voided (full or partial). */
export function reportReversal(env, payload) {
  const body = { site: payload.site, orderId: String(payload.orderId) };
  if (payload.refundCents != null) body.refundCents = payload.refundCents;
  return post(env, "/api/conversions/reverse", body);
}

/**
 * After a successful server-priced charge. No-op when the buyer has no ref/rclid
 * or the signing secret is missing.
 */
export function afterCharge(env, ctx, site, order, body) {
  const a = affFields(body);
  if (!a.ref && !a.rclid) return;
  if (!env || !env.AFF_SIGNING_SECRET) return;
  if (!order || order.priceSource !== "server") return;
  const amountCents = Math.round(Number(order.amount || 0) * 100);
  if (!(amountCents > 0)) return;
  const p = reportConversion(env, { site, orderId: order.invoiceNumber, ref: a.ref, rclid: a.rclid, amountCents })
    .then((r) => { if (!r.ok) console.log("affiliate conversion not recorded", site, r.status || r.error); })
    .catch((e) => console.log("affiliate conversion error", site, String((e && e.message) || e)));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  else return p;
}
