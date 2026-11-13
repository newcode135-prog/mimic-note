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

## 처음 한 번

```bash
node mimic-note/telegram.mjs connect   # 저장소 주인 계정, 본인 터미널에서: 봇 토큰 → 팀원별 일회용 링크
npm test                               # 외부 패키지 없음, Node 22 이상
```

이 저장소는 `newcode135-prog/mimic` 의 `mimic-note/`(2026-11-13, 커밋 69f8381)를 옮겨 온 것입니다.
