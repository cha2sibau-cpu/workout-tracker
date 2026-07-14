// supabase/functions/coach/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCoachPrompt, computeTrendSummary, type ChatMessage } from "./logic.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);

  let body: { message?: string; phase?: number; weekNum?: number; dayType?: string; isDeload?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { message, phase, weekNum, dayType, isDeload } = body;
  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "message is required" }, 400);
  }

  const { error: insertUserErr } = await supabase
    .from("chat_messages")
    .insert({ role: "user", content: message });
  if (insertUserErr) return jsonResponse({ error: insertUserErr.message }, 500);

  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(40);
  if (sessErr) return jsonResponse({ error: sessErr.message }, 500);

  // Fetch the last 20 messages (newest first, includes the one just
  // inserted above), then drop that just-inserted message so
  // "recent conversation" reflects only what came before it.
  const { data: messageRows, error: msgErr } = await supabase
    .from("chat_messages")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(20);
  if (msgErr) return jsonResponse({ error: msgErr.message }, 500);

  const recentMessages = (messageRows as ChatMessage[]).slice().reverse().slice(0, -1);
  const trendSummary = computeTrendSummary(sessionRows.map((r) => r.data));

  const prompt = buildCoachPrompt({
    phase: phase ?? 1,
    weekNum: weekNum ?? 1,
    dayType: dayType ?? "",
    isDeload: !!isDeload,
    trendSummary,
    recentMessages,
    newMessage: message,
  });

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const claudeJson = await claudeRes.json();
  const reply = claudeJson.content?.[0]?.text ?? "";

  const { error: insertReplyErr } = await supabase
    .from("chat_messages")
    .insert({ role: "assistant", content: reply });
  if (insertReplyErr) return jsonResponse({ error: insertReplyErr.message }, 500);

  return jsonResponse({ reply });
});
