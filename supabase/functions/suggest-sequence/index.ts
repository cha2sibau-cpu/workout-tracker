// supabase/functions/suggest-sequence/index.ts
//
// Powers the Today screen's "Suggest order / supersets" button. Given today's
// planned exercises (in program order), asks Claude for an optimized ordering
// plus safe superset pairings, returned as structured JSON. Advisory only — it
// never mutates the stored program.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildSequencePrompt, type ProgramExercise } from "../coach/logic.ts";

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

const SEQUENCE_SCHEMA = {
  type: "object",
  properties: {
    sequence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "reason"],
        additionalProperties: false,
      },
    },
    supersets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exercises: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["exercises", "reason"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["sequence", "supersets", "summary"],
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
    exercises?: ProgramExercise[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const exercises = Array.isArray(body.exercises) ? body.exercises : [];
  if (!exercises.length) return jsonResponse({ error: "exercises is required" }, 400);

  const prompt = buildSequencePrompt({
    phase: body.phase ?? 1,
    weekNum: body.weekNum ?? 1,
    dayType: body.dayType ?? "",
    isDeload: !!body.isDeload,
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
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: SEQUENCE_SCHEMA } },
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
      { error: `Claude returned no suggestion (stop_reason: ${claudeJson.stop_reason ?? "unknown"})` },
      502,
    );
  }

  let parsed: { sequence?: unknown; supersets?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Claude returned malformed JSON" }, 502);
  }

  return jsonResponse({
    sequence: parsed.sequence ?? [],
    supersets: parsed.supersets ?? [],
    summary: parsed.summary ?? "",
  });
});
