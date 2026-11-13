// db.js — RTDB 초기화 + 안전 쓰기(재조회 확인) 래퍼
// 모든 경로는 ROOT(bmequiz/) 아래 상대 경로다. '.info/…'만 그대로 쓴다.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, child, set, update, get, onValue, goOffline, goOnline
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE, ROOT } from './config.js';

export const configured =
  !Object.values(FIREBASE).some(v => !v || String(v).includes('YOUR_'));

// 설정이 비어 있고 내 컴퓨터(localhost)에서 열었을 때만: 같은 브라우저 탭끼리 상태를 나누는 로컬 테스트 백엔드.
// 배포 주소에서 설정이 비어 있으면 로컬 모드로 돌지 않고 "설정이 비어 있습니다"를 띄운다.
export const LOCAL = !configured && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// host.js가 getAuth(app)으로 쓴다. 참가자 화면은 Auth SDK를 불러오지 않는다.
export const app = configured ? initializeApp(FIREBASE) : null;
export const db = app ? getDatabase(app) : null;

const ACK_TIMEOUT = 8000;
const QUEUE_KEY = 'lq:queue';

/** 'quiz/state' → 'bmequiz/quiz/state', '/' → 'bmequiz' */
export const rp = path => {
  const p = String(path).replace(/^\/+|\/+$/g, '');
  return p.startsWith('.info') ? p : p ? `${ROOT}/${p}` : ROOT;
};

const need = () => {
  if (!db) throw new Error('js/config.js의 FIREBASE 설정값이 아직 비어 있습니다.');
  return db;
};

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
  promise.then(
    v => { clearTimeout(t); resolve(v); },
    e => { clearTimeout(t); reject(e); }
  );
});

const errorCode = e => {
  if (/permission.denied/i.test(`${e?.code} ${e?.message}`)) return 'PERMISSION_DENIED';
  return e?.code || 'UNKNOWN';
};

// RTDB는 null·빈 객체를 저장하지 않고, 숫자 키 객체를 배열로 돌려주기도 한다.
// 보낸 값과 읽은 값을 같은 모양으로 맞춘 뒤 비교한다.
function normalize(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const n = normalize(v[k]);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}
const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

// update는 부모가 아니라 쓴 자식 경로를 하나씩 읽는다. 부모 경로에는 읽기 권한이 없을 수 있다.
async function verified(r, value, mode) {
  if (mode !== 'update') return same((await get(r)).val(), value);
  const keys = Object.keys(value);
  const snaps = await Promise.all(keys.map(k => get(child(r, k))));
  return keys.every((k, i) => same(snaps[i].val(), value[k]));
}

/**
 * 쓰기 → 서버 확인(ack) 대기 → 같은 경로 재조회 → 값 일치 확인.
 * 던지지 않고 결과를 돌려준다: { ok, verified, queued, error }
 *
 * opts.mode    'set'(기본) | 'update'
 * opts.queue   true면 실패 시 localStorage 큐에 보관해 복귀 때 자동 재전송한다.
 *              답안처럼 다시 보내도 결과가 같은 쓰기에만 켠다. 진행자 state처럼
 *              순서가 중요한 쓰기는 켜지 않는다(옛 상태가 뒤늦게 덮어쓴다).
 * opts.verify  false면 재조회를 건너뛴다. 쓴 사람도 읽을 수 없는 경로(/hosts)에만 쓴다.
 * opts.timeout ack 대기 한도(ms). 오프라인이면 set()이 거부되지 않고 계속 대기하므로 필요하다.
 */
export async function safeWrite(path, value, opts = {}) {
  if (LOCAL) return local.write(path, value, opts.mode);
  const { mode = 'set', queue = false, timeout = ACK_TIMEOUT, verify = true } = opts;
  try {
    const r = ref(need(), rp(path));
    await withTimeout(mode === 'update' ? update(r, value) : set(r, value), timeout);
    // ack 이후에만 재조회한다. 그 전의 get()은 로컬 캐시의 낙관적 값을 돌려줄 수 있다.
    if (verify && !(await withTimeout(verified(r, value, mode), timeout))) {
      throw Object.assign(new Error('재조회한 값이 보낸 값과 다릅니다.'), { code: 'VERIFY_MISMATCH' });
    }
    return { ok: true, verified: verify, queued: false, error: null };
  } catch (e) {
    const error = errorCode(e);
    // 권한 거부는 다시 보내도 거부되므로 큐에 넣지 않는다.
    const queued = queue && error !== 'PERMISSION_DENIED';
    if (queued) enqueue({ path, value, mode });
    return { ok: false, verified: false, queued, error };
  }
}

// ── 재전송 큐 ─────────────────────────────────────────────

const listeners = new Set();

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
  catch { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* 사파리 비공개 모드 등 */ }
  listeners.forEach(cb => cb(q.length));
}
function enqueue(item) {
  // 같은 경로는 마지막 값만 남긴다.
  saveQueue([...loadQueue().filter(i => i.path !== item.path), { ...item, queuedAt: Date.now() }]);
}

export const queueSize = () => loadQueue().length;
export const clearQueue = () => saveQueue([]);

/** 큐 길이가 바뀔 때마다 cb(length). "재전송 중" 표시에 쓴다. 해제 함수를 돌려준다. */
export function onQueueChange(cb) {
  listeners.add(cb);
  cb(queueSize());
  return () => listeners.delete(cb);
}

let flushing = false;
export async function flushQueue() {
  if (flushing || !db) return;
  flushing = true;
  try {
    for (const item of loadQueue()) {
      const res = await safeWrite(item.path, item.value, { mode: item.mode });
      // 성공했거나, 다시 보내도 소용없는 거부면 큐에서 뺀다.
      if (res.ok || res.error === 'PERMISSION_DENIED') {
        saveQueue(loadQueue().filter(i => !(i.path === item.path && i.queuedAt === item.queuedAt)));
      } else {
        break; // 아직 연결이 안 됐다. 다음 복귀 신호에서 다시 시도한다.
      }
    }
  } finally {
    flushing = false;
  }
}

// ── 읽기·구독·연결 상태 ───────────────────────────────────

export const read = async path => (LOCAL ? local.get(path) : (await get(ref(need(), rp(path)))).val());

/** cb(value)로 구독. 해제 함수를 돌려준다. */
export const watch = (path, cb, onError) =>
  LOCAL ? local.watch(path, cb) : onValue(ref(need(), rp(path)), snap => cb(snap.val()), onError);

export const onConnection = cb => watch('.info/connected', v => cb(v === true));

export const setOffline = () => (LOCAL ? null : goOffline(need()));
export const setOnline = () => (LOCAL ? null : goOnline(need()));

if (db) {
  onConnection(connected => { if (connected) flushQueue(); });
  window.addEventListener('online', flushQueue);
}

// ── 로컬 테스트 백엔드 (localhost + 설정 비어 있음) ────────
// localStorage 한 덩어리에 트리를 두고, BroadcastChannel로 다른 탭에 변경을 알린다.
// RTDB처럼 null·빈 객체는 지우고, 값이 바뀐 구독에만 알린다.
const local = LOCAL ? (() => {
  const KEY = `${ROOT}:local-db`;
  const ch = new BroadcastChannel(KEY);
  const subs = new Set();
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let tree = load();
  const parts = p => rp(p).split('/').filter(Boolean);
  const getAt = p => (p.startsWith('.info') ? true : parts(p).reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), tree) ?? null);
  const prune = v => {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'object') return v;
    // RTDB처럼: 0..n-1 이 빈틈없이 찬 배열은 배열로 돌려준다
    if (Array.isArray(v)) { const a = v.map(prune); return a.length && !a.includes(undefined) ? a : undefined; }
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = prune(x); if (y !== undefined) out[k] = y; }
    return Object.keys(out).length ? out : undefined;
  };
  const put = (p, v) => {
    const ks = parts(p);
    const stack = [tree];
    let n = tree;
    for (const k of ks.slice(0, -1)) { if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n = n[k]; stack.push(n); }
    const val = prune(JSON.parse(JSON.stringify(v ?? null)));
    if (val === undefined) delete n[ks.at(-1)]; else n[ks.at(-1)] = val;
    for (let i = ks.length - 1; i > 0; i--) { if (!Object.keys(stack[i]).length) delete stack[i - 1][ks[i - 1]]; else break; }
  };
  const notify = () => {
    for (const s of subs) {
      const j = JSON.stringify(getAt(s.path));
      if (j !== s.last) { s.last = j; s.cb(JSON.parse(j)); }
    }
  };
  ch.onmessage = () => { tree = load(); notify(); };
  return {
    get: p => JSON.parse(JSON.stringify(getAt(p))),
    watch(path, cb) {
      const s = { path, cb, last: undefined };
      subs.add(s);
      setTimeout(notify, 0);
      return () => subs.delete(s);
    },
    async write(path, value, mode) {
      if (mode === 'update') for (const [k, v] of Object.entries(value)) put(`${path}/${k}`, v);
      else put(path, value);
      localStorage.setItem(KEY, JSON.stringify(tree));
      ch.postMessage(1);
      notify();
      return { ok: true, verified: true, queued: false, error: null };
    }
  };
})() : null;
