// supabase/functions/coach/logic.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCoachPrompt,
  buildRecommendPrompt,
  computeTrendSummary,
  exerciseNote,
  summarizeLastSameTypeSession,
} from "./logic.ts";

Deno.test("computeTrendSummary summarizes first-to-latest per exercise", () => {
  const sessions = [
    { date: "2026-01-01", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "15", reps: "12", rpe: "7" }] }] },
    { date: "2026-03-01", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "20", reps: "10", rpe: "8" }] }] },
  ];
  const summary = computeTrendSummary(sessions);
  assertStringIncludes(summary, "Lat Pulldown: 15kg (2026-01-01) -> 20kg (2026-03-01)");
  assertStringIncludes(summary, "trend up");
});

Deno.test("computeTrendSummary handles no history", () => {
  assertEquals(computeTrendSummary([]), "No exercise history logged yet.");
});

Deno.test("computeTrendSummary ignores sets with no weight logged", () => {
  const sessions = [
    { date: "2026-01-01", exercises: [{ name: "Hammer curl", sets: [{ kg: "", reps: "12", rpe: "" }] }] },
  ];
  assertEquals(computeTrendSummary(sessions), "No exercise history logged yet.");
});

Deno.test("buildCoachPrompt includes the deload warning when isDeload is true", () => {
  const prompt = buildCoachPrompt({
    phase: 4, weekNum: 21, dayType: "Push", isDeload: true,
    trendSummary: "n/a", recentMessages: [], newMessage: "Should I add weight to bench?",
  });
  assertStringIncludes(prompt, "mandatory deload week — do not recommend increasing load");
});

Deno.test("buildCoachPrompt omits the deload warning when isDeload is false", () => {
  const prompt = buildCoachPrompt({
    phase: 2, weekNum: 8, dayType: "Push", isDeload: false,
    trendSummary: "n/a", recentMessages: [], newMessage: "How am I doing?",
  });
  assertEquals(prompt.includes("mandatory deload week"), false);
});

Deno.test("buildCoachPrompt includes recent conversation, trend summary, and the safety-first principle", () => {
  const prompt = buildCoachPrompt({
    phase: 1, weekNum: 2, dayType: "Pull", isDeload: false,
    trendSummary: "Lat Pulldown: 15kg -> 20kg, trend up",
    recentMessages: [{ role: "user", content: "I tweaked my shoulder last week" }],
    newMessage: "Can I increase weight on rows?",
  });
  assertStringIncludes(prompt, "Lat Pulldown: 15kg -> 20kg, trend up");
  assertStringIncludes(prompt, "I tweaked my shoulder last week");
  assertStringIncludes(prompt, "Prioritize long-term, sustainable progress");
  assertStringIncludes(prompt, "Can I increase weight on rows?");
});

Deno.test("exerciseNote reads the per-exercise note", () => {
  assertEquals(exerciseNote({ name: "DB bench press", note: "shoulder felt good", sets: [] }), "shoulder felt good");
});

Deno.test("exerciseNote falls back to joining legacy per-set notes", () => {
  const ex = { name: "DB bench press", sets: [{ note: "set 1 easy" }, { note: "" }, { note: "grip slipped" }] };
  assertEquals(exerciseNote(ex), "set 1 easy · grip slipped");
});

Deno.test("summarizeLastSameTypeSession picks the most recent matching session", () => {
  const sessions = [
    { date: "2026-01-04", dayType: "Push", exercises: [{ name: "DB bench press", note: "solid", sets: [{ kg: "22", reps: "8", rpe: "8" }] }] },
    { date: "2026-01-01", dayType: "Push", exercises: [{ name: "DB bench press", sets: [{ kg: "20", reps: "8" }] }] },
    { date: "2026-01-03", dayType: "Pull", exercises: [{ name: "Lat Pulldown", sets: [{ kg: "40", reps: "10" }] }] },
  ];
  const summary = summarizeLastSameTypeSession(sessions, "Push");
  assertStringIncludes(summary, "Last Push session (2026-01-04)");
  assertStringIncludes(summary, "DB bench press: 22kg×8 @RPE8");
  assertStringIncludes(summary, 'note: "solid"');
  // The older Push session and the Pull session must not appear.
  assertEquals(summary.includes("20kg"), false);
  assertEquals(summary.includes("Lat Pulldown"), false);
});

Deno.test("summarizeLastSameTypeSession reports when no matching session exists", () => {
  assertEquals(
    summarizeLastSameTypeSession([], "Push"),
    "No prior Push session logged yet.",
  );
});

Deno.test("buildRecommendPrompt lists exercises, program rules, and deload guard", () => {
  const prompt = buildRecommendPrompt({
    phase: 4, weekNum: 21, dayType: "Push", isDeload: true,
    lastSameTypeSummary: "Last Push session (2026-01-04): DB bench press: 22kg×8",
    trendSummary: "DB bench press: 18kg -> 22kg, trend up",
    exercises: [{ name: "DB bench press", targetReps: "8–10", recSets: 2 }],
  });
  assertStringIncludes(prompt, "DB bench press (target 8–10 reps, 2 sets planned)");
  assertStringIncludes(prompt, "Last Push session (2026-01-04)");
  assertStringIncludes(prompt, "MANDATORY deload week");
  assertStringIncludes(prompt, "6-month, 4-phase periodisation program");
});
