import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rank, realAnswers, tally, pointsOf } from '../js/score.js';
import { deriveLive } from '../js/derive.js';

const data = JSON.parse(readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8'));
const Q = data.questions;
const byId = Object.fromEntries(Q.map((q) => [q.id, q]));
const teams = { 1: { name: '가' }, 2: { name: '나' }, 3: { name: '다' } };
const all = Object.fromEntries(Q.map((q) => [q.id, true]));

test('realAnswers: 잘못된 응답은 무시한다', () => {
  const r = realAnswers({
    1: { choice: 1, ms: 1000 },
    2: { choice: 'O', ms: 5 },
    3: { choice: 4, ms: 10 },        // 범위 밖
    4: { choice: '1', ms: 10 },      // 문자열 숫자
    5: { choice: 0 },                // ms 없음
    6: { choice: 0, ms: 'x' },       // ms 문자열
    updatedAt: { choice: 0, ms: 1 }, // 팀 번호가 아닌 키
    0: { choice: 0, ms: 1 },         // 0번 팀 없음
    7: null,
  });
  assert.deepEqual(Object.keys(r).sort(), ['1', '2']);
});

test('realAnswers: 리셋 뒤 빈 객체/없음', () => {
  assert.deepEqual(realAnswers({}), {});
  assert.deepEqual(realAnswers(null), {});
  assert.deepEqual(realAnswers(undefined), {});
});

test('rank: 리셋 뒤 빈 answers면 모두 0점 공동 1위', () => {
  const r = rank(Q, {}, teams, all);
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.score === 0 && x.ms === 0 && x.rank === 1));
  assert.deepEqual(rank(Q, null, teams, all).map((x) => x.rank), [1, 1, 1]);
});

test('rank: 연습문제(scored:false)는 점수에서 제외', () => {
  const answers = { p0: { 1: { choice: 0, ms: 100 }, 2: { choice: 1, ms: 50 } } };
  const r = rank(Q, answers, teams, all);
  assert.ok(r.every((x) => x.score === 0 && x.ms === 0 && x.correct === 0));
  assert.equal(pointsOf(byId.p0), 0);
});

test('rank: 기본 100점, BONUS 200점', () => {
  const answers = {
    q1: { 1: { choice: 1, ms: 1000 } },          // 정답
    b1: { 2: { choice: 3, ms: 2000 }, 1: { choice: 0, ms: 10 } }, // 2팀 정답, 1팀 오답
    q7: { 3: { choice: 'O', ms: 300 } },         // OX 정답
  };
  const r = rank(Q, answers, teams, all);
  const by = Object.fromEntries(r.map((x) => [x.team, x]));
  assert.equal(by[2].score, 200);
  assert.equal(by[1].score, 100);
  assert.equal(by[3].score, 100);
  assert.equal(by[1].ms, 1000, '오답 문항의 ms는 더하지 않는다');
  assert.deepEqual(r.map((x) => x.team), [2, 3, 1], '동점(100)은 ms 작은 3팀이 위');
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
});

test('rank: 동점·같은 시간은 같은 순위, 다음 순위는 건너뜀', () => {
  const answers = {
    q1: { 1: { choice: 1, ms: 500 }, 2: { choice: 1, ms: 500 }, 3: { choice: 1, ms: 400 } },
    q2: { 3: { choice: 1, ms: 1 } },
  };
  const r = rank(Q, answers, { ...teams, 4: { name: '라' } }, all);
  assert.deepEqual(r.map((x) => [x.team, x.score, x.rank]), [
    [3, 100, 1], [1, 100, 2], [2, 100, 2], [4, 0, 4],
  ]);
});

test('rank: asked 에 없는 문항은 세지 않는다', () => {
  const answers = { q1: { 1: { choice: 1, ms: 1 } }, q2: { 1: { choice: 0, ms: 1 } } };
  const r = rank(Q, answers, teams, { q1: true });
  assert.equal(r.find((x) => x.team === 1).score, 100);
});

test('rank: 잘못된 응답은 채점에서 무시', () => {
  const answers = { q1: { 1: { choice: 1 }, 2: { choice: '1', ms: 5 }, 9: { choice: 1, ms: 5 } } };
  const r = rank(Q, answers, teams, all);
  assert.ok(r.every((x) => x.score === 0));
  assert.equal(r.length, 3, '등록되지 않은 팀(9)은 순위에 없음');
});

test('tally: 보기별 집계도 realAnswers를 거친다', () => {
  assert.deepEqual(tally(byId.q1, { 1: { choice: 1, ms: 1 }, 2: { choice: 1, ms: 1 }, 3: { choice: 9, ms: 1 } }), [0, 2, 0, 0]);
  assert.deepEqual(tally(byId.q8, { 1: { choice: 'X', ms: 1 }, 2: { choice: 'O', ms: 1 } }), { O: 1, X: 1 });
});

test('deriveLive: 문제만 보일 때는 보기도 없다', () => {
  const live = deriveLive({ phase: 'quiz', index: 1, open: false, revealed: false, asked: [] }, Q);
  assert.ok(!('choices' in live) && !('answer' in live) && !('explain' in live));
});

test('deriveLive: 공개 전에는 answer·explain 키 자체가 없다', () => {
  const st = { phase: 'quiz', index: 1, open: true, revealed: false, asked: ['q1'] };
  const live = deriveLive(st, Q);
  assert.ok(!('answer' in live) && !('explain' in live) && !('ranking' in live));
  assert.equal(live.choices.length, 4);
  const shown = deriveLive({ ...st, revealed: true }, Q);
  assert.equal(shown.answer, 1);
  assert.ok(shown.explain.includes(byId.q1.explainMore), 'explainMore도 해설에 포함');
});

test('deriveLive: OX는 O/X, 진행자 전용 필드는 공개 후에도 없다', () => {
  const live = deriveLive({ phase: 'quiz', index: 8, open: false, revealed: true, asked: ['q8'] }, Q);
  assert.deepEqual(live.choices, ['O', 'X']);
  assert.equal(live.answer, 'X');
  assert.ok(live.explain.includes('· 어떤 상황에서 틀리는지'), 'explainList는 줄 단위로');
  for (const k of ['hostNote', 'talk', 'preTalk', 'bridge', 'closing', 'explainList', 'explainMore']) assert.ok(!(k in live), k);
});

test('deriveLive: 배점 정보 (연습 0점, BONUS 200점)', () => {
  const at = (i) => deriveLive({ phase: 'quiz', index: i, asked: [] }, Q);
  assert.deepEqual([at(0).scored, at(0).points], [false, 0]);
  assert.deepEqual([at(1).scored, at(1).points], [true, 100]);
  assert.deepEqual([at(9).scored, at(9).points], [true, 200]);
});

test('deriveLive: 로비·최종', () => {
  assert.deepEqual(deriveLive(null, Q), { phase: 'lobby' });
  const fin = deriveLive({ phase: 'final', asked: ['q1'] }, Q, { ranking: [{ team: 1, rank: 1 }] });
  assert.deepEqual(fin, { phase: 'final', ranking: [{ team: 1, rank: 1 }] });
});
