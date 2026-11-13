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

필요한 것: 클라우드플레어 무료 계정, GitHub fine-grained 토큰(저장소 `mimic-note` 만, **Contents = Read and write**) — 자세한 건 `worker/setup.mjs` 맨 위.

## 텔레그램에서 보는 법

1. 텔레그램에서 **@mimic_note_team_bot**(코어 오브 미믹노트)을 열거나 https://t.me/mimic_note_team_bot
2. **/start** → 대화창 아래에 [창민봇] [민호봇] … [📋 팀 현황] [📤 보낸 미션] 버튼판이 뜹니다(안 보이면 입력창 옆 ⌘ 버튼)
3. 본인 이름봇 → 내 미션 + [✅ 번호] 완료 버튼 · 다른 사람 이름봇 → 그 사람 미션 + [📨 미션 주기](관리자) / [📨 미션 요청](팀원 → 관리자, 수락하면 미션)
4. 미션이 바뀌면 그 사람에게 자동 알림(🆕 새 미션 · ✅ 방금 완료 · 미션을 준 사람에게 완료 알림), 요청·수락·거절도 바로 알림
5. 글로도 됩니다: `창민 이거 결제해줘` · `민호 미션완료 2` · (관리자) `루카스 연결링크`

## 버튼으로 내 미션 받기 — 코어 오브 미믹노트 봇

텔레그램 봇 대화창 아래의 이름봇 버튼으로 서로의 미션을 보고, 버튼으로 완료·주기·요청·수락·거절합니다(자세한 표는 `mimic-note/README.md` 의 "미션 앱"). 관리자가 준 미션은 바로 미션이 되고, 팀원이 관리자에게 보낸 요청은 수락해야 미션이 됩니다(대전제: 배정은 관리자). 버튼은 봇이 켜져 있을 때만 동작합니다. 봇은 항상 켜진 컴퓨터 한 대에서 `node mimic-note/bot.mjs` (맥미니: `bash mimic-note/bot-install-macmini.sh`).

## 처음 한 번

```bash
node mimic-note/telegram.mjs connect   # 저장소 주인 계정, 본인 터미널에서: 봇 토큰 → 팀원별 일회용 링크
npm test                               # 외부 패키지 없음, Node 22 이상
```

이 저장소는 `newcode135-prog/mimic` 의 `mimic-note/`(2026-11-13, 커밋 69f8381)를 옮겨 온 것입니다.
