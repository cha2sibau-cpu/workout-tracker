// supabase/functions/coach/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; note?: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface ChatMessage { role: "user" | "assistant"; content: string; }

export interface TodayExercise { name: string; targetReps: string; recSets: number; }

// A compact, roughly-constant-size summary — one line per exercise that has
// history — rather than raw per-set data for every session ever logged.
// This is what keeps the Claude request bounded regardless of how many
// months of sessions exist: the number of distinct exercises in the
// program is fixed (~20), it doesn't grow with time.
export function computeTrendSummary(sessions: SessionData[]): string {
  const byExercise = new Map<string, { date: string; kg: number; reps: string; rpe: string }[]>();

  for (const session of sessions) {
    for (const ex of session.exercises || []) {
      const filled = (ex.sets || []).filter((s) => s.kg && parseFloat(s.kg) > 0);
      if (!filled.length) continue;
      const last = filled[filled.length - 1];
      const list = byExercise.get(ex.name) || [];
      list.push({ date: session.date, kg: parseFloat(last.kg!), reps: last.reps || "?", rpe: last.rpe || "?" });
      byExercise.set(ex.name, list);
    }
  }

  const lines: string[] = [];
  for (const [name, entries] of byExercise) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const first = entries[0];
    const latest = entries[entries.length - 1];
    const direction = latest.kg > first.kg ? "up" : latest.kg < first.kg ? "down" : "flat";
    lines.push(
      `${name}: ${first.kg}kg (${first.date}) -> ${latest.kg}kg (${latest.date}), trend ${direction}, latest ${latest.reps} reps @ RPE ${latest.rpe}`
    );
  }
  return lines.length ? lines.join("\n") : "No exercise history logged yet.";
}

export const PLAN_RULES = `This is a 6-month, 4-phase periodisation program, 7-day rotating cycle (Pull, Mobility A, Lower/Core, Mobility B, Push, Rest, Push):
- Phase 1 (weeks 1-6): Structural base. 3 sets/exercise. RPE target 7-8. Focus: form, joint prep.
- Phase 2 (weeks 7-13): Strength accumulation. Add 1 set to main compounds. RPE target 8 for main lifts.
- Phase 3 (weeks 14-20): Strength peak. 4 sets across all main exercises. RPE target 8-8.5.
- Phase 4 (weeks 21-26): Deload + reset. Weeks 21-22: 60% of Phase 3 weights, 2 sets only (mandatory deload, non-optional). Weeks 23-26: reassess and plan next block.
- Hard ceilings, never exceed regardless of phase: Overhead DB press RPE 7. Bulgarian split squat RPE 7.5 (stop if knee tracks inward).`;

export function buildCoachPrompt(params: {
  phase: number;
  weekNum: number;
  dayType: string;
  isDeload: boolean;
  trendSummary: string;
  recentMessages: ChatMessage[];
  newMessage: string;
}): string {
  const { phase, weekNum, dayType, isDeload, trendSummary, recentMessages, newMessage } = params;

  const history = recentMessages
    .map((m) => `${m.role === "user" ? "Lifter" : "Coach"}: ${m.content}`)
    .join("\n");

  return [
    `You are a strength coach for a lifter following a structured long-term program. Act as their personal trainer across the whole program, not just one exercise.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a mandatory deload week — do not recommend increasing load." : ""}`,
    ``,
    `Recent progress across exercises:`,
    trendSummary,
    ``,
    history ? `Recent conversation:\n${history}\n` : ``,
    `Guiding principle: this is a multi-year program, not a race. Prioritize long-term, sustainable progress and injury prevention over fast short-term gains. Be conservative about recommending weight or rep increases, and explicitly flag anything that looks like too-rapid a load increase.`,
    ``,
    `Lifter: ${newMessage}`,
    ``,
    `Reply conversationally as their coach, in a few sentences. Do not reply with JSON — plain text only.`,
  ].join("\n");
}

// A note now lives once per exercise. Older sessions stored a note per set, so
// fall back to joining any per-set notes for backward compatibility.
export function exerciseNote(ex: ExerciseEntry): string {
  if (ex.note !== undefined && ex.note !== null) return String(ex.note).trim();
  const perSet = (ex.sets || [])
    .map((s) => (s.note || "").trim())
    .filter((n) => n.length > 0);
  return perSet.join(" · ");
}

// Detailed, human-readable dump of the most recent session that matches the
// given day type — the "previous same workout session" the recommendations
// should be grounded in. Returns a fallback line when there's no prior match.
export function summarizeLastSameTypeSession(
  sessions: SessionData[],
  dayType: string,
): string {
  const match = sessions
    .filter((s) => (s.dayType || "") === dayType)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!match) return `No prior ${dayType || "matching"} session logged yet.`;

  const lines: string[] = [`Last ${dayType} session (${match.date}):`];
  for (const ex of match.exercises || []) {
    const filled = (ex.sets || []).filter((s) => s.kg || s.reps);
    if (!filled.length) continue;
    const setStr = filled
      .map((s) => `${s.kg || "?"}kg×${s.reps || "?"}${s.rpe ? ` @RPE${s.rpe}` : ""}`)
      .join(", ");
    const note = exerciseNote(ex);
    lines.push(`- ${ex.name}: ${setStr}${note ? ` — note: "${note}"` : ""}`);
  }
  return lines.length > 1 ? lines.join("\n") : `No logged sets in the last ${dayType} session.`;
}

export function buildRecommendPrompt(params: {
  phase: number;
  weekNum: number;
  dayType: string;
  isDeload: boolean;
  lastSameTypeSummary: string;
  trendSummary: string;
  exercises: TodayExercise[];
}): string {
  const { phase, weekNum, dayType, isDeload, lastSameTypeSummary, trendSummary, exercises } = params;

  const exerciseList = exercises
    .map((e) => `- ${e.name} (target ${e.targetReps} reps, ${e.recSets} sets planned)`)
    .join("\n");

  return [
    `You are a strength coach generating per-exercise load recommendations for a lifter's workout today. Base every recommendation on their previous same-type session and the overall program rules below.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a MANDATORY deload week — do not recommend increasing load; prescribe ~60% of prior working weights." : ""}`,
    ``,
    `Previous same-type session (ground your recommendations in this):`,
    lastSameTypeSummary,
    ``,
    `Longer-term trend across exercises:`,
    trendSummary,
    ``,
    `Today's exercises:`,
    exerciseList,
    ``,
    `Guiding principle: this is a multi-year program. Prioritize long-term, sustainable progress and injury prevention over fast gains. Be conservative — only recommend a load increase when the last session clearly cleared the top of the rep range at a comfortable RPE, and never exceed the hard RPE ceilings above.`,
    ``,
    `For EACH exercise today, output a recommendation. "dir" is the load direction vs last session: "up" (add weight), "down" (reduce), "same" (hold), or "new" (no usable prior data — start conservative). "kg" is the recommended working weight in kg as a number (0 if unknown/bodyweight). "sets" is the number of working sets. "reps" is the target rep range string. "note" is one short sentence of rationale the lifter will see.`,
  ].join("\n");
}
