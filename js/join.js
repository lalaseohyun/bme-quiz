// join.js — 조 선택 + PIN 입장 처리
import { EVENT } from './config.js';
import { safeWrite, read } from './db.js';

// index.html?slot=3 처럼 열면 이 기기의 저장 키를 분리한다 — 한 브라우저 탭 여러 개를 서로 다른 휴대폰처럼 시험할 때만 쓴다.
const SLOT = new URLSearchParams(location.search).get('slot');
export const SLOT_SUFFIX = SLOT ? `#${SLOT}` : '';
const KEY = `lq:team${SLOT_SUFFIX}`;

export const teamList = () => Array.from({ length: EVENT.teamCount }, (_, i) => {
  const id = i + 1;
  return {
    id,
    name: EVENT.teamNames?.[id] || `${id}${EVENT.teamLabel}`,
    members: EVENT.members?.[id] || []
  };
});

export function getSavedTeam() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
export function saveTeam(team) {
  try { localStorage.setItem(KEY, JSON.stringify(team)); } catch { /* 저장 불가 시 이번 접속만 유지 */ }
}
export function clearTeam() {
  try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
}

/** 이 조에 누가 들어왔다는 표시. 입장 화면이 "PIN 정하기 / PIN 입력"을 고르는 데 쓴다. */
export const claimTeam = team =>
  safeWrite(`teams/${team.id}`, { name: team.name, claimedAt: Date.now() });

/** 최초 입장자가 PIN을 정한다. 규칙상 이미 PIN이 있으면 거부된다. */
export async function setPin(team, pin) {
  const res = await safeWrite(`pins/${team.id}/${pin}`, { setAt: Date.now() });
  if (res.ok) {
    await claimTeam(team);
    return { ok: true };
  }
  return { ok: false, reason: res.error === 'PERMISSION_DENIED' ? 'taken' : 'network' };
}

/** PIN 목록은 읽을 수 없고, 입력한 PIN의 정확한 경로만 읽을 수 있다. */
export async function checkPin(team, pin) {
  try {
    return (await read(`pins/${team.id}/${pin}`)) ? { ok: true } : { ok: false, reason: 'wrong' };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
