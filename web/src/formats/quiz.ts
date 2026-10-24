/**
 * quest.txt (XOR-0x55, Quiz_Load 0x40ffa0): one question per line, "<level 1-3> <text>? <J|N>".
 * The loader stores level-1 as 0..2 and the answer as 2 (J, yes) or 1 (N, no).
 */
export interface QuizQuestion {
  level: number;
  text: string;
  /** true = "J" (ja / yes) */
  answer: boolean;
}

export function parseQuiz(text: string): QuizQuestion[] {
  const out: QuizQuestion[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([123])\s+(.*\?)\s*([JjNn])\s*$/.exec(raw.trim());
    if (!m) continue;
    out.push({ level: Number(m[1]) - 1, text: m[2], answer: m[3].toUpperCase() === 'J' });
  }
  return out;
}
