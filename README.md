# 미믹 노트 (MIMIC NOTE)

팀원 5명의 미션·체크인·텔레그램 알림을 관리하는 중앙 기록장입니다. 미믹 클라우드 서비스([`newcode135-prog/mimic`](https://github.com/newcode135-prog/mimic))와 분리된 저장소입니다.

> ## 🤖 접속 — `이름 + 이 저장소 링크`
>
> Claude Code 에 `민호 https://github.com/newcode135-prog/mimic-note` 처럼 보내면 접속입니다. Claude Code 는 이 저장소를 받아(`git clone` / `git pull`) `node mimic-note/checkin.mjs <이름>` 을 실행하고, **① 대전제 → ② 그 팀원의 미션 → ③ 자동 투두 → ④ 마지막 사고력 게임 → 📨 텔레그램 결과** 순서로 전합니다.

## 미션 주기 (대표·관리자가 Claude Code 에 이렇게 입력)

```
민호 미션설정
1. 로그인 UI 개발
2. 파일 다운로드 API 테스트
3. 모바일 화면 검수
```

```
민호 미션추가
4. API 성능 최적화
```

```
민호 미션완료 2
```

```
미믹 전체미션
```

입력하면 GitHub 에 바로 저장되고, GitHub Actions 가 **미션이 바뀐 팀원에게만** 그 사람 텔레그램으로 최신 미션을 보냅니다. 자세한 동작·권한·한계: [`mimic-note/README.md`](mimic-note/README.md)

## 24시간 봇 서버 — 클라우드플레어 워커(무료)

텔레그램이 봇 서버(`worker/index.mjs`)를 웹훅 API 로 바로 부르므로 **PC·맥미니가 꺼져 있어도** 버튼·미션 명령·연결이 24시간 동작합니다. 미션 변경 알림은 GitHub Actions 가 만들어 이 서버를 거쳐 보냅니다(텔레그램 chat id 는 서버에만 있음).

```bash
node worker/setup.mjs     # 저장소 주인이 본인 터미널에서 한 번: 클라우드플레어 로그인 → 배포 → 웹훅 연결
```

필요한 것: 클라우드플레어 무료 계정, GitHub fine-grained 토큰(저장소 `mimic-note` 만, Contents·Actions 읽기/쓰기) — 자세한 건 `worker/setup.mjs` 맨 위.

## 텔레그램에서 보는 법

1. 텔레그램에서 **@mimic_note_team_bot**(코어 오브 미믹노트)을 열거나 https://t.me/mimic_note_team_bot
2. **/start** → 대화창 아래에 [창민봇] [민호봇] [유리봇] [네이뜬봇] [루카스봇] 버튼판이 뜹니다(안 보이면 입력창 옆 ⌘ 버튼)
3. 본인 버튼 → 지금 보고할 미션 · `민호 미션완료 2` → 완료 · (관리자) `창민 이거 결제해줘` → 미션 주기 · `루카스 연결링크` → 새 팀원 연결 링크
4. 미션이 바뀌면 그 사람에게 자동 알림(🆕 새 미션 · ✅ 방금 완료 · 완료 알림)

## 버튼으로 내 미션 받기 — 코어 오브 미믹노트 봇

텔레그램 봇 대화창 아래의 **[창민봇] [민호봇] [유리봇] [네이뜬봇] [루카스봇]** 중 본인 버튼을 누르면 지금 보고할 미션이 옵니다(남의 버튼은 거절). 관리자는 봇에 `창민 이거 결제해줘` 를 보내 미션을 줄 수 있고(확인 버튼 후 저장), 받는 사람에게 `🆕 새 미션 … (민호님이 줌)` 알림이 갑니다. 봇은 항상 켜진 컴퓨터 한 대에서 `node mimic-note/bot.mjs` (맥미니: `bash mimic-note/bot-install-macmini.sh`).

## 처음 한 번

```bash
node mimic-note/telegram.mjs connect   # 저장소 주인 계정, 본인 터미널에서: 봇 토큰 → 팀원별 일회용 링크
npm test                               # 외부 패키지 없음, Node 22 이상
```

이 저장소는 `newcode135-prog/mimic` 의 `mimic-note/`(2026-11-13, 커밋 69f8381)를 옮겨 온 것입니다.
