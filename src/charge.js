export function authnetEnv(env) {
  return {
    login: env.AUTHORIZE_API_LOGIN_ID || env.AUTHNET_API_LOGIN_ID || "",
    key: env.AUTHORIZE_TRANSACTION_KEY || env.AUTHNET_TRANSACTION_KEY || "",
    client: env.AUTHORIZE_CLIENT_KEY || env.AUTHNET_CLIENT_KEY || "",
    sandbox: String(env.AUTHORIZE_SANDBOX || "false").toLowerCase() === "true"
  };
}

export function shadowOrder(body) {
  const sku = String(body.sku || body.plan || "visit").slice(0, 12);
  const amount = String(body.price || body.amount || "").replace(/[^0-9.]/g, "");
  const invoiceNumber = ("SHADOW" + sku + Date.now().toString(36)).slice(0, 20);
  return { ok: true, site: "shadowrealm", siteCode: "SHADOW", sku, amount, name: String(body.name || "").slice(0, 80), email: String(body.email || "").slice(0, 120), invoiceNumber, description: "SHADOW " + sku };
}

export async function chargeCard(env, order, body) {
  const cred = authnetEnv(env);
  if (!cred.login || !cred.key) return { ok: false, error: "Authorize.net keys are not on this Worker." };
  const descriptor = String(body.dataDescriptor || "");
  const dataValue = String(body.dataValue || "");
  if (!descriptor || !dataValue) return { ok: false, error: "Card was not tokenized." };
  const amount = Number(order.amount || body.price || 0).toFixed(2);
  if (!Number(amount)) return { ok: false, error: "Amount missing." };
  const url = cred.sandbox ? "https://apitest.authorize.net/xml/v1/request.api" : "https://api.authorize.net/xml/v1/request.api";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createTransactionRequest: {
        merchantAuthentication: { name: cred.login, transactionKey: cred.key },
        refId: String(Date.now()),
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount,
          payment: { opaqueData: { dataDescriptor: descriptor, dataValue } },
          order: { invoiceNumber: String(order.invoiceNumber).slice(0, 20), description: String(order.description || "SHADOW").slice(0, 255) },
          customer: { email: order.email || "" },
          billTo: { firstName: String(order.name || "Guest").slice(0, 50), lastName: "SHADOW" }
        }
      }
    })
  });
  const data = JSON.parse((await res.text()).replace(/^\uFEFF/, ""));
  const tr = data.transactionResponse || {};
  if (String(tr.responseCode) !== "1") {
    const msg = (tr.errors && tr.errors[0] && tr.errors[0].errorText) || (data.messages && data.messages.message && data.messages.message[0] && data.messages.message[0].text) || "Card was declined.";
    return { ok: false, error: msg, invoiceNumber: order.invoiceNumber, siteCode: "SHADOW" };
  }
  return { ok: true, transId: tr.transId, authCode: tr.authCode, invoiceNumber: order.invoiceNumber, site: "shadowrealm", siteCode: "SHADOW", amount, gateway: "2823475" };
}
