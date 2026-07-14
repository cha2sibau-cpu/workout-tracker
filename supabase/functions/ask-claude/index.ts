// supabase/functions/ask-claude/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPrompt, extractExerciseHistory, parseClaudeReply } from "./logic.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401 });
  }

  let exerciseName: string;
  try {
    const body = await req.json();
    exerciseName = body.exerciseName;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  if (!exerciseName || typeof exerciseName !== "string") {
    return new Response(JSON.stringify({ error: "exerciseName is required" }), { status: 400 });
  }

  const { data: rows, error: dbErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(10);
  if (dbErr) {
    return new Response(JSON.stringify({ error: dbErr.message }), { status: 500 });
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
    return new Response(JSON.stringify({ error: `Claude API error: ${errText}` }), { status: 502 });
  }

  const claudeJson = await claudeRes.json();
  const text = claudeJson.content?.[0]?.text ?? "";

  let recommendation;
  try {
    recommendation = parseClaudeReply(text);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502 });
  }

  return new Response(JSON.stringify(recommendation), {
    headers: { "content-type": "application/json" },
  });
});
