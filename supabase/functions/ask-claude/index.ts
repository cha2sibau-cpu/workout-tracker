// supabase/functions/ask-claude/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPrompt, extractExerciseHistory, parseClaudeReply } from "./logic.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// This function is called cross-origin from the app's static frontend
// (a different origin than *.supabase.co), and the request carries a
// custom Authorization header, so the browser sends a CORS preflight
// (OPTIONS) before the real request. Without these headers on every
// response (including the preflight), the browser blocks the request
// before the frontend ever sees a reply, surfacing as "Failed to fetch".
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
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  let exerciseName: string;
  try {
    const body = await req.json();
    exerciseName = body.exerciseName;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!exerciseName || typeof exerciseName !== "string") {
    return jsonResponse({ error: "exerciseName is required" }, 400);
  }

  const { data: rows, error: dbErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(10);
  if (dbErr) {
    return jsonResponse({ error: dbErr.message }, 500);
  }

  const history = extractExerciseHistory(rows.map((r) => r.data), exerciseName);
  const prompt = buildPrompt(exerciseName, history);

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const claudeJson = await claudeRes.json();
  const text = claudeJson.content?.[0]?.text ?? "";

  let recommendation;
  try {
    recommendation = parseClaudeReply(text);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 502);
  }

  return jsonResponse(recommendation);
});
