const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const AVATARS = {
  lenai: "ef9a01a2-e90f-4ebb-8c15-63c4aa849066",
  victor: "58920813-02a3-4a75-9b81-00ff577f74f0",
  elena: "b6b87c95-6142-4ce3-8b11-b2ac9d25b975",
  damian: "665f972b-6114-4d88-a958-e6e00448f3fd",
};

function liveKey(env) {
  return (
    env.LIVEAVATAR_API_KEY ||
    env.LIVEAVATAR_KEY ||
    env.LIVEAVATAR ||
    env.API_KEY ||
    env.MY_VARIABLE ||
    ""
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const db = env.DB || env.shadow_realm;

    if (request.method === "GET") {
      const names = Object.keys(env || {});
      return json({
        ok: true,
        service: "shadow-talk-api",
        hasDb: !!db,
        hasLiveKey: !!liveKey(env),
        envNames: names,
        characters: Object.keys(AVATARS),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "POST JSON" }, 405);
    }

    if (!db) return json({ error: "D1 binding missing" }, 500);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON body required" }, 400);
    }

    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();
    const character = String(body.character || "").trim().toLowerCase();

    if (action === "remember-get") {
      if (!email || !character) return json({ error: "email and character required" }, 400);
      const row = await db.prepare(
        "SELECT session_id, memory_id, updated FROM member_memory WHERE email = ? AND character = ?"
      )
        .bind(email, character)
        .first();
      return json({ ok: true, memory: row || null });
    }

    if (action === "remember-save") {
      if (!email || !character) return json({ error: "email and character required" }, 400);
      await db.prepare(
        `INSERT INTO member_memory (email, character, session_id, memory_id, updated)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email, character) DO UPDATE SET
           session_id = excluded.session_id,
           memory_id = excluded.memory_id,
           updated = excluded.updated`
      )
        .bind(email, character, String(body.session_id || ""), String(body.memory_id || ""), Date.now())
        .run();
      return json({ ok: true });
    }

    if (action === "session-start") {
      const key = liveKey(env);
      if (!key) return json({ error: "Add LIVEAVATAR_API_KEY secret on Production runtime" }, 500);
      if (!email || !character) return json({ error: "email and character required" }, 400);
      const avatar_id = String(body.avatar_id || AVATARS[character] || "");
      if (!avatar_id) return json({ error: "Unknown character. Use lenai, victor, elena, or damian." }, 400);

      const prev = await db.prepare(
        "SELECT session_id, memory_id FROM member_memory WHERE email = ? AND character = ?"
      )
        .bind(email, character)
        .first();

      const payload = {
        mode: "FULL",
        avatar_id,
        interactivity_type: "CONVERSATIONAL",
      };
      if (prev && (prev.memory_id || prev.session_id)) {
        payload.memory = {};
        if (prev.memory_id) payload.memory.session_memory_id = prev.memory_id;
        else payload.memory.prev_session_id = prev.session_id;
      }

      const la = await fetch("https://api.liveavatar.com/v1/sessions/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": key,
        },
        body: JSON.stringify(payload),
      });
      const data = await la.json().catch(() => ({}));
      if (!la.ok) return json({ error: "LiveAvatar token failed", detail: data }, 502);

      const session_id = data?.data?.session_id || data?.session_id || "";
      const memory_id =
        data?.data?.session_memory_id ||
        data?.data?.memory_id ||
        data?.session_memory_id ||
        prev?.memory_id ||
        "";
      if (session_id) {
        await db.prepare(
          `INSERT INTO member_memory (email, character, session_id, memory_id, updated)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(email, character) DO UPDATE SET
             session_id = excluded.session_id,
             memory_id = excluded.memory_id,
             updated = excluded.updated`
        )
          .bind(email, character, session_id, memory_id, Date.now())
          .run();
      }

      return json({
        ok: true,
        character,
        avatar_id,
        liveavatar: data,
        saved_session_id: session_id,
        reused: !!(prev && (prev.memory_id || prev.session_id)),
      });
    }

    return json({ error: "Unknown action" }, 400);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
