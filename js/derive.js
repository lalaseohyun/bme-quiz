// derive.js — state → live 파생 함수. 참가자에게 무엇이 나가는지는 여기서만 정한다.
import { pointsOf } from './score.js';

export const INITIAL_STATE = { phase: 'lobby', index: 0, open: false, revealed: false, asked: [] };

// RTDB는 빈 배열을 저장하지 않으므로 asked가 빠져 돌아올 수 있다.
export const normalizeState = s => ({
  ...INITIAL_STATE, ...(s || {}), asked: Object.values(s?.asked || [])
});

/** OX 문항은 화면용 보기를 ['O','X']로, 응답값은 'O'/'X'로 쓴다. 4지선다는 0~3. */
export const isOx = q => q.type === 'ox';
export const optionsOf = q => (isOx(q) ? ['O', 'X'] : q.choices);
export const valueAt = (q, i) => (isOx(q) ? ['O', 'X'][i] : i);

/** 해설 본문: explain + explainMore + explainList 를 줄 단위로 잇는다 (dom.paragraphs가 줄마다 문단을 만든다). */
export const explanationOf = q =>
  [q.explain, q.explainMore, ...(q.explainList || []).map(x => `· ${x}`)].filter(Boolean).join('\n');

/**
 * 보기는 한 번이라도 답안을 연 문제(asked)에만 넣는다.
 * answer·explain은 revealed일 때만 넣는다. 그 전에는 필드 자체가 없다.
 * hostNote·talk·preTalk·bridge 같은 진행자용 필드는 절대 넣지 않는다.
 */
export function deriveLive(state, questions, { ranking } = {}) {
  const s = normalizeState(state);
  if (s.phase === 'final') return ranking ? { phase: 'final', ranking } : { phase: 'final' };

  const q = questions[s.index];
  if (s.phase !== 'quiz' || !q) return { phase: 'lobby' };

  const live = {
    phase: 'quiz', id: q.id, label: q.label, category: q.category, type: q.type,
    index: s.index, total: questions.length, text: q.text,
    open: !!s.open, revealed: !!s.revealed,
    scored: q.scored !== false, points: pointsOf(q)
  };
  if (s.asked.includes(q.id) || s.revealed) live.choices = optionsOf(q);
  if (s.revealed) {
    live.answer = q.answer;
    live.explain = explanationOf(q);
  }
  return live;
}
