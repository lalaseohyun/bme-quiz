// host.js — 진행자 화면 (프로젝터에 그대로 띄운다)
import {
  getAuth, onAuthStateChanged, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { EVENT } from './config.js';
import { app as fbApp, configured, LOCAL, safeWrite, watch, onConnection } from './db.js';
import { deriveLive, normalizeState, INITIAL_STATE, optionsOf, valueAt, isOx, explanationOf } from './derive.js';
import { rank, realAnswers, pointsOf } from './score.js';
import { teamList } from './join.js';
import { h, batcher, paragraphs, MARKS } from './dom.js';

// 문항은 진행자 화면만 불러온다. 참가자 화면(index.html · team.js)은 이 파일을 절대 불러오지 않는다.
const DATA = await fetch('data/questions.json', { cache: 'no-store' }).then(r => r.json());
const QUESTIONS = DATA.questions.map(q => ({
  ...q,
  // 조작바 번호 버튼에 쓰는 짧은 이름: 연습문제→연, Q1→1, BONUS→B
  short: /^Q\d+$/.test(q.label) ? q.label.slice(1) : q.label.slice(0, 1)
}));

const root = document.getElementById('app');
const TEAMS = teamList();
const TEAM_OBJ = Object.fromEntries(TEAMS.map(t => [t.id, { name: t.name }]));
const JOIN_URL = EVENT.joinUrl || new URL('index.html', location.href).href;
const PARAMS = new URLSearchParams(location.search);
const NOTES = PARAMS.get('notes') === '1';   // host.html?notes=1 일 때만 hostNote를 아래에 작게

const S = {
  auth: 'loading',          // loading | key | ready | error
  authError: '',
  uid: null,
  state: undefined,
  answers: null,
  teams: null,
  pins: null,
  online: true,
  busy: false,
  error: '',
  // 아래는 진행자 화면에만 있는 로컬 상태. 백엔드에 올리지 않는다.
  showPreTalk: false,       // 정답 공개 전 질문 카드 (preTalk가 있는 문항만)
  showExplain: false,       // 해설 창
  showClosing: false,       // 마지막 문항 뒤 closing 문구
  hideCtl: false,
  admin: false
};
const clearLocal = () => Object.assign(S, { showPreTalk: false, showExplain: false, showClosing: false });

// host.html?demo — 백엔드에 아무것도 쓰지 않고 화면 흐름과 크기만 점검한다.
const DEMO = PARAMS.has('demo');

const draw = batcher(render);
const st = () => normalizeState(S.state);
const currentQ = () => QUESTIONS[st().index];
const subsOf = q => Object.entries(realAnswers(S.answers?.[q.id])).filter(([k]) => TEAMS.some(t => String(t.id) === k));

// 순위에는 정답이 공개된 문제만 넣는다. 안 그러면 화면의 순위로 정답이 샌다.
function revealedQuestions(s = st()) {
  if (s.phase === 'final') return QUESTIONS.filter(q => s.asked.includes(q.id));
  if (s.phase !== 'quiz') return [];
  return QUESTIONS.filter((q, i) => i < s.index || (i === s.index && s.revealed));
}
const ranking = s => rank(QUESTIONS, S.answers, TEAM_OBJ,
  Object.fromEntries(revealedQuestions(s).map(q => [q.id, true])));

// ── 로그인: 익명 로그인만 하고 바로 진행자 화면 (진행자 암호 없음) ──────
// 규칙은 "익명 로그인한 브라우저"에게 진행 데이터 쓰기를 허용한다. host.html 주소를 아는 사람은 진행할 수 있다.

function startAuth() {
  const auth = getAuth(fbApp);
  onAuthStateChanged(auth, async user => {
    if (!user) {
      try { await signInAnonymously(auth); }
      catch (e) {
        S.auth = 'error';
        S.authError = /operation-not-allowed|admin-restricted/.test(e.code)
          ? 'Firebase 콘솔 > Authentication > 로그인 방법에서 "익명"을 켜 주세요.'
          : `로그인 실패 (${e.code}). js/config.js의 apiKey를 확인해 주세요.`;
        draw();
      }
      return;
    }
    S.uid = user.uid;
    if (S.auth !== 'ready') startHost();
  });
}

// 새로고침 직후에는 저장된 익명 로그인이 먼저 살아나고, DB 연결에 로그인 토큰이 붙기 전에 구독이 나갈 수 있다.
// 그러면 로그인 필요 경로(quiz/state 등) 구독이 거부되고 끝나 "불러오는 중…"에 멈춘다. 거부되면 잠시 뒤 다시 구독한다.
function watchRetry(path, cb, tries = 0) {
  watch(path, cb, e => {
    console.warn(`[host] ${path} 구독 거부 — 다시 시도 (${tries + 1})`, e?.code || e);
    setTimeout(() => watchRetry(path, cb, tries + 1), Math.min(500 * (tries + 1), 4000));
  });
}

function startHost() {
  S.auth = 'ready';
  watchRetry('quiz/state', v => { S.state = v; draw(); });
  watchRetry('quiz/answers', v => { S.answers = v; draw(); });
  watchRetry('teams', v => { S.teams = v; draw(); });
  watchRetry('pins', v => { S.pins = v; draw(); });
  onConnection(c => { S.online = c; draw(); });
  draw();
}

// ── 상태 쓰기: state와 live를 항상 한 번에 쓴다 ───────────

async function commit(next, extra = {}) {
  if (S.busy) return;
  if (DEMO) { demoCommit(normalizeState(next), extra); return; }
  S.busy = true; draw();
  const state = normalizeState(next);
  const live = deriveLive(state, QUESTIONS, {
    ranking: state.phase === 'final' && EVENT.showRanking ? ranking(state) : undefined
  });
  const res = await safeWrite('/', { ...extra, 'quiz/state': state, 'quiz/live': live }, { mode: 'update' });
  S.busy = false;
  S.error = res.ok ? '' : `저장 실패 (${res.error}). 다시 눌러 주세요.`;
  draw();
}

function demoCommit(state, extra) {
  for (const k of Object.keys(extra)) {
    if (k === 'quiz/answers') S.answers = null;
    else if (k.startsWith('quiz/answers/')) S.answers = { ...S.answers, [k.split('/')[2]]: null };
  }
  if (state.open) {
    const q = QUESTIONS[state.index];
    const n = optionsOf(q).length;
    S.answers = { ...S.answers, [q.id]: Object.fromEntries(TEAMS.slice(0, 5).map((t, i) =>
      [t.id, { choice: i % 2 ? valueAt(q, i % n) : q.answer, ms: 1500 * (i + 1) }])) };
  }
  S.state = state;
  draw();
}

function startDemo() {
  S.auth = 'ready';
  S.state = null;
  S.teams = Object.fromEntries(TEAMS.slice(0, 5).map(t => [t.id, { name: t.name }]));
  draw();
}

const actions = {
  startQuiz: () => { clearLocal(); return commit({ ...INITIAL_STATE, phase: 'quiz' }); },
  // 홈(대기화면)은 진행 상태와 답안을 그대로 둔 채 화면만 QR로 돌린다.
  home() {
    clearLocal();
    return commit({ ...st(), phase: 'lobby', open: false });
  },
  resume: () => commit({ ...st(), phase: 'quiz', open: false }),
  // 문제 번호로 바로 간다. 이미 답을 받은 문제는 정답 공개 상태로, 아직인 문제는 문제만 보이는 상태로 연다.
  goto(i) {
    const s = st(), q = QUESTIONS[i];
    if (!q) return;
    const done = s.asked.includes(q.id);
    clearLocal();
    S.showExplain = done;
    return commit({ ...s, phase: 'quiz', index: i, open: false, revealed: done });
  },
  // ◀ : 지금 화면에서 한 단계 뒤로.
  back() {
    const s = st(), q = currentQ();
    if (s.phase === 'lobby') return;
    if (s.phase === 'final') return actions.goto(QUESTIONS.length - 1);
    if (S.showClosing) { S.showClosing = false; draw(); return; }
    if (s.revealed && S.showExplain) { S.showExplain = false; draw(); return; }
    if (s.revealed) return commit({ ...s, revealed: false });
    if (S.showPreTalk) { S.showPreTalk = false; draw(); return; }
    if (s.index > 0 && !s.open) return actions.goto(s.index - 1);
    if (s.index === 0 && !s.asked.includes(q.id)) return actions.home();
  },
  open() {
    const s = st();
    return commit({ ...s, open: true, asked: [...new Set([...s.asked, currentQ().id])] });
  },
  close: () => commit({ ...st(), open: false }),
  reveal: () => { S.showPreTalk = false; return commit({ ...st(), open: false, revealed: true }); },
  next() {
    clearLocal();
    return commit({ ...st(), index: st().index + 1, open: false, revealed: false });
  },
  final() {
    clearLocal();
    return commit({ ...st(), phase: 'final', open: false });
  },
  resetQuestion() {
    const s = st(), q = currentQ();
    if (!q || !confirm(`${q.label}의 답안을 모두 지우고 처음부터 다시 받을까요?`)) return;
    clearLocal();
    return commit(
      { ...s, open: false, revealed: false, asked: s.asked.filter(id => id !== q.id) },
      { [`quiz/answers/${q.id}`]: null }
    );
  },
  resetAll() {
    if (!confirm('전체 리셋: 모든 답안·입장 기록을 지우고 대기 화면으로 돌아갑니다. 참가 휴대폰은 모두 입장 화면으로 돌아갑니다. 계속할까요?')) return;
    clearLocal();
    S.admin = false;
    return commit(INITIAL_STATE, {
      'quiz/answers': null, teams: null, pins: null, 'session/resetAt': Date.now()
    });
  },
  async resetPin(team) {
    if (!confirm(`${team.name}의 PIN을 초기화할까요? 그 ${EVENT.teamLabel}의 기기는 다시 입장해야 합니다.`)) return;
    S.busy = true; draw();
    const res = await safeWrite('/', { [`pins/${team.id}`]: null, [`teams/${team.id}`]: null }, { mode: 'update' });
    S.busy = false;
    S.error = res.ok ? '' : `PIN 초기화 실패 (${res.error}).`;
    draw();
  }
};
const local = key => () => { S[key] = true; draw(); };

// 지금 단계에서 "다음"에 해당하는 동작 하나.
function primary() {
  const s = st(), q = currentQ();
  if (s.phase === 'lobby') {
    return s.asked.length > 0 || s.index > 0
      ? { label: '퀴즈 이어가기', run: actions.resume }
      : { label: '퀴즈 시작', run: actions.startQuiz };
  }
  if (s.phase !== 'quiz' || !q) return null;
  if (s.revealed) {
    // 해설은 진행자 화면에서만 단계를 나눈다(로컬 상태).
    if (!S.showExplain) return { label: '해설 보기', run: local('showExplain') };
    if (s.index < QUESTIONS.length - 1) return { label: '다음 문제', run: actions.next };
    if (q.closing && !S.showClosing) return { label: '마무리', run: local('showClosing') };
    return { label: EVENT.showRanking ? '최종 순위' : '퀴즈 종료', run: actions.final };
  }
  if (!s.asked.includes(q.id)) return { label: '보기 공개 · 답안 시작', run: actions.open };
  // 정답 공개 전 질문은 정답 힌트가 될 수 있으므로 띄우면서 답안을 마감한다(SPEC ③ 마감 → ④ 사전 질문).
  if (q.preTalk && !S.showPreTalk) {
    return { label: '정답 공개 전 질문', run: () => { S.showPreTalk = true; return s.open ? actions.close() : draw(); } };
  }
  return { label: '정답 공개', run: actions.reveal };
}

// ── 백업 ──────────────────────────────────────────────────

function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const allAsked = () => Object.fromEntries(QUESTIONS.map(q => [q.id, true]));
const markOf = (q, v) => (isOx(q) ? v : MARKS[v]);

function backupJson() {
  download(`bme-quiz-backup-${stamp()}.json`, JSON.stringify({
    exportedAt: new Date().toISOString(), event: EVENT.title,
    state: st(), answers: S.answers, teams: S.teams,
    ranking: rank(QUESTIONS, S.answers, TEAM_OBJ, allAsked())
  }, null, 2), 'application/json');
}

function backupCsv() {
  const rows = rank(QUESTIONS, S.answers, TEAM_OBJ, allAsked());
  const head = [EVENT.teamLabel, ...QUESTIONS.flatMap(q => [`${q.label} 선택`, `${q.label} 정오`, `${q.label} ms`]),
    '점수', '정답 수', '정답 시간 합(ms)', '순위'];
  const lines = rows.map(r => [
    r.name,
    ...QUESTIONS.flatMap(q => {
      const a = realAnswers(S.answers?.[q.id])[r.team];
      return a ? [markOf(q, a.choice), a.choice === q.answer ? 'O' : 'X', a.ms] : ['', '', ''];
    }),
    r.score, r.correct, r.ms, r.rank
  ]);
  const csv = [head, ...lines].map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`bme-quiz-result-${stamp()}.csv`, '﻿' + csv, 'text/csv');
}

// ── 화면 (마크업은 부안 청년포럼의 css/host.css · quiz.css 클래스를 따른다) ──

const ctl = document.getElementById('ctl');
const short = t => t.name.replace(EVENT.teamLabel, '');
const veil = show => (show ? '' : 'visibility:hidden');

let qrSvg = null;
function qr() {
  if (qrSvg === null) {
    try {
      const code = window.qrcode(0, 'M');
      code.addData(JOIN_URL);
      code.make();
      qrSvg = code.createSvgTag({ scalable: true, margin: 0 });
    } catch { qrSvg = ''; }
  }
  return h('div', { class: 'qrbox', innerHTML: qrSvg });
}

// 조 원. mark: '✓' | 'O' | 'X' | '–' | null
function chip(t, cls, mark) {
  const label = short(t);
  return h('div', { class: `chip ${cls} ${label.length > 2 ? 'wide' : ''}` }, label,
    mark && h('span', { class: `mk ${mark === 'X' ? 'x' : mark === '–' ? 'none' : ''}` }, mark));
}

function viewLogin() {
  if (S.auth === 'error') return h('div', { class: 'login' }, h('p', { class: 'err' }, S.authError));
  return h('div', { class: 'login' }, h('p', null, '연결 중…'));
}

function viewLobby() {
  const joined = TEAMS.filter(t => S.teams?.[t.id]);
  return h('div', { class: 'lobby' },
    qr(),
    h('div', null,
      h('div', { class: 'lsub' }, EVENT.title),
      h('h2', null, EVENT.subtitle),
      h('div', { class: 'lsub' }, EVENT.lobbyMessage),
      h('div', { class: 'lsub' }, `접속한 ${EVENT.teamLabel} `, h('b', null, joined.length), ` / ${TEAMS.length}`),
      h('div', { class: 'chips' }, TEAMS.map(t => chip(t, joined.includes(t) ? 'on' : ''))),
      h('div', { class: 'lurl' }, JOIN_URL)));
}

function badgesOf(q, s) {
  const pts = q.scored === false ? '점수 없음' : `${pointsOf(q)}점`;
  return h('div', { class: 'badges' },
    h('span', { class: 'badge num' }, q.label),
    h('span', { class: 'badge' }, q.category),
    h('span', { class: `badge ${q.points ? 'bonus' : ''}` }, pts),
    h('span', { class: 'badge pos' }, `${s.index + 1} / ${QUESTIONS.length}`));
}

// 진행자 화면 위에 덮는 하단 창 (해설·질문 카드)
const sheet = (cls, title, ...body) =>
  h('div', { class: `answerbox sheet ${cls}` }, title && h('div', { class: 'sheettitle' }, title), ...body);

function viewQuestion() {
  const s = st(), q = currentQ();
  const subs = subsOf(q);
  const choiceOf = t => subs.find(([k]) => k === String(t.id))?.[1]?.choice ?? null;
  const asked = s.asked.includes(q.id) || s.revealed;
  const opts = optionsOf(q);
  const ox = isOx(q);
  const long = !ox && opts.some(c => c.length > 7);

  const choices = h('div', {
    class: `choices ${long ? 'long' : ''} ${ox ? 'ox' : ''}`, style: `--n:${long ? 2 : opts.length};${veil(asked)}`
  }, opts.map((c, i) => {
    const v = valueAt(q, i);
    const cnt = subs.filter(([, a]) => a.choice === v).length;
    return h('div', { class: `ch ${s.revealed ? (v === q.answer ? 'correct' : 'dimmed') : ''}` },
      h('div', { class: 'n' }, i + 1),
      h('div', { class: 't' }, c),   // OX는 quiz.css가 번호를 숨기고 O/X를 크게 보여 준다
      s.revealed && h('div', { class: 'tally' },
        `${cnt}${EVENT.teamLabel} · ${Math.round(cnt / TEAMS.length * 100)}%`));
  }));

  let foot;
  if (s.revealed) {
    const right = TEAMS.filter(t => choiceOf(t) === q.answer).length;
    foot = h('div', { class: 'foot revealfoot' },
      h('div', { class: 'tmeta' }, h('div', { class: 'tstat' },
        h('b', null, right), `${EVENT.teamLabel} 정답 · ${subs.length}${EVENT.teamLabel} 제출`)),
      h('div', { class: 'chips' }, TEAMS.map(t => {
        const c = choiceOf(t);
        return c === null ? chip(t, '', '–') : c === q.answer ? chip(t, 'done', 'O') : chip(t, 'wrong', 'X');
      })));
  } else {
    const cnt = subs.length;
    const stat = cnt === 0 ? h('div', { class: 'tstat' }, '답변을 기다리는 중')
      : cnt === TEAMS.length ? h('div', { class: 'tstat done' }, '전체 제출 완료!')
      : h('div', { class: 'tstat' }, h('b', null, cnt), `${EVENT.teamLabel} 제출 완료${s.open ? '' : ' · 마감됨'}`);
    foot = h('div', { class: 'foot', style: veil(asked) },
      h('div', { class: 'tmeta' }, stat),
      h('div', { class: 'chips' }, TEAMS.map(t => choiceOf(t) === null ? chip(t, '') : chip(t, 'on', '✓'))));
  }

  // 하단 창: 정답 공개 전 질문 → (공개) → 해설
  let over = null;
  if (s.revealed && S.showExplain) {
    over = sheet('', null, paragraphs(explanationOf(q)));
  } else if (!s.revealed && S.showPreTalk && q.preTalk) {
    over = sheet('talk', '정답 공개 전에', ...q.preTalk.map(t => h('p', { class: 'talkq' }, t)));
  }

  return h('div', { class: `qview ${s.revealed ? 'revealed' : ''}` },
    badgesOf(q, s),
    h('div', { class: 'q' }, q.text),
    choices,
    h('div', { class: 'qbottom' }, foot,
      h('div', { class: 'pagedots' }, QUESTIONS.map((_, i) => h('i', { class: i === s.index ? 'on' : '' })))),
    over);
}

function viewClosing() {
  const q = currentQ();
  return h('div', { class: 'closing' },
    h('div', { class: 'lsub' }, EVENT.subtitle),
    h('div', { class: 'closingtext' }, q.closing));
}

function viewRank(title) {
  const rows = ranking(st());
  const cols = rows.length > 4 ? 2 : 1;
  return [
    h('div', { class: 'finaltitle' }, title),
    h('div', { class: 'rank', style: `--cols:${cols};--rows:${Math.ceil(rows.length / cols)}` }, rows.map(r =>
      h('div', { class: `row ${r.rank <= 3 ? 'p' + r.rank : ''}` },
        h('div', { class: 'r' }, `${r.rank}위`),
        h('div', { class: 'tm' }, r.name),
        h('div', { class: 'sc' }, r.score, h('small', null, '점')))))
  ];
}

function viewStage() {
  const s = st();
  if (s.phase === 'final') {
    return EVENT.showRanking ? viewRank('최종 순위') : [h('div', { class: 'finaltitle' }, '수고하셨습니다!')];
  }
  if (s.phase === 'quiz' && currentQ()) return [S.showClosing ? viewClosing() : viewQuestion()];
  return [viewLobby()];
}

function viewControls() {
  const s = st(), q = currentQ(), p = primary();
  const inQuiz = s.phase === 'quiz' && q;
  const status = inQuiz
    ? s.revealed ? '정답 공개됨' : s.open ? '답안 받는 중' : s.asked.includes(q.id) ? '마감됨' : '문제 표시 중'
    : s.phase === 'final' ? '종료' : '대기';
  const toggle = (key, on, off) => h('button', {
    class: 'ghost', onclick: () => { S[key] = !S[key]; draw(); }
  }, S[key] ? on : off);

  return [
    h('div', { class: 'row1' },
      h('button', { disabled: S.busy || s.phase === 'lobby', onclick: actions.back }, '◀'),
      h('div', { class: 'qnav' }, QUESTIONS.map((x, i) => h('button', {
        class: inQuiz && i === s.index ? 'on' : s.asked.includes(x.id) ? 'done' : '',
        title: x.label, disabled: S.busy, onclick: () => actions.goto(i)
      }, x.short))),
      h('button', { disabled: S.busy || !p, onclick: () => p?.run() }, '▶'),
      inQuiz && h('span', { class: 'pill' }, '제출 ', h('b', null, subsOf(q).length), ` / ${TEAMS.length} · ${status}`),
      DEMO && h('span', { class: 'pill' }, '데모 · 저장 안 됨'),
      LOCAL && h('span', { class: 'pill localmode' }, '로컬 테스트 모드'),
      S.error && h('span', { class: 'err' }, S.error),
      h('span', { class: 'sp' }),
      inQuiz && s.open && h('button', { class: 'ghost', disabled: S.busy, onclick: actions.close }, '답안 마감'),
      s.phase !== 'lobby' && h('button', { class: 'ghost', disabled: S.busy, onclick: actions.home }, '홈'),
      h('button', { class: 'ghost', onclick: toggleFullscreen }, document.fullscreenElement ? '전체화면 끝' : '전체화면'),
      inQuiz && h('button', { class: 'danger', disabled: S.busy, onclick: actions.resetQuestion }, '이 문제 리셋'),
      h('button', { class: 'danger', disabled: S.busy, onclick: actions.resetAll }, '전체 리셋'),
      toggle('admin', '관리 닫기', '관리'),
      p && h('button', { class: `primary ${S.busy ? '' : 'ready'}`, disabled: S.busy, onclick: p.run },
        S.busy ? '저장 중…' : p.label)),
    h('div', { class: 'row2' },
      h('button', { onclick: backupJson }, '백업 JSON'),
      h('button', { onclick: backupCsv }, '결과 CSV'),
      h('span', { class: 'hint' }, '포인터 · → · Space · 화면 클릭 = 다음 / ← = 이전 / F 전체화면 / H 조작바 숨기기'),
      h('span', { class: 'sp' }),
      EVENT.joinMode === 'pin' && h('span', { class: 'hint' }, 'PIN 초기화'),
      EVENT.joinMode === 'pin' && TEAMS.map(t => h('button', {
        disabled: S.busy || !(S.pins?.[t.id] || S.teams?.[t.id]), onclick: () => actions.resetPin(t)
      }, short(t))))
  ];
}

// 문제·보기가 화면에 안 들어갈 때만 조금씩 줄인다(quiz.css의 --qs / --cs).
function fit() {
  const view = root.querySelector('.qview');
  if (!view) return;
  // .ch의 transition 때문에 재는 순간 패딩이 아직 이전 값이라 실제보다 크게 잡혀 글자를 너무 줄였다(Q2 @1366: 53px → 43px).
  // 재는 동안만 transition을 끈다.
  view.classList.add('fitting');
  try { fitInner(view); } finally { view.classList.remove('fitting'); }
}
function fitInner(view) {
  let s = 1;
  view.style.setProperty('--qs', 1);
  view.style.setProperty('--cs', 1);
  while (view.scrollHeight > view.clientHeight + 1 && s > 0.4) {
    s -= 0.04;
    view.style.setProperty('--qs', s);
    view.style.setProperty('--cs', s);
  }

  // 하단 창 — 먼저 보기 아래 빈자리에 맞춰 글자를 줄이고, 그래도 넘치면 보기를 조금 덮는다.
  const box = view.querySelector('.answerbox.sheet');
  if (!box) return;
  const choices = view.querySelector('.choices');
  const below = view.clientHeight - (choices.offsetTop + choices.offsetHeight) - 10;
  const over = () => box.scrollHeight > box.clientHeight + 1;
  let f = parseFloat(getComputedStyle(box).fontSize);
  const shrink = min => { while (over() && f > min) { f *= 0.96; box.style.fontSize = `${f}px`; } };
  box.style.maxHeight = `${below}px`;
  shrink(22);
  if (over()) { box.style.maxHeight = `${Math.round(view.clientHeight * 0.62)}px`; shrink(16); }
}

// host.html?notes=1 — 진행자 메모(hostNote)는 프로젝터에 띄우지 않고, 이 옵션일 때만 아래에 작게
let noteEl = null;
function renderNote() {
  if (!NOTES) return;
  noteEl ??= document.body.appendChild(h('div', { class: 'hostnote' }));
  const s = st(), q = currentQ();
  const text = S.auth === 'ready' && s.phase === 'quiz' && q?.hostNote ? `메모 · ${q.hostNote}` : '';
  noteEl.textContent = text;
  noteEl.hidden = !text;
}

function render() {
  document.body.classList.toggle('offline', !S.online);
  const ready = (configured || LOCAL || DEMO) && S.auth === 'ready' && S.state !== undefined;
  ctl.className = `ctl ${ready && !S.hideCtl ? '' : 'hidden'} ${S.admin ? 'more' : ''}`;
  renderNote();

  if (!configured && !LOCAL && !DEMO) { root.replaceChildren(h('div', { class: 'login' }, h('p', { class: 'err' }, '설정이 비어 있습니다 (js/config.js)'))); return; }
  if (S.auth !== 'ready') {
    root.replaceChildren(viewLogin());
    return;
  }
  if (!ready) { root.replaceChildren(h('div', { class: 'login' }, h('p', null, '불러오는 중…'))); return; }
  root.replaceChildren(...viewStage());
  ctl.replaceChildren(...viewControls());
  fit();
}

window.addEventListener('resize', draw);

// 전체화면(무대 모드). 조작바는 전체화면에서도 남겨 두고, H로 따로 숨긴다.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('fs', !!document.fullscreenElement);
  draw();
});

// 무선 포인터(프리젠터)는 기종마다 PageDown/PageUp 또는 화살표를 보낸다. 전부 받는다.
const NEXT_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
const PREV_KEYS = ['ArrowLeft', 'ArrowUp', 'PageUp'];

document.addEventListener('keydown', e => {
  if (S.auth !== 'ready' || e.target.closest('input')) return;
  // 포인터의 "슬라이드쇼 시작" 버튼은 F5를 보낸다. 새로고침되지 않게 막는다.
  if (e.key === 'F5') { e.preventDefault(); return; }
  if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  if (e.key === 'h' || e.key === 'H') { S.hideCtl = !S.hideCtl; draw(); return; }
  const next = NEXT_KEYS.includes(e.key), prev = PREV_KEYS.includes(e.key);
  if (!next && !prev) return;
  // 버튼에 포커스가 있을 때 Space·Enter는 그 버튼을 누르는 키다. 가로채지 않는다.
  if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
  e.preventDefault();
  if (S.busy) return;
  if (next) primary()?.run(); else actions.back();
});

// 화면 빈 곳을 클릭해도 다음으로 넘어간다(포인터의 클릭 버튼 · 마우스).
root.addEventListener('click', e => {
  if (S.auth !== 'ready' || S.busy || e.target.closest('button, input, a')) return;
  primary()?.run();
});

if (DEMO) startDemo();
else if (LOCAL) startHost();          // 로컬 테스트: 로그인 없이 바로 진행자
else if (configured) startAuth();
draw();
