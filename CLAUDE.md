# 미믹 노트 저장소 작업 규칙 (Claude Code 가 자동으로 읽음)

이 저장소는 팀원 미션·체크인·텔레그램 알림 전용입니다. 미믹 클라우드 서비스(`newcode135-prog/mimic`)와 분리되어 있습니다.

## 0. 접속 암호구 → 대전제 → 미션

사용자 입력이 `<팀원 이름> https://github.com/newcode135-prog/mimic-note` 형태(예: `민호 https://github.com/newcode135-prog/mimic-note`, `lucas https://…/mimic-note`, 대괄호로 감싸도 같음)이면 미믹노트 **접속 암호구**다. (예전 주소 `…/newcode135-prog/mimic` 로 보내도 같은 접속으로 본다.) 바로:

1. 이 저장소가 없으면 `git clone https://github.com/newcode135-prog/mimic-note.git` 후 그 폴더로, 있으면 `git pull`
2. `node mimic-note/checkin.mjs <이름>`

출력된 **① 대전제**(`mimic-note/premise.md`)를 먼저, **② 그 팀원의 미션**(1번·2번·3번 …)을 그다음에 그대로 전하고, 그 세션 동안 대전제를 따른다. 미션이 0개면 "관리자가 등록하면 다시 체크인"이라고 안내한다. 맨 끝의 `📨 텔레그램` 줄(GitHub Actions 의 실제 발송 결과)도 그대로 전한다 — "요청함"을 "보냄"이라고 바꿔 말하지 않는다.

### 0-1. 미션 명령 (대표·관리자가 자연어로 입력 → 그대로 실행, JSON 직접 수정·Actions 버튼 금지)

| 사용자 입력 | 실행 |
| --- | --- |
| `민호 미션설정` + 줄마다 `1. 업무 A` … | `node mimic-note/mission.mjs set 민호 <<'EOF'` → 입력한 목록 줄을 그대로 → `EOF` |
| `민호 미션추가` + `4. 업무 D` … | `node mimic-note/mission.mjs add 민호 <<'EOF'` → 목록 → `EOF` (`최우선`이라고 하면 `--top`) |
| `민호 미션완료 2` (여러 개: `2 3`) | `node mimic-note/mission.mjs done 민호 2` |
| `민호 https://github.com/newcode135-prog/mimic-note` | 위 체크인(`node mimic-note/checkin.mjs 민호`) |
| `미믹 전체미션` | `node mimic-note/mission.mjs all` |
| `텔레그램 연결` | 사용자에게 **본인 터미널(PowerShell 등)에서** `node mimic-note/telegram.mjs connect` 를 실행하라고 안내(토큰을 대화에 붙여 넣게 하지 않는다) |

- 이 명령들은 GitHub main 에 **바로 저장**(커밋)하고, GitHub Actions 가 미션이 바뀐 팀원에게만 텔레그램을 보낸 뒤 결과를 출력한다. 따로 commit·push 하지 않는다. 출력(커밋 링크·남은 미션·텔레그램 결과)을 그대로 전한다.
- 누가 바꾸는지는 이 컴퓨터의 `gh` 로그인 계정 ↔ `mimic-note/data/members.json` 의 `github` 로 확인한다(`--by` 는 쓰지 않음). 거절되면 그 문구를 그대로 전하고, 권한을 우회하지 않는다.
- 미션 만들기·정하기·후순위는 관리자(창민·민호·유리)만, 완료는 본인 또는 관리자만.
- 대전제는 대표관리자(창민)만 고친다. 버전·날짜를 올린다.

### 0-2. 그 밖의 미믹노트 명령

- 플레이어가 [데이터 라벨링]·[데이터 압축]·[데이터 업로드]를 했다고 하면 `node mimic-note/work.mjs <이름> <라벨링|압축|업로드> <대상> <시작|완료>` → 그 사람 폴더(`mimic-note/data/players/<아이디>/`)만 commit·push. 남의 폴더와 `data/auto/` 는 손대지 않는다.
- `mimic-note/data/auto/todos.json` 은 패시브 스킬 [자동 다운로드](`mimic-note/passive/`)만 쓴다.
- [사고력 게임]: 체크인 ④에 마지막 게임이 나온다. 플레이어가 답하면 `node mimic-note/game.mjs <이름> answer "<답>"` → commit·push.
- 액티브 스킬 [로그아웃]: `[로그아웃]` 이라고 하면 `node mimic-note/logout.mjs <이름>` → 최종본의 라벨·결정·다음만 고침 → `node mimic-note/logout.mjs <이름> --upload "<파일>"`.
- 팀원 명부·진행 기록은 `mimic-note/README.md`. 토큰·chat id 는 파일에 쓰지 않는다(공개 저장소).

## 1. 그 밖의 규칙

- 바꾼 뒤에는 `npm test` 가 모두 통과해야 한다(외부 패키지 없음, Node 22 이상).
- 쓰기 권한 = 신뢰하는 팀원만. GitHub Actions 의 권한 확인은 실수·직접 수정을 잡는 감지 장치다(`mimic-note/README.md` 의 한계 참고).
