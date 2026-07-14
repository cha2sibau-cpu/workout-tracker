// supabase/functions/coach/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface ChatMessage { role: "user" | "assistant"; content: string; }

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

const PLAN_RULES = `This is a 6-month, 4-phase periodisation program, 7-day rotating cycle (Pull, Mobility A, Lower/Core, Mobility B, Push, Rest, Push):
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
