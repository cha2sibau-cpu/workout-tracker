// supabase/functions/ask-claude/logic.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPrompt, extractExerciseHistory, parseClaudeReply } from "./logic.ts";

Deno.test("extractExerciseHistory pulls only the matching exercise across sessions", () => {
  const sessions = [
    { date: "2026-07-10", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "20", reps: "12", rpe: "7" }] }] },
    { date: "2026-07-08", exercises: [{ name: "DB bench press", sets: [{ kg: "24", reps: "10", rpe: "8" }] }] },
  ];
  const history = extractExerciseHistory(sessions, "Lat Pulldown");
  assertEquals(history.length, 1);
  assertEquals(history[0].date, "2026-07-10");
});

Deno.test("buildPrompt includes notes so Claude can react to them", () => {
  const prompt = buildPrompt("Overhead DB press", [
    { date: "2026-07-10", sets: [{ kg: "18", reps: "8", rpe: "7", note: "left arm weaker" }] },
  ]);
  assertEquals(prompt.includes("left arm weaker"), true);
  assertEquals(prompt.includes("Overhead DB press"), true);
});

Deno.test("parseClaudeReply parses a valid JSON response", () => {
  const rec = parseClaudeReply('{"action":"hold","detail":"Stay at 18kg","rationale":"RPE already at cap."}');
  assertEquals(rec.action, "hold");
});

Deno.test("parseClaudeReply strips a markdown code fence if present", () => {
  const rec = parseClaudeReply('```json\n{"action":"increase_weight","detail":"Go to 22kg","rationale":"Hit top of range."}\n```');
  assertEquals(rec.action, "increase_weight");
});

Deno.test("parseClaudeReply throws on an invalid action", () => {
  assertThrows(() => parseClaudeReply('{"action":"nonsense","detail":"x","rationale":"y"}'));
});
