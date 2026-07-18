// supabase/functions/recommend/index.ts
//
// Generates per-exercise load recommendations for today's workout by asking
// Claude, grounded in the lifter's previous same-type session and the overall
// program rules. Returns one batched response for the whole workout (not one
// request per exercise) so the Today screen makes a single call.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildRecommendPrompt,
  computeTrendSummary,
  summarizeLastSameTypeSession,
  type TodayExercise,
} from "../coach/logic.ts";

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

const REC_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          dir: { type: "string", enum: ["up", "down", "same", "new"] },
          kg: { type: "number" },
          sets: { type: "integer" },
          reps: { type: "string" },
          note: { type: "string" },
        },
        required: ["name", "dir", "kg", "sets", "reps", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["recommendations"],
  additionalProperties: false,
};

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

  let body: {
    phase?: number;
    weekNum?: number;
    dayType?: string;
    isDeload?: boolean;
    exercises?: TodayExercise[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const exercises = Array.isArray(body.exercises) ? body.exercises : [];
  if (!exercises.length) return jsonResponse({ error: "exercises is required" }, 400);
  const dayType = body.dayType ?? "";

  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select("data")
    .order("date", { ascending: false })
    .limit(60);
  if (sessErr) return jsonResponse({ error: sessErr.message }, 500);

  const sessions = sessionRows.map((r) => r.data);
  const lastSameTypeSummary = summarizeLastSameTypeSession(sessions, dayType);
  const trendSummary = computeTrendSummary(sessions);

  const prompt = buildRecommendPrompt({
    phase: body.phase ?? 1,
    weekNum: body.weekNum ?? 1,
    dayType,
    isDeload: !!body.isDeload,
    lastSameTypeSummary,
    trendSummary,
    exercises,
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
      max_tokens: 2048,
      // No extended thinking: keeps latency down and avoids the token budget
      // being consumed before any output block is produced. The structured
      // output schema guarantees valid JSON.
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: REC_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: `Claude API error: ${errText}` }, 502);
  }

  const claudeJson = await claudeRes.json();
  const textBlock = (claudeJson.content ?? []).find(
    (b: { type?: string; text?: string }) => b.type === "text",
  );
  const raw = textBlock?.text ?? "";
  if (!raw) {
    console.error("claude returned no text content: " + JSON.stringify(claudeJson));
    return jsonResponse(
      { error: `Claude returned no recommendations (stop_reason: ${claudeJson.stop_reason ?? "unknown"})` },
      502,
    );
  }

  let parsed: { recommendations?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Claude returned malformed JSON" }, 502);
  }

  return jsonResponse({ recommendations: parsed.recommendations ?? [] });
});
