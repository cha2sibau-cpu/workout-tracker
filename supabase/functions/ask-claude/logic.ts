// supabase/functions/ask-claude/logic.ts

export interface SetEntry { kg?: string; reps?: string; rpe?: string; note?: string; }
export interface ExerciseEntry { name: string; sets: SetEntry[]; }
export interface SessionData { date: string; dayType?: string; exercises: ExerciseEntry[]; }
export interface HistoryPoint { date: string; sets: SetEntry[]; }
export interface Recommendation {
  action: "increase_weight" | "hold" | "decrease_weight" | "increase_reps" | "swap_exercise";
  detail: string;
  rationale: string;
}

const VALID_ACTIONS = ["increase_weight", "hold", "decrease_weight", "increase_reps", "swap_exercise"];

export function extractExerciseHistory(sessions: SessionData[], exerciseName: string): HistoryPoint[] {
  return sessions
    .map((s) => {
      const ex = s.exercises?.find((e) => e.name === exerciseName);
      return ex ? { date: s.date, sets: ex.sets } : null;
    })
    .filter((h): h is HistoryPoint => h !== null);
}

export function buildPrompt(exerciseName: string, history: HistoryPoint[]): string {
  const lines = history.map((h) => {
    const setsDesc = h.sets
      .map((s) => `${s.kg || "?"}kg x ${s.reps || "?"} reps @ RPE ${s.rpe || "?"}${s.note ? ` (note: "${s.note}")` : ""}`)
      .join("; ");
    return `${h.date}: ${setsDesc}`;
  });

  return [
    `You are a strength coach reviewing progress on "${exerciseName}".`,
    `Recent session history (most recent first):`,
    lines.length ? lines.join("\n") : "No prior history logged for this exercise.",
    ``,
    `Based on this history, including any freeform notes the lifter left, decide whether to increase weight, hold, decrease weight, increase reps, or swap the exercise for something else. Pay special attention to notes about pain, fatigue, or asymmetry (e.g. one side being weaker) — these should override a pure numbers-based progression.`,
    `Reply with ONLY a JSON object, no other text, matching exactly:`,
    `{"action": "increase_weight" | "hold" | "decrease_weight" | "increase_reps" | "swap_exercise", "detail": "<short specific instruction>", "rationale": "<one or two sentence reason>"}`,
  ].join("\n");
}

export function parseClaudeReply(text: string): Recommendation {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(trimmed);
  if (!VALID_ACTIONS.includes(parsed.action) || typeof parsed.detail !== "string" || typeof parsed.rationale !== "string") {
    throw new Error(`Unexpected Claude response shape: ${text}`);
  }
  return parsed as Recommendation;
}
