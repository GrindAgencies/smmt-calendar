// twin-telegram edge function — pushes Twin AI messages to Chris's Telegram bot
// Required secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Optional secret: TELEGRAM_DEFAULT_PARSE_MODE (default: Markdown)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const DEFAULT_PARSE_MODE = Deno.env.get("TELEGRAM_DEFAULT_PARSE_MODE") || "Markdown";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function jsonRes(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonRes({ error: "POST only" }, 405);

  if (!BOT_TOKEN || !CHAT_ID) {
    return jsonRes({
      ok: false,
      stub: true,
      error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in Supabase secrets",
    });
  }

  let body: any;
  try { body = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }

  const message = body.message || body.text;
  if (!message) return jsonRes({ error: "missing message" }, 400);

  const urgent = body.urgent === true;
  const parseMode = body.parse_mode || DEFAULT_PARSE_MODE;
  const chatId = body.chat_id || CHAT_ID;

  // Optionally prefix urgent messages
  const finalText = urgent ? `🚨 *URGENT*\n\n${message}` : message;

  // Telegram has a 4096 char limit per message — truncate if needed
  const safeText = finalText.length > 4000 ? finalText.slice(0, 3990) + "… [truncated]" : finalText;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeText,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return jsonRes({ ok: false, error: data.description || `HTTP ${res.status}`, telegram_response: data });
    }
    return jsonRes({ ok: true, message_id: data.result?.message_id });
  } catch (err: any) {
    return jsonRes({ ok: false, error: String(err.message || err) });
  }
});
