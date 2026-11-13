// 채점·순위 순수 함수 (DOM·DB 접근 없음). 진행자 화면과 node --test 양쪽에서 쓴다.

export const DEFAULT_POINTS = 100;

const isTeamKey = (k) => /^[1-9]\d*$/.test(k);

export function isValidChoice(c) {
  return (Number.isInteger(c) && c >= 0 && c <= 3) || c === 'O' || c === 'X';
}

// 유효 응답만 남긴다. 제출 수·보기별 집계·정답 표시·채점 모두 이 함수를 거친다.
export function realAnswers(answersForQid) {
  const out = {};
  if (!answersForQid || typeof answersForQid !== 'object') return out;
  for (const [k, v] of Object.entries(answersForQid)) {
    if (!isTeamKey(k) || !v || typeof v !== 'object') continue;
    if (!isValidChoice(v.choice)) continue;
    if (typeof v.ms !== 'number' || !Number.isFinite(v.ms) || v.ms < 0) continue;
    out[k] = { choice: v.choice, ms: v.ms };
  }
  return out;
}

export function pointsOf(q) {
  if (!q || q.scored === false) return 0;
  return typeof q.points === 'number' ? q.points : DEFAULT_POINTS;
}

// 보기별 선택 팀 수. choice형은 [n0..n3], OX는 { O, X }.
export function tally(q, answersForQid) {
  const real = realAnswers(answersForQid);
  const counts = q.type === 'ox' ? { O: 0, X: 0 } : [0, 0, 0, 0];
  for (const { choice } of Object.values(real)) {
    if (q.type === 'ox') { if (choice === 'O' || choice === 'X') counts[choice]++; }
    else if (typeof choice === 'number') counts[choice]++;
  }
  return counts;
}

// questions: 문항 배열, answers: { [qid]: { [teamNo]: {choice, ms} } },
// teams: { [teamNo]: {name} }, asked: { [qid]: true } (지금까지 공개된 문항)
// -> [{ team, name, score, ms, correct, rank }]  점수 내림차순, 동점은 정답 응답시간 합 오름차순.
export function rank(questions, answers, teams, asked) {
  const rows = {};
  for (const [k, t] of Object.entries(teams || {})) {
    if (!isTeamKey(k)) continue;
    rows[k] = { team: Number(k), name: (t && t.name) || `${k}팀`, score: 0, ms: 0, correct: 0 };
  }
  for (const q of questions || []) {
    if (!asked || !asked[q.id]) continue;
    const pts = pointsOf(q);
    if (pts === 0) continue; // 연습문제 등 점수 없는 문항
    const real = realAnswers(answers && answers[q.id]);
    for (const [k, a] of Object.entries(real)) {
      const row = rows[k];
      if (!row || a.choice !== q.answer) continue;
      row.score += pts;
      row.ms += a.ms;
      row.correct += 1;
    }
  }
  const list = Object.values(rows).sort((a, b) => b.score - a.score || a.ms - b.ms || a.team - b.team);
  list.forEach((r, i) => {
    const prev = list[i - 1];
    r.rank = prev && prev.score === r.score && prev.ms === r.ms ? prev.rank : i + 1;
  });
  return list;
}
