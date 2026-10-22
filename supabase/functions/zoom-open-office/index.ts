import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// GRIND Open Office - Zoom webhook receiver.
// Logs participant join/leave for the always-on room into public.zoom_attendance.
// Auth: Zoom's signature scheme (v0 HMAC), so verify_jwt is off by design.

const SECRET = Deno.env.get("ZOOM_WEBHOOK_SECRET_TOKEN") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!SECRET) return new Response("secret not configured", { status: 500 });

  const raw = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Zoom's endpoint validation handshake.
  if (body.event === "endpoint.url_validation") {
    const plainToken = (body.payload as { plainToken?: string })?.plainToken ?? "";
    return new Response(
      JSON.stringify({ plainToken, encryptedToken: await hmacHex(SECRET, plainToken) }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Verify the request actually came from Zoom.
  const ts = req.headers.get("x-zm-request-timestamp") ?? "";
  const got = req.headers.get("x-zm-signature") ?? "";
  const want = `v0=${await hmacHex(SECRET, `v0:${ts}:${raw}`)}`;
  if (!timingSafeEqual(got, want)) return new Response("bad signature", { status: 401 });

  const evt = String(body.event ?? "");
  const action = evt.endsWith("participant_joined")
    ? "joined"
    : evt.endsWith("participant_left")
    ? "left"
    : null;
  if (!action) return new Response("ignored", { status: 200 });

  const obj = ((body.payload as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
  const p = (obj.participant ?? {}) as Record<string, unknown>;

  const row = {
    event: action,
    occurred_at: (p.join_time ?? p.leave_time ?? new Date().toISOString()) as string,
    meeting_id: obj.id ? String(obj.id) : null,
    meeting_uuid: (obj.uuid ?? null) as string | null,
    // Breakout rooms arrive as their own session; Zoom puts the room name in topic.
    room_name: (obj.topic ?? null) as string | null,
    participant_id: (p.participant_uuid ?? p.id ?? p.user_id ?? null) as string | null,
    participant_user_id: (p.user_id ?? null) as string | null,
    participant_name: (p.user_name ?? null) as string | null,
    participant_email: (p.email ?? null) as string | null,
    raw: body,
  };

  const { error } = await supabase
    .from("zoom_attendance")
    .upsert(row, { onConflict: "event,meeting_uuid,participant_id,occurred_at", ignoreDuplicates: true });

  if (error) {
    console.error("insert failed", error.message);
    return new Response("insert failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
