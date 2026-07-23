// supabase/functions/coach/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; note?: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface ChatMessage { role: "user" | "assistant"; content: string; }

export interface TodayExercise { name: string; targetReps: string; recSets: number; }

// The structured program context the frontend now sends so the coach can
// reason about the actual schedule and today's exercise ordering/supersets —
// data it previously never received.
export interface ProgramExercise { name: string; targetReps?: string; sets?: number; warning?: string | null; }
export interface ProgramContext {
  cycle?: string[];
  dayType?: string;
  isMobility?: boolean;
  isRest?: boolean;
  todayExercises?: ProgramExercise[];
}

function formatExerciseList(exercises: ProgramExercise[]): string {
  return exercises
    .map((e, i) => {
      const bits = [`${i + 1}. ${e.name}`];
      if (e.targetReps) bits.push(`target ${e.targetReps} reps`);
      if (e.sets) bits.push(`${e.sets} sets`);
      if (e.warning) bits.push(`⚠ ${e.warning}`);
      return bits.join(" — ");
    })
    .join("\n");
}

export function formatProgramContext(program?: ProgramContext): string {
  if (!program) return "";
  const parts: string[] = [];
  if (program.cycle && program.cycle.length) {
    parts.push(`Program weekly cycle (in order): ${program.cycle.join(" → ")}.`);
  }
  if (program.isRest) {
    parts.push(`Today (${program.dayType}) is a rest day — no exercises planned.`);
  } else if (program.todayExercises && program.todayExercises.length) {
    const label = program.isMobility
      ? "Today's mobility checklist (in order)"
      : "Today's planned exercises (in program order)";
    parts.push(`${label}:\n${formatExerciseList(program.todayExercises)}`);
  }
  return parts.join("\n");
}

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
  program?: ProgramContext;
}): string {
  const { phase, weekNum, dayType, isDeload, trendSummary, recentMessages, newMessage, program } = params;

  const history = recentMessages
    .map((m) => `${m.role === "user" ? "Lifter" : "Coach"}: ${m.content}`)
    .join("\n");

  const programBlock = formatProgramContext(program);

  return [
    `You are a strength coach for a lifter following a structured long-term program. Act as their personal trainer across the whole program, not just one exercise. You can see their full schedule and today's exercises in order, so you can advise on exercise sequencing and supersets when relevant.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a mandatory deload week — do not recommend increasing load." : ""}`,
    ``,
    programBlock ? `${programBlock}\n` : ``,
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

// Prompt for the dedicated "suggest order / supersets" button. Returns a
// structured recommendation (via the caller's JSON schema) rather than prose.
export function buildSequencePrompt(params: {
  phase: number;
  weekNum: number;
  dayType: string;
  isDeload: boolean;
  exercises: ProgramExercise[];
}): string {
  const { phase, weekNum, dayType, isDeload, exercises } = params;

  return [
    `You are a strength coach optimizing the exercise order for a lifter's workout today and identifying safe, effective superset pairings.`,
    ``,
    PLAN_RULES,
    ``,
    `Current state: Phase ${phase}, Week ${weekNum}, today's day type: ${dayType}.${isDeload ? " This is a mandatory deload week — keep intensity conservative." : ""}`,
    ``,
    `The exercises currently planned today, in their current order:`,
    formatExerciseList(exercises),
    ``,
    `Recommend the best order to perform these exercises: compound/heaviest and most technical lifts first, isolation work last, managing fatigue and respecting the RPE ceilings above. Then suggest any pairs or small groups that work well as supersets (e.g. non-competing muscle groups, or agonist/antagonist) to save time without compromising the key lifts — or return an empty supersets list if none are advisable today.`,
    ``,
    `Use only the exercise names exactly as given. For each exercise in "sequence" give a one-line reason. For each superset, list the exercise names and a one-line reason. "summary" is one or two sentences of overall guidance.`,
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
