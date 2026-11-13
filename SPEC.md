# BME 전공·직무 상식 QUIZ — 실시간 팀 대항전 설계서 (SPEC)

「BME 커넥트 캠프」 BME REAL 세션용. 진행자 화면 1개(프로젝터)와 팀별 휴대폰 1대가 실시간으로 묶여 돌아가는 팀 퀴즈.
문항은 같은 폴더의 `questions.json`(연습 1 + 본문 8 + 보너스 1 = 10문항)을 그대로 쓴다.

## 0. 결정이 필요한 것 (구현 전에 확인)

| # | 항목 | 기본값(이 설계서 기준) | 다른 선택지 |
|---|---|---|---|
| 1 | Firebase 프로젝트 | 기존 프로젝트 재사용, 루트 경로 `bmequiz/` 로 분리 | 새 프로젝트 생성 (콘솔 작업은 라라) |
| 2 | 팀 수 | 7팀 (19명 → 3명×6팀 + 4명×1팀), 진행자 로비에서 4~10 사이로 변경 가능 | 6팀(3~4명) |
| 3 | 점수 | 정답 100점, 속도 가산 없음, 동점은 누적 응답시간 짧은 팀 우선. BONUS 200점, 연습문제 0점 | 속도 가산(최대 +50) 추가 |
| 4 | 제한시간 | **없음.** 진행자가 제출 현황을 보고 수동으로 마감 | — |

## 1. 구성과 배포

- 정적 사이트 + Firebase Realtime Database(asia-southeast1). 서버 없음.
- 배포: GitHub Pages `lalaseohyun.github.io/bme-quiz/`
- 빌드 도구 없이 바닐라 JS(ES 모듈). Firebase는 CDN 모듈 import.
- **금지**: RTDB 규칙에 `now < timestamp` 식의 만료 조건을 넣지 않는다(과거 리더보드 잠김 버그).

```
bme-quiz/
  index.html          참가 팀(휴대폰) 화면
  host.html           진행자(프로젝터) 화면
  css/style.css
  js/config.js        Firebase 설정 (라라가 값 주입)
  js/db.js            RTDB 래퍼: sub(path, cb), set, update, remove, serverNow
  js/derive.js        state + 문항 → live (공개용 뷰) 순수 함수
  js/score.js         채점·순위 순수 함수
  js/host.js          진행자 화면 로직
  js/team.js          참가 화면 로직
  data/questions.json 문항 (정답 포함) — host.html 만 불러온다
  test/score.test.mjs node --test 로 도는 채점 단위 테스트
  SPEC.md
```

## 2. 핵심 원칙 — 전체 상태와 공개 상태를 나눈다

- `state`는 진행자만 읽고 쓴다. 새로고침해도 이어서 진행할 수 있는 최소 정보.
- `live`는 진행자가 `state`가 바뀔 때마다 **다시 계산해서 통째로 덮어쓰는** 공개용 뷰. 참가 화면은 문항 내용을 `live`에서만 받는다.
- 정답·해설 필드는 `revealed === true`일 때만 `live`에 **들어간다**. 그 전에는 필드 자체가 없다(화면에서 숨기는 방식 금지).
- 참가 화면(`index.html`, `team.js`)은 `data/questions.json`을 절대 불러오지 않는다.
  - 한계: 정적 파일이라 주소를 아는 사람은 직접 열 수 있음. 캠프 내부 1회성 행사라 감수하는 절충임.

## 3. 데이터 모델 (RTDB, 루트 `bmequiz/`)

```
bmequiz/
  meta/    { resetAt: number, teamCount: 7 }
  state/   { phase: "lobby"|"quiz"|"final", index: 0, open: false, revealed: false,
             openedAt: number|null, asked: { [qid]: true } }
  live/    { phase, index, total, qid, label, category, type: "choice"|"ox",
             text, choices: [..] (ox면 생략), open, revealed, scored, points,
             // revealed === true 일 때만:
             answer, explain,
             // revealed 또는 final 일 때만:
             ranking: [{ team, name, score, ms, rank }] }
  teams/{teamNo}/   { name, members, deviceId, joinedAt }
  answers/{qid}/{teamNo}/  { choice, ms, at }
```

- `choice`: 4지선다는 0~3, OX는 `"O"`/`"X"`.
- `ms`: **그 휴대폰이 문항을 처음 본 순간부터** 제출까지의 경과시간(기기 로컬 기준). 진행자 시각과 비교하지 않는다.
- 각 팀은 `answers/{qid}/{자기 팀번호}`에만 쓴다(부모 경로 통째 쓰기 금지).
- 한 번 제출하면 잠금(클라이언트에서 재제출 차단). 문항 리셋 시에만 다시 풀 수 있다.

### RTDB 규칙 (행사용 최소 구성)

```json
{
  "rules": {
    "bmequiz": {
      ".read": true,
      ".write": true,
      "answers": { "$qid": { "$team": {
        ".validate": "newData.hasChildren(['choice','ms'])"
      } } }
    }
  }
}
```

- 진행자 화면은 `host.html?key=...` 의 키를 `js/config.js`의 `HOST_KEY`와 비교해 틀리면 조작 버튼을 숨긴다(클라이언트 단 확인).
- 내부 1회성 행사 기준의 절충. 기존 프로젝트를 재사용하면 **다른 경로의 규칙은 건드리지 않고 `bmequiz` 블록만 추가**한다.
- 행사 후 `bmequiz` 의 `.write`를 `false`로 바꾼다.

## 4. 진행 흐름

### 4.1 진행자 화면의 단계 (문항 1개 기준)

공유 상태는 `open`, `revealed` 두 개뿐. 아래 세부 단계는 **진행자 화면의 로컬 상태**로만 둔다(백엔드에 쓰지 않음).

| 단계 | 화면 | 공유 상태 변화 |
|---|---|---|
| ① 문제 | 라벨·분야·문제 문장만 크게 | `index` 변경, `open=false`, `revealed=false` |
| ② 보기 + 응답 시작 | 보기 4개(또는 O/X), "제출 n/7팀" (타이머 없음) | `open=true`, `openedAt` 기록, `asked[qid]=true` |
| ③ 마감 | 진행자가 수동으로 마감. 보기별 선택 팀 수 막대 | `open=false` |
| ④ 사전 질문 | `preTalk`가 있는 문항(Q8)만: 질문 카드 표시 | 없음 |
| ⑤ 정답 공개 | 정답 강조, 맞힌 팀 표시, `explain` | `revealed=true` (live에 answer·explain·ranking 포함) |
| ⑥ 해설 더 보기 | `explainMore` / `explainList` | 없음 |
| ⑦ 함께 이야기 | `talk` 질문 카드, `bridge`(선배 연결 문구) | 없음 |
| ⑧ 중간 순위 | 순위표(연습문제는 생략) | 없음 |

- 조작: `Space`/`→` 다음 단계, `←` 이전 단계(로컬 단계만), `N` 다음 문항, `R` 이 문항 다시(응답 삭제 후 ①로).
- 화면 구석에 작은 버튼으로도 같은 조작 제공(리모컨·터치 대비).
- `hostNote`는 프로젝터에 띄우지 않는다. `host.html?notes=1` 일 때만 화면 아래 작은 글씨로 표시.
- 제한시간·카운트다운은 두지 않는다. 전 팀이 제출하면 자동 마감하지 말고 "전 팀 제출 완료" 표시만 띄운다(진행자가 넘김).
- 미제출 팀이 있어도 진행자가 마감할 수 있다. 진행자 화면에 아직 제출하지 않은 팀 이름을 표시한다.
- 마지막 문항(BONUS) 뒤 `closing` 문구 → `phase="final"` → 최종 순위(3·2·1위 순서로 공개).

### 4.2 전체 단계

- `lobby`: 제목, 참가 QR(참가 주소), 팀 카드 7개(이름·팀원이 차는 모습), "시작" 버튼.
- `quiz`: 4.1 반복. 연습문제(p0)는 점수 없음 안내.
- `final`: 최종 순위. 참가 화면에도 자기 팀 순위 표시.

### 4.3 참가(휴대폰) 화면

1. **입장**: 팀 번호 버튼 1~7 (이미 잡힌 팀은 팀 이름 표시). 선택 후 팀 이름, 팀원 이름(선택 입력) → 입장.
   - `deviceId`는 localStorage에 저장. 같은 기기는 새로고침해도 자동 복귀.
   - 이미 다른 기기가 잡은 팀을 고르면 경고만 띄우고 허용(휴대폰이 꺼졌을 때 대타 가능).
2. **대기**: "곧 시작합니다" + 팀 이름.
3. **문제**(`open=false`, 미공개): 문제 문장만, "화면을 보고 팀과 이야기해 보세요".
4. **응답**(`open=true`): 보기 버튼(4지선다는 ①~④ 큰 버튼, OX는 O/X 두 개). 누르면 선택 표시 → **"제출" 버튼으로 확정**(팀 토론 중 오터치 방지). 남은 시간 표시는 없다.
5. **제출 완료**: 고른 보기 표시, "정답 공개를 기다려 주세요". `open=false`가 되면 미제출 팀은 "응답이 마감되었습니다".
6. **공개**: 정답/오답, 획득 점수, 현재 순위(`live.ranking`에서 자기 팀).
7. **최종**: 자기 팀 순위와 점수.

- `meta.resetAt`이 바뀌면 localStorage의 팀 정보를 지우고 입장 화면으로 돌아간다.
- `.info/connected`로 연결 상태 배지 표시(끊김 시 "연결 중…").
- 가능하면 Screen Wake Lock으로 화면 꺼짐 방지(미지원 기기는 무시).

## 5. 채점 (`js/score.js`, 순수 함수)

```js
// questions: 문항 배열, answers: { [qid]: { [teamNo]: {choice, ms} } }, teams: { [teamNo]: {name} }
// asked: 지금까지 공개된 qid 집합
rank(questions, answers, teams, asked) -> [{ team, name, score, ms, correct, rank }]
realAnswers(answersForQid) -> 유효 응답만 { [teamNo]: {choice, ms} }
```

- `realAnswers`: 키가 팀 번호이고 `choice`가 유효값(0~3 또는 "O"/"X")이며 `ms`가 숫자인 것만 통과. **제출 수, 보기별 집계, 정답 표시 모두 이 함수 하나를 거친다.**
- 점수: `scored !== false`인 문항에서 정답이면 `points`(기본 100, BONUS 200).
- `ms` 합계는 **정답을 맞힌 문항의 응답시간만** 더한다. 동점이면 `ms` 합계가 작은 팀이 위. 그래도 같으면 같은 순위.
- 중간 순위와 최종 순위는 같은 `rank()` 호출 결과를 쓴다.
- 단위 테스트: 동점 처리, 연습문제 제외, BONUS 배점, 리셋 뒤 빈 객체, 잘못된 응답 무시.

## 6. 리셋

- **문항 리셋**(`R`): `answers/{qid}` 삭제, `open=false`, `revealed=false`. 참가 화면은 `live` 변화로 자동 복귀.
- **전체 리셋**(로비의 버튼, 확인창 1회): `answers` 전체, `teams` 전체 삭제, `state`를 lobby 초기값으로, `meta.resetAt = 현재시각`.
- 리허설 후 본 진행 전에 전체 리셋 필수.

## 7. 렌더링·안정성

- 진행자 화면은 `state`, `teams`, `answers`, `meta`를 동시에 구독한다. 각 콜백에서 바로 그리지 말고 `setTimeout(render, 0)` 플래그로 묶는다. `requestAnimationFrame`은 쓰지 않는다(탭이 가려지면 멈춤).
- QR은 로비 진입 시 1회만 생성(렌더마다 재생성 금지).
- 진행자 새로고침 시 `state`에서 복구. 로컬 세부 단계는 `open/revealed`로 추정(공개됨 → ⑤, 열림 → ②, 그 외 → ①).
- 진행자 화면이 두 개 열리면 뒤에 열린 쪽에 경고("진행자 화면이 이미 열려 있습니다").

## 8. 화면 디자인

- 색: 주황 `#EF7F01`, 짙은 회색 `#363233`, 크림 `#FFF8F3`, 연주황 `#FDE6D2`, 회색 `#8A8984`.
- 캠프 포스터처럼 왼쪽 위·오른쪽 아래 주황 세로 띠, 둥근 알약 라벨, 말풍선형 질문 카드.
- 글꼴: 제목 페이퍼로지(웹폰트 주소 확인 필요, 없으면 Pretendard 800), 본문 Pretendard.
- 진행자 화면은 16:9, 뒤쪽 자리에서도 읽히게 문제 44px 이상·보기 32px 이상. 문장이 긴 문항(Q2, Q5)은 자동 축소.
- 참가 화면은 세로 휴대폰 기준, 보기 버튼 높이 64px 이상, 한 손 조작.
- 보기 표시: ①②③④ 번호 + 색 구분(색만으로 구분하지 않음).

## 9. 진행 시간 (참고)

- 제한시간이 없으므로 진행자가 속도를 조절한다. 문항당 약 2분 30초(토론·응답 40초 안팎 + 공개·해설·질문 약 1분 50초)로 잡으면 10문항에 약 25분.
- BME REAL(15:10~16:00) 안에서 쓰려면 입장 3분 포함 30분 안팎. 시간이 부족하면 Q5·Q6을 건너뛴다(진행자 화면에서 `N`).

## 10. 완료 기준

- [ ] 휴대폰 7대(또는 브라우저 탭 7개)로 입장 → 10문항 → 최종 순위까지 끊김 없이 진행
- [ ] 정답 공개 전 `bmequiz/live`에 `answer`·`explain` 키가 없음(개발자도구로 확인)
- [ ] 참가 화면 네트워크 탭에 `questions.json` 요청이 없음
- [ ] 진행자 새로고침 후 같은 문항에서 이어짐
- [ ] 문항 리셋 뒤 제출 수가 0으로 표시됨
- [ ] 전체 리셋 뒤 모든 휴대폰이 입장 화면으로 돌아감
- [ ] `node --test test/` 통과
