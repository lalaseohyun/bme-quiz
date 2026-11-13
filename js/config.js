// config.js — 행사 설정. 문항은 data/questions.json (진행자 화면만 불러온다)

export const EVENT = {
  title: 'BME 커넥트 캠프 · BME REAL',
  subtitle: 'BME 전공⁠·⁠직무 상식 QUIZ',   // ⁠: '전공·직무'가 '·' 앞뒤에서 꺾이지 않게
  lobbyMessage: 'QR코드로 접속해 우리 팀을 골라 주세요.',
  // 대기 화면 QR이 가리킬 참가자 주소. 진행자 화면을 어디서 열든(내 컴퓨터의 localhost 포함) 항상 이 주소로 QR을 만든다.
  joinUrl: 'https://lalaseohyun.github.io/bme-quiz/',
  teamLabel: '팀',
  teamCount: 7,             // 19명 → 3명×6팀 + 4명×1팀
  teamNames: {},            // 비워 두면 1팀, 2팀 … 으로 표시. 예) { 1: '심박팀' } (키는 숫자 1..N)
  members: {},              // 예) 1: ['홍길동', '김철수']
  joinMode: 'open',         // 팀 번호를 누르면 바로 입장
  showRanking: true,        // 최종 순위 표시
  tieBreak: 'speed'         // 동점이면 맞힌 문항의 응답시간 합이 짧은 팀이 위
};

// ─────────────────────────────────────────────────────────────
// ★ Firebase 설정 — 라라가 직접 채우는 곳 ★
// Firebase 콘솔 > 프로젝트 설정(톱니바퀴) > 일반 > 내 앱(웹 </>) > SDK 설정 및 구성 > "구성(Config)"
// 의 값 5개를 따옴표 안에 그대로 붙여 넣는다.
// databaseURL은 지역이 포함된 전체 주소여야 한다 (https://…asia-southeast1.firebasedatabase.app).
// 비어 있으면: localhost에서는 "로컬 테스트 모드"(같은 브라우저 탭끼리만 연결), 배포 주소에서는 설정 오류 안내.
// ─────────────────────────────────────────────────────────────
export const FIREBASE = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',
  projectId: '',
  appId: ''
};

// 기존 Firebase 프로젝트를 재사용할 때 다른 데이터와 섞이지 않게 이 경로 아래에만 쓴다.
export const ROOT = 'bmequiz';
