// team.js — 참가자 화면. 문항 내용은 quiz/live 에서만 받는다 — data/questions.json 은 절대 불러오지 않는다.
import { EVENT } from './config.js';
import { configured, LOCAL, safeWrite, watch, onConnection, onQueueChange, clearQueue } from './db.js';
import { teamList, getSavedTeam, saveTeam, clearTeam, claimTeam, setPin, checkPin, SLOT_SUFFIX } from './join.js';
import { isValidChoice } from './score.js';
import { h, batcher, paragraphs, MARKS } from './dom.js';

const app = document.getElementById('app');
const TEAMS = teamList();
const SEEN_KEY = `lq:seen${SLOT_SUFFIX}`;
const isOx = L => L.type === 'ox';
const valuesOf = L => (isOx(L) ? ['O', 'X'] : (L.choices || []).map((_, i) => i));
const markOf = (L, v) => (isOx(L) ? v : MARKS[v]);
const textOf = (L, v) => (isOx(L) ? '' : L.choices?.[v] ?? '');
const emptyJoin = () => ({ teamId: null, pin: '', error: '', busy: false });

const S = {
  team: getSavedTeam(),     // { id, pin, resetAt }
  live: undefined,          // undefined = 아직 못 받음
  resetAt: undefined,
  teams: null,
  myAnswer: null,
  pick: null,
  sending: false,
  pending: null,            // 큐에 들어가 재전송을 기다리는 답 { qid, choice }
  queue: 0,
  online: true,
  notice: '',
  join: emptyJoin()
};

const teamOf = id => TEAMS.find(t => t.id === id);
const draw = batcher(render);

// ── 이 기기가 문제를 처음 본 시각 ─────────────────────────

function seenAt(qid) {
  try {
    const s = JSON.parse(localStorage.getItem(SEEN_KEY));
    if (s?.qid === qid) return s.t;
  } catch { /* 새로 잰다 */ }
  const t = Date.now();
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ qid, t })); } catch { /* 무시 */ }
  return t;
}
const forgetSeen = () => { try { localStorage.removeItem(SEEN_KEY); } catch { /* 무시 */ } };

// ── 구독 ──────────────────────────────────────────────────

let answerKey = null, stopAnswer = null;
let pinKey = null, stopPin = null;

// 팀·문제가 바뀔 때마다 "내 답"과 "내 PIN" 구독을 갈아 끼운다.
function syncWatches() {
  const aKey = S.team && S.live?.phase === 'quiz' ? `quiz/answers/${S.live.id}/${S.team.id}` : null;
  if (aKey !== answerKey) {
    stopAnswer?.();
    answerKey = aKey;
    S.myAnswer = null;
    stopAnswer = aKey && watch(aKey, v => {
      S.myAnswer = isValidChoice(v?.choice) ? v : null;
      if (S.myAnswer) S.pending = null;
      draw();
    });
  }
  const pKey = S.team?.pin ? `pins/${S.team.id}/${S.team.pin}` : null;
  if (pKey !== pinKey) {
    stopPin?.();
    pinKey = pKey;
    // 진행자가 PIN을 초기화하면 이 값이 사라진다.
    stopPin = pKey && watch(pKey, v => {
      if (v === null) leave(`${EVENT.teamLabel} PIN이 초기화되었습니다. 다시 입장해 주세요.`);
    });
  }
}

function leave(notice = '') {
  clearTeam();
  clearQueue();
  forgetSeen();
  Object.assign(S, { team: null, pick: null, pending: null, myAnswer: null, notice, join: emptyJoin() });
  syncWatches();
  draw();
}

function start() {
  watch('quiz/live', v => {
    const prev = S.live;
    S.live = v || { phase: 'lobby' };
    if (S.live.phase === 'quiz') {
      if (S.live.id !== prev?.id) { S.pick = null; S.pending = null; }
      if (S.live.open) seenAt(S.live.id);
      // 보기가 없다 = 아직 안 열렸거나 문제 리셋됨. 시간 기록과 고른 답을 버린다.
      if (!S.live.choices) { forgetSeen(); S.pick = null; S.pending = null; }
    }
    syncWatches();
    draw();
  });
  watch('session/resetAt', v => {
    S.resetAt = v ?? null;
    if (S.team && (S.team.resetAt ?? null) !== S.resetAt) leave('퀴즈가 초기화되었습니다. 다시 입장해 주세요.');
    draw();
  });
  watch('teams', v => { S.teams = v; draw(); });
  onConnection(c => { S.online = c; draw(); });
  onQueueChange(n => { S.queue = n; draw(); });
  syncWatches();
}

// ── 동작 ──────────────────────────────────────────────────

function enter(team, pin = null) {
  S.team = { id: team.id, pin, resetAt: S.resetAt };
  saveTeam(S.team);
  S.join = emptyJoin();
  S.notice = '';
  syncWatches();
  draw();
}

async function pickTeam(team) {
  S.notice = '';
  if (EVENT.joinMode !== 'pin') {
    claimTeam(team);
    enter(team);
    return;
  }
  S.join = { ...emptyJoin(), teamId: team.id };
  draw();
}

async function submitPin() {
  const team = teamOf(S.join.teamId);
  const pin = S.join.pin;
  if (!/^\d{4}$/.test(pin)) { S.join.error = '숫자 4자리를 입력해 주세요.'; draw(); return; }
  S.join.busy = true; S.join.error = ''; draw();

  // 이미 PIN이 있는 조면 대조, 없으면 내가 정한다.
  let res = S.teams?.[team.id] ? await checkPin(team, pin) : await setPin(team, pin);
  if (!res.ok && res.reason === 'taken') res = await checkPin(team, pin);

  S.join.busy = false;
  if (res.ok) { enter(team, pin); return; }
  S.join.error = res.reason === 'network'
    ? '연결이 불안정합니다. 잠시 후 다시 눌러 주세요.'
    : 'PIN이 맞지 않습니다. 같은 존 분께 확인해 주세요.';
  draw();
}

async function submitAnswer() {
  const { id, open } = S.live;
  if (!open || S.pick === null || S.sending) return;
  const choice = S.pick;
  S.sending = true; S.notice = ''; draw();
  const now = Date.now();
  const res = await safeWrite(
    `quiz/answers/${id}/${S.team.id}`,
    { choice, ms: now - seenAt(id), at: now },
    { queue: true }
  );
  S.sending = false;
  if (res.ok) S.myAnswer = { choice };
  else if (res.queued) S.pending = { qid: id, choice };
  else S.notice = '제출하지 못했습니다. 다시 눌러 주세요.';
  draw();
}

// ── 화면 (마크업은 부안 청년포럼의 css/team.css · quiz.css 클래스를 따른다) ──

const bar = document.getElementById('bar');
const foot = document.getElementById('foot');
const numLabel = v => (typeof v === 'number' ? `${MARKS[v]}번` : v);

const center = (...kids) => h('div', { class: 'center' }, ...kids);
const badges = L => h('div', { class: 'badges' },
  h('span', { class: 'badge num' }, L.label),
  h('span', { class: 'badge' }, L.scored ? `${L.points}점` : '점수 없음'));
const waitbox = (title, sub, slim) => h('div', { class: `waitbox ${slim ? 'slim' : ''}` },
  h('div', { class: 'pulse' }), h('div', { class: 'wt' }, title), h('div', { class: 'ws' }, sub));

function viewJoin() {
  if (S.join.teamId) return viewPin();
  return [
    h('div', { class: 'h' }, `우리 ${EVENT.teamLabel}을 골라주세요`),
    h('div', { class: 'sub' }, EVENT.joinMode === 'pin'
      ? `${EVENT.teamLabel}마다 숫자 4자리 PIN을 함께 씁니다`
      : `${EVENT.teamLabel}을 누르면 바로 입장합니다`),
    h('div', { class: 'grid' }, TEAMS.map(t =>
      h('button', { class: `tcard ${S.teams?.[t.id] ? 'taken' : ''}`, onclick: () => pickTeam(t) },
        h('div', { class: 'n' }, t.name),
        t.members.length > 0 && h('div', { class: 'a' }, t.members.join(' · ')))))
  ];
}

function viewPin() {
  const team = teamOf(S.join.teamId);
  const isNew = !S.teams?.[team.id];
  return [center(
    h('div', { class: 'sub' }, isNew ? `${EVENT.teamLabel} PIN 정하기` : `${EVENT.teamLabel} PIN 입력`),
    h('div', { class: 'big team' }, team.name),
    team.members.length > 0 && h('div', { class: 'sub' }, team.members.join(' · ')),
    h('div', { class: 'sub' }, isNew
      ? `${team.name}이 맞나요? 지금 정하는 숫자 4자리를 같은 ${EVENT.teamLabel} 분들께 알려주세요`
      : `${team.name}에서 정한 숫자 4자리를 입력해주세요`),
    h('input', {
      id: 'pin', class: 'pin', type: 'tel', inputMode: 'numeric', maxLength: 4,
      autocomplete: 'off', placeholder: '0000', value: S.join.pin, disabled: S.join.busy,
      oninput: e => { S.join.pin = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = S.join.pin; },
      onkeydown: e => { if (e.key === 'Enter') submitPin(); }
    }),
    S.join.error && h('div', { class: 'err' }, S.join.error),
    h('button', { class: 'primary', disabled: S.join.busy, onclick: submitPin }, S.join.busy ? '확인 중…' : '입장'),
    h('button', { class: 'link', disabled: S.join.busy, onclick: () => { S.join = emptyJoin(); draw(); } },
      `다른 ${EVENT.teamLabel} 고르기`)
  )];
}

function viewQuiz() {
  const L = S.live;
  const mine = S.myAnswer?.choice ?? (S.pending?.qid === L.id ? S.pending.choice : null);

  if (L.revealed) {
    const ok = mine === L.answer;
    return [
      badges(L),
      h('div', { class: `verdict ${mine === null ? '' : ok ? 'ok' : 'no'}` },
        h('div', { class: 'mk' }, mine === null ? '–' : ok ? 'O' : 'X'),
        h('div', { class: 'lb' }, mine === null ? '답을 제출하지 않았어요' : ok ? '정답입니다!' : '아쉬워요'),
        h('div', { class: 'an' }, `정답 · ${markOf(L, L.answer)} ${textOf(L, L.answer)}`),
        h('div', { class: 'pts' }, L.scored ? `+${ok ? L.points : 0}점` : '연습문제 · 점수 없음')),
      L.explain && h('div', { class: 'card' },
        h('div', { class: 'lb' }, '해설'), paragraphs(L.explain))
    ];
  }

  if (!L.choices) {
    return [center(h('div', { class: 'pulse' }),
      h('div', { class: 'big' }, L.label), h('div', { class: 'sub' }, '화면을 보고 팀과 이야기해 보세요 · 곧 보기가 열립니다'))];
  }

  if (mine !== null) {
    return [badges(L), S.myAnswer
      ? waitbox(`✓ ${numLabel(mine)} 제출 완료`, ['잠시만 기다려주세요', h('br'), '곧 정답을 공개합니다'])
      : waitbox(`${numLabel(mine)} 재전송 중…`, ['연결이 돌아오면 자동으로 다시 보냅니다', h('br'), '화면을 닫지 마세요'])];
  }

  if (!L.open) return [badges(L), waitbox('답안이 마감되었어요', '곧 정답을 공개합니다')];

  return [
    badges(L),
    h('div', { class: `opts ${isOx(L) ? 'ox' : ''}` }, valuesOf(L).map(v =>
      h('button', { class: `opt ${S.pick === v ? 'sel' : ''}`, disabled: S.sending, onclick: () => { S.pick = v; draw(); } },
        h('span', { class: 'n' }, markOf(L, v))))),
    h('button', { class: 'primary submit', disabled: S.pick === null || S.sending, onclick: submitAnswer },
      S.sending ? '제출 중…' : S.pick === null ? '답을 골라주세요' : `${numLabel(S.pick)} 제출`),
    h('div', { class: 'status' }, '문제와 보기는 앞 화면에서 확인해주세요 · 제출 후에는 바꿀 수 없어요')
  ];
}

function viewFinal() {
  const mr = S.live.ranking && Object.values(S.live.ranking).find(r => String(r.team) === String(S.team.id));
  if (!mr) return [center(h('div', { class: 'big' }, '퀴즈가 끝났습니다'), h('div', { class: 'sub' }, '참여해주셔서 감사합니다'))];
  return [center(
    h('div', { class: 'medal' }, ['🥇', '🥈', '🥉'][mr.rank - 1] || '🎉'),
    h('div', { class: 'sub' }, `${mr.name} 최종`),
    h('div', { class: 'rankbig' }, `${mr.rank}위`),
    h('div', { class: 'big' }, `${mr.score}점`),
    h('div', { class: 'sub' }, `${mr.correct}문제 정답`))];
}

function viewMain() {
  if (S.live.phase === 'quiz') return viewQuiz();
  if (S.live.phase === 'final') return viewFinal();
  return [center(
    h('div', { class: 'pulse' }),
    h('div', { class: 'big team' }, teamOf(S.team.id)?.name),
    h('div', { class: 'sub' }, '입장했습니다 · 곧 시작합니다'))];
}

let lastSig = '';
function render() {
  // 입력 중인 PIN은 다시 그릴 이유가 아니다.
  const sig = JSON.stringify({ ...S, join: { ...S.join, pin: '' } });
  if (sig === lastSig) return;
  lastSig = sig;

  document.body.classList.toggle('offline', !S.online);
  bar.replaceChildren(
    h('span', { class: `dot ${S.online ? 'live' : ''}` }),
    h('span', { class: 't' }, EVENT.title),
    h('span', { class: 'sp' }),
    // replaceChildren은 false를 "false" 글자로 찍는다 — 없을 때는 빈 문자열을 넘긴다
    LOCAL ? h('span', { class: 'localmode' }, '로컬 테스트') : '',
    S.team && h('span', { class: 'myteam' }, teamOf(S.team.id)?.name) || '');

  if (!configured && !LOCAL) { app.replaceChildren(center(h('div', { class: 'err' }, '설정이 비어 있습니다 (js/config.js)'))); return; }
  if (S.live === undefined || S.resetAt === undefined) {
    app.replaceChildren(center(h('div', { class: 'pulse' }), h('div', { class: 'sub' }, '불러오는 중')));
    return;
  }

  const body = S.team ? viewMain() : viewJoin();
  app.replaceChildren(...[S.notice && h('div', { class: 'notice' }, S.notice), ...body].filter(Boolean));
  foot.replaceChildren(...[
    S.team && h('button', { class: 'link', onclick: () => leave() }, `${EVENT.teamLabel} 변경`),
    S.queue > 0 && h('span', { class: 'warn' }, `재전송 대기 ${S.queue}`)
  ].filter(Boolean));
  document.getElementById('pin')?.focus();
}

if (configured || LOCAL) start();
draw();
