const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CHARACTERS = {
  lenai: {
    avatar_id: "a18274af-db61-421c-977d-5dfeb725b8fe",
    voice_agent_id: "7ca88c75-e4d8-498b-941c-43de04abafb3",
  },
  victor: {
    avatar_id: "24931786-3965-44ab-8cdb-7cf3bb7eeec9",
    voice_agent_id: "111dcdcc-a2ae-49ca-9a98-0e8633a2e6e2",
  },
  elena: {
    avatar_id: "75933fd3-6e78-4a52-9fd6-1c82f7541a12",
    voice_agent_id: "efe5b6a8-39b3-4ab3-a0e9-dfc98aa0b46d",
  },
  damian: {
    avatar_id: "ba7c264f-4dcd-4417-b95e-edc9c350ed90",
    voice_agent_id: "476b0b97-c495-4eb7-b3c5-47a597c4889d",
  },
};

function liveKey(env) {
  return env.LIVEAVATAR_API_KEY || env.LIVEAVATAR_KEY || env.LIVEAVATAR || env.API_KEY || env.MY_VARIABLE || "";
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureDb(db) {
  if (!db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS member_memory (
      email TEXT NOT NULL, character TEXT NOT NULL, session_id TEXT, memory_id TEXT, updated INTEGER,
      PRIMARY KEY (email, character))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS members (
      email TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, created INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER)`),
  ]);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const db = env.DB || env.shadow_realm;
    const readyDb = db && typeof db.prepare === "function" ? db : null;
    if (readyDb) await ensureDb(readyDb);
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "shadow-talk-api",
        hasDb: !!readyDb,
        hasLiveKey: !!liveKey(env),
        envNames: Object.keys(env || {}),
        characters: CHARACTERS,
      });
    }
    if (request.method !== "POST") return json({ error: "POST JSON" }, 405);
    let body = {};
    try { body = await request.json(); } catch { return json({ error: "JSON body required" }, 400); }
    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();
    const character = String(body.character || "").trim().toLowerCase();
    const key = liveKey(env);

    if (action === "signup") {
      if (!readyDb) return json({ error: "D1 binding missing" }, 500);
      const password = String(body.password || "");
      if (!email || password.length < 8) return json({ error: "Email and 8+ character password required" }, 400);
      const exists = await readyDb.prepare("SELECT email FROM members WHERE email = ?").bind(email).first();
      if (exists) return json({ error: "Account already exists" }, 409);
      await readyDb.prepare("INSERT INTO members (email, pass_hash, created) VALUES (?, ?, ?)").bind(email, await sha256(password), Date.now()).run();
      const token = crypto.randomUUID();
      await readyDb.prepare("INSERT INTO sessions (token, email, created) VALUES (?, ?, ?)").bind(token, email, Date.now()).run();
      return json({ ok: true, email, token });
    }
    if (action === "login") {
      if (!readyDb) return json({ error: "D1 binding missing" }, 500);
      const password = String(body.password || "");
      if (!email || !password) return json({ error: "Email and password required" }, 400);
      const row = await readyDb.prepare("SELECT email, pass_hash FROM members WHERE email = ?").bind(email).first();
      if (!row || row.pass_hash !== await sha256(password)) return json({ error: "Email or password is wrong" }, 401);
      const token = crypto.randomUUID();
      await readyDb.prepare("INSERT INTO sessions (token, email, created) VALUES (?, ?, ?)").bind(token, email, Date.now()).run();
      return json({ ok: true, email, token });
    }
    if (action === "me") {
      if (!readyDb) return json({ error: "D1 binding missing" }, 500);
      const token = String(body.token || "");
      const row = await readyDb.prepare("SELECT email FROM sessions WHERE token = ?").bind(token).first();
      return json({ ok: !!row, email: row?.email || null });
    }
    if (action === "remember-get") {
      if (!readyDb) return json({ error: "D1 binding missing" }, 500);
      if (!email || !character) return json({ error: "email and character required" }, 400);
      const row = await readyDb.prepare(
        "SELECT session_id, memory_id, updated FROM member_memory WHERE email = ? AND character = ?"
      ).bind(email, character).first();
      return json({ ok: true, memory: row || null });
    }
    if (action === "session-start") {
      if (!key) return json({ error: "Add LIVEAVATAR_API_KEY secret on Production runtime" }, 500);
      if (!email || !character) return json({ error: "email and character required" }, 400);
      const who = CHARACTERS[character];
      if (!who) return json({ error: "Unknown character" }, 400);
      let prev = null;
      if (readyDb) {
        prev = await readyDb.prepare(
          "SELECT session_id, memory_id FROM member_memory WHERE email = ? AND character = ?"
        ).bind(email, character).first();
      }
      const payload = {
        mode: "FULL",
        avatar_id: who.avatar_id,
        interactivity_type: "CONVERSATIONAL",
        voice_agent: { id: who.voice_agent_id },
      };
      if (prev && (prev.memory_id || prev.session_id)) {
        payload.memory = {};
        if (prev.memory_id) payload.memory.session_memory_id = prev.memory_id;
        else payload.memory.prev_session_id = prev.session_id;
      }
      const la = await fetch("https://api.liveavatar.com/v1/sessions/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify(payload),
      });
      const data = await la.json().catch(() => ({}));
      if (!la.ok) return json({ error: "LiveAvatar token failed", detail: data }, 502);
      const session_id = data?.data?.session_id || data?.session_id || "";
      const memory_id = data?.data?.session_memory_id || data?.data?.memory_id || prev?.memory_id || "";
      if (readyDb && session_id) {
        await readyDb.prepare(
          `INSERT INTO member_memory (email, character, session_id, memory_id, updated)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(email, character) DO UPDATE SET
             session_id = excluded.session_id, memory_id = excluded.memory_id, updated = excluded.updated`
        ).bind(email, character, session_id, memory_id, Date.now()).run();
      }
      return json({
        ok: true,
        character,
        avatar_id: who.avatar_id,
        voice_agent_id: who.voice_agent_id,
        reusedMemory: !!(prev && (prev.memory_id || prev.session_id)),
        liveavatar: data,
        saved_session_id: session_id,
        memorySaved: !!(readyDb && session_id),
      });
    }
    return json({ error: "Unknown action" }, 400);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
