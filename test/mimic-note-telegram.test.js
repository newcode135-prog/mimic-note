// 미믹노트: 미션설정·추가·완료 → GitHub 저장 → GitHub Actions 텔레그램 발송 → 팀원 연결.
// 가짜 GitHub·git·텔레그램만 쓴다(실제 발송 시험은 맨 아래, 환경변수가 있을 때만).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOTE_DIR, loadMembers, openMissions, doneMissions, parseMissionList, setMissions, addMissions, completeMissions,
  setLowPriority, validateDb, validateMembers, telegramApi,
} from '../mimic-note/lib.mjs';
import { run } from '../mimic-note/mission.mjs';
import { renderTelegram, renderDoneNotice, verifyChange, runNotify, hashText } from '../mimic-note/notify.mjs';
import { processUpdates, setEnvVar, makeCode, secretName } from '../mimic-note/telegram.mjs';
import { waitForNotify, parseResults, formatNotify } from '../mimic-note/github.mjs';
import { telegramViaActions } from '../mimic-note/checkin.mjs';
import { fakeGithub, fakeGit, fakeTelegram, DB_FILE, MEMBERS_FILE } from './mimic-note-fakes.js';

const T = '2026-11-13T00:00:00.000Z';
const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const empty = () => ({ nextId: 1, missions: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const titles = (db, id) => openMissions(db, id).map((m) => m.title);
const list3 = parseMissionList('민호 미션설정\n\n1. 로그인 UI 개발\n2. 파일 다운로드 API 테스트\n3. 모바일 화면 검수');
const noSleep = async () => {};

function tempNote(members = M) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-note-tg-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'members.json'), JSON.stringify({ members }, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'missions.json'), JSON.stringify(empty()));
  return dir;
}

// ---------------- 미션 DB 규칙 ----------------

test('시나리오 1·2: 민호 미션 3개 등록 → 1·2·3번 순서와 고유 ID', () => {
  const db = empty();
  const r = setMissions(db, '민호', list3, 'changmin', M, T);
  assert.equal(r.changed, true);
  assert.deepEqual(titles(db, 'minho'), ['로그인 UI 개발', '파일 다운로드 API 테스트', '모바일 화면 검수']);
  assert.deepEqual(openMissions(db, 'minho').map((m) => m.id), ['M-0001', 'M-0002', 'M-0003']);
  assert.deepEqual(validateDb(db, M), []);
});

test('시나리오 3·4: 유리에게 다른 미션 — 민호와 데이터가 섞이지 않는다', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  setMissions(db, '유리', parseMissionList('1. 온보딩 문서 읽기\n2. 첫 커밋'), 'changmin', M, T);
  assert.deepEqual(titles(db, 'yuri'), ['온보딩 문서 읽기', '첫 커밋']);
  assert.equal(titles(db, 'minho').length, 3);
  assert.ok(openMissions(db, 'yuri').every((m) => m.assignee === 'yuri'));
  assert.ok(!renderTelegram(M[1], db).includes('온보딩'), '민호 메시지에 유리 미션이 없어야 한다');
});

test('시나리오 5·6: 민호 2번 완료 → 남은 목록이 당겨지고 고유 ID 는 그대로', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  const [done] = completeMissions(db, 'minho', ['2'], { by: 'minho', members: M }, T);
  assert.equal(done.id, 'M-0002');
  assert.deepEqual(openMissions(db, 'minho').map((m) => [m.id, m.title]), [['M-0001', '로그인 UI 개발'], ['M-0003', '모바일 화면 검수']]);
  assert.deepEqual(doneMissions(db, 'minho').map((m) => [m.id, m.doneBy]), [['M-0002', 'minho']]);
  // 여러 번호는 모두 완료 전 목록 기준
  completeMissions(db, 'minho', ['1', '2'], { by: 'changmin', members: M }, T);
  assert.deepEqual(titles(db, 'minho'), []);
});

test('시나리오 7: 중복 생성 방지 — 같은 목록 미션설정은 변경 없음, 있는 제목 미션추가는 건너뜀, 목록 안 중복 제외', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  const before = clone(db);
  const again = setMissions(db, '민호', parseMissionList('1.  로그인 UI 개발 \n2. 파일 다운로드 API 테스트\n3. 모바일 화면 검수'), 'changmin', M, T);
  assert.equal(again.changed, false);
  assert.deepEqual(db, before);
  const add = addMissions(db, '민호', parseMissionList('4. 로그인 UI 개발\n5. API 성능 최적화\n6. API 성능 최적화'), 'changmin', M, {}, T);
  assert.deepEqual(add.skipped, ['로그인 UI 개발', 'API 성능 최적화']);
  assert.deepEqual(add.added.map((m) => [m.id, m.title]), [['M-0004', 'API 성능 최적화']]);
  const dup = setMissions(db, '유리', parseMissionList('1. A\n2. A\n3. B'), 'changmin', M, T);
  assert.equal(dup.skipped, 1);
  assert.deepEqual(titles(db, 'yuri'), ['A', 'B']);
});

test('미션설정: 빠진 기존 미션은 지우지 않고 보관(replaced), 같은 제목은 ID 유지, 완료 기록 보존', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  completeMissions(db, 'minho', ['3'], { by: 'minho', members: M }, T);
  const r = setMissions(db, '민호', parseMissionList('1. 파일 다운로드 API 테스트\n   서버 로그도 확인\n2. 새 업무'), 'minho', M, T);
  assert.deepEqual(r.kept.map((m) => m.id), ['M-0002']);
  assert.deepEqual(r.added.map((m) => m.id), ['M-0004']);
  assert.deepEqual(r.replaced.map((m) => [m.id, m.status, m.replacedBy]), [['M-0001', 'replaced', 'minho']]);
  assert.deepEqual(titles(db, 'minho'), ['파일 다운로드 API 테스트', '새 업무']);
  assert.equal(openMissions(db, 'minho')[0].detail, '서버 로그도 확인');
  assert.equal(db.missions.length, 4, '아무것도 지우지 않는다');
  assert.equal(db.missions.find((m) => m.id === 'M-0003').status, 'done');
  assert.throws(() => setMissions(db, '민호', [], 'changmin', M, T), /1개 이상/);
  assert.deepEqual(validateDb(db, M), []);
});

test('미션추가 --top: 넣은 순서대로 맨 앞에', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  addMissions(db, '민호', parseMissionList('1. 급한 일\n2. 그다음 급한 일'), 'changmin', M, { top: true }, T);
  assert.deepEqual(titles(db, 'minho').slice(0, 3), ['급한 일', '그다음 급한 일', '로그인 UI 개발']);
});

test('시나리오 9·10: 없는 팀원 거부, 관리자 아니면 설정·추가·후순위·남의 미션 완료 불가, 본인 완료는 가능', () => {
  const db = empty();
  assert.throws(() => setMissions(db, '철수', list3, 'changmin', M, T), /팀원을 찾지 못했습니다/);
  assert.throws(() => setMissions(db, '민호', list3, 'nathan', M, T), /관리자가 아니라/);
  assert.throws(() => addMissions(db, '민호', list3, 'lucas', M, {}, T), /관리자가 아니라/);
  setMissions(db, '네이뜬', list3, 'yuri', M, T); // 유리는 관리자
  assert.throws(() => setLowPriority(db, 'nathan', 1, 'lucas', M), /관리자가 아니라/);
  assert.throws(() => completeMissions(db, 'nathan', ['1'], { by: 'lucas', members: M }, T), /다른 사람의 미션을 완료할 수 없습니다/);
  completeMissions(db, 'nathan', ['1'], { by: 'nathan', members: M }, T);
  assert.equal(titles(db, 'nathan').length, 2);
});

test('parseMissionList: 1. / 2) / 3번 / - / 1️⃣ / 들여쓴 설명 / 번호 없는 줄', () => {
  assert.deepEqual(parseMissionList('1) A\n2번 B\n  B 설명\n- C\n1️⃣ D'), [
    { title: 'A', detail: '' }, { title: 'B', detail: 'B 설명' }, { title: 'C', detail: '' }, { title: 'D', detail: '' },
  ]);
  assert.deepEqual(parseMissionList('민호 미션추가\n업무 X\n업무 Y').map((x) => x.title), ['업무 X', '업무 Y']);
  assert.deepEqual(parseMissionList('\n\n'), []);
  assert.throws(() => parseMissionList(`1. ${'가'.repeat(201)}`), /너무 깁니다/);
});

test('검사: 깨진 미션 DB·명부를 잡아낸다(실제 저장소 데이터는 통과)', () => {
  assert.deepEqual(validateDb(JSON.parse(fs.readFileSync(path.join(NOTE_DIR, 'data', 'missions.json'), 'utf8')), loadMembers()), []);
  assert.deepEqual(validateMembers(loadMembers()), []);
  const bad = { nextId: 2, missions: [
    { id: 'M-0001', assignee: 'minho', order: 1, title: 'A', status: 'todo' },
    { id: 'M-0001', assignee: 'ghost', order: 'x', title: '', status: 'wip' },
    { id: 'M-0005', assignee: 'minho', order: 1, title: 'B', status: 'done' },
  ] };
  const e = validateDb(bad, M).join('\n');
  for (const s of ['id 중복', '명부에 없는 담당자', 'order 숫자', '제목', 'status', 'nextId', 'doneAt 없음']) assert.match(e, new RegExp(s));
  assert.match(validateMembers([...M, { id: 'x', name: 'X', role: 'owner', github: 'DarrenPual' }]).join('\n'), /GitHub 아이디 중복[\s\S]*정확히 1명/);
});

// ---------------- Claude Code 명령(mission.mjs) + 가짜 GitHub ----------------

test('CLI 미션설정: GitHub main 에 커밋 1번 + Actions 실제 발송 결과 표시, 같은 목록 다시 → 커밋·발송 없음', async () => {
  const dir = tempNote();
  const github = fakeGithub({ dir, login: 'darrenpual', results: [{ member: 'minho', status: 'sent', messageId: 7 }] });
  const stdin = async () => '민호 미션설정\n1. 로그인 UI 개발\n2. 파일 다운로드 API 테스트\n3. 모바일 화면 검수';
  const out = await run(['set', '민호'], { dir, github, stdin, sleep: noSleep });
  assert.match(out, /✅ GitHub 저장 완료 — 민호 미션설정: 새 3 · 유지 0 · 보관\(교체\) 0/);
  assert.match(out, /커밋 [0-9a-f]{7} https:\/\/github\.com\/newcode135-prog\/mimic-note\/commit\//);
  assert.match(out, /1\. \[M-0001\] 로그인 UI 개발\n {2}2\. \[M-0002\] 파일 다운로드 API 테스트\n {2}3\. \[M-0003\] 모바일 화면 검수/);
  assert.match(out, /민호: ✅ 발송 성공/);
  assert.match(github.commits[0].message, /^미믹노트: 민호 미션설정 — 새 3 · 유지 0 · 보관 0 \(by 창민·darrenpual\)$/);
  const again = await run(['set', '민호'], { dir, github, stdin, sleep: noSleep });
  assert.match(again, /변경 없음/);
  assert.equal(github.commits.length, 1);
  const add = await run(['add', '민호'], { dir, github, stdin: async () => '민호 미션추가\n4. API 성능 최적화', sleep: noSleep });
  assert.match(add, /미션추가 1개: \[M-0004\] API 성능 최적화/);
  assert.match(await run(['done', '민호', '2'], { dir, github, sleep: noSleep }), /완료: \[M-0002\] 파일 다운로드 API 테스트[\s\S]*1\. \[M-0001\][\s\S]*2\. \[M-0003\][\s\S]*3\. \[M-0004\]/);
});

test('CLI: 동시 수정으로 충돌하면 최신본을 다시 읽어 적용한다(남의 변경을 덮어쓰지 않음)', async () => {
  const dir = tempNote();
  let once = true;
  const github = fakeGithub({
    dir,
    login: 'darrenpual',
    beforeWrite(gh) {
      if (!once) return;
      once = false; // 그사이 유리가 다른 미션을 저장했다
      const db = JSON.parse(gh.store.get(DB_FILE).text);
      setMissions(db, '유리', parseMissionList('1. 유리 업무'), 'yuri', M, T);
      gh.put(DB_FILE, JSON.stringify(db));
    },
  });
  await run(['set', '민호'], { dir, github, stdin: async () => '1. 민호 업무', wait: false });
  const db = JSON.parse(github.store.get(DB_FILE).text);
  assert.deepEqual(titles(db, 'yuri'), ['유리 업무']);
  assert.deepEqual(titles(db, 'minho'), ['민호 업무']);
  assert.deepEqual(db.missions.map((m) => m.id), ['M-0001', 'M-0002']);
  assert.equal(github.writes, 2);
});

test('CLI: 쓰기 권한 없는 계정·명부에 없는 계정·관리자 아닌 계정은 거부(아무것도 저장 안 함)', async () => {
  const dir = tempNote();
  const stdin = async () => '1. X';
  await assert.rejects(run(['set', '민호'], { dir, github: fakeGithub({ dir, push: false }), stdin }), /쓰기 권한이 없어/);
  await assert.rejects(run(['set', '민호'], { dir, github: fakeGithub({ dir, login: '250909bs-svg' }), stdin }), /250909bs-svg 이 팀원 명부/);
  const gh = fakeGithub({ dir, login: 'nathan-gh' });
  await assert.rejects(run(['set', '민호'], { dir, github: gh, stdin }), /네이뜬님은 관리자가 아니라/);
  await assert.rejects(run(['set', '철수'], { dir, github: gh, stdin }), /팀원을 찾지 못했습니다/);
  assert.equal(gh.writes, 0);
});

test('CLI: 팀원은 본인 미션만 완료할 수 있다', async () => {
  const dir = tempNote();
  const db = empty();
  setMissions(db, '네이뜬', parseMissionList('1. N1\n2. N2'), 'changmin', M, T);
  setMissions(db, '민호', parseMissionList('1. H1'), 'changmin', M, T);
  const gh = fakeGithub({ dir, login: 'nathan-gh', db });
  await assert.rejects(run(['done', '민호', '1'], { dir, github: gh, wait: false }), /다른 사람의 미션을 완료할 수 없습니다/);
  assert.match(await run(['done', '네이뜬', '1'], { dir, github: gh, wait: false }), /완료: \[M-0001\] N1/);
});

test('CLI all: 5명 전체 현황(남은·완료·진행률·상위 3개)', async () => {
  const dir = tempNote();
  const db = empty();
  setMissions(db, '창민', parseMissionList('1. a\n2. b\n3. c\n4. d'), 'changmin', M, T);
  completeMissions(db, 'changmin', ['1'], {}, T);
  fs.writeFileSync(path.join(dir, 'data', 'missions.json'), JSON.stringify(db));
  const out = await run(['all'], { dir });
  assert.match(out, /■ 창민 \(대표관리자\) — 남은 3 · 완료 1 · 진행률 1\/4/);
  assert.match(out, /■ 루카스 \(팀원\) — 남은 0 · 완료 0/);
  assert.match(out, /합계: 남은 3 · 완료 1/);
});

// ---------------- 텔레그램 메시지 ----------------

test('텔레그램 메시지: 명세 형식 그대로(번호 이모지·진행률·남은 수, DB 에서 계산)', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  assert.equal(renderTelegram(M[1], db), [
    '🎯 <b>MIMIC NOTE</b>', '', '👤 <b>민호님의 미션</b>', '',
    '1️⃣ 로그인 UI 개발', '', '2️⃣ 파일 다운로드 API 테스트', '', '3️⃣ 모바일 화면 검수', '',
    '━━━━━━━━━━', '', '📊 진행률 0/3', '📌 남은 미션 3개',
  ].join('\n'));
});

test('텔레그램 메시지: 3개 초과는 "추가 미션" + 펼쳐 보기, 완료는 빠지고 진행률 반영, HTML 이스케이프, 빈 목록', () => {
  const db = empty();
  setMissions(db, '민호', parseMissionList('1. A <b>\n   설명 & 메모\n2. B\n3. C\n4. D\n5. E'), 'changmin', M, T);
  completeMissions(db, 'minho', ['2'], {}, T);
  const t = renderTelegram(M[1], db);
  assert.match(t, /1️⃣ A &lt;b&gt;\n<blockquote expandable>설명 &amp; 메모<\/blockquote>/);
  assert.ok(!t.includes('2️⃣ B'), '완료한 미션은 다시 나오지 않는다');
  assert.match(t, /3️⃣ D\n\n➕ 추가 미션 1개 \(눌러서 전체 보기\)\n<blockquote expandable>4️⃣ E<\/blockquote>/);
  assert.match(t, /📊 진행률 1\/5\n📌 남은 미션 4개$/);
  assert.match(renderTelegram(M[4], db), /🎉 남은 미션이 없어요![\s\S]*진행률 0\/0/);
});

// ---------------- Actions: 권한 확인 ----------------

test('verifyChange: push 한 GitHub 계정의 권한(push 전 명부 기준)', () => {
  const base = { db: empty(), members: M };
  setMissions(base.db, '네이뜬', parseMissionList('1. N1'), 'changmin', M, T);
  const after = (fn) => { const db = clone(base.db); fn(db); return { db, members: M }; };
  const added = after((db) => addMissions(db, '민호', parseMissionList('1. X'), 'yuri', M, {}, T));
  assert.deepEqual(verifyChange({ base, head: added, actor: 'emileepark5281-cmd' }), []);
  assert.match(verifyChange({ base, head: added, actor: 'nathan-gh' })[0], /네이뜬\(nathan-gh\): M-0002 추가\(관리자만\)/);
  assert.match(verifyChange({ base, head: added, actor: 'stranger' })[0], /명부에 없는 GitHub 아이디/);
  const selfDone = after((db) => completeMissions(db, 'nathan', ['1'], { by: 'nathan', members: M }, T));
  assert.deepEqual(verifyChange({ base, head: selfDone, actor: 'nathan-gh' }), []);
  const retitled = after((db) => { db.missions[0].title = '바꿈'; });
  assert.match(verifyChange({ base, head: retitled, actor: 'nathan-gh' })[0], /수정\(title\)/);
  const deleted = after((db) => { db.missions = []; });
  assert.match(verifyChange({ base, head: deleted, actor: 'newcode135-prog' })[0], /삭제\(대표관리자만\)/);
  assert.deepEqual(verifyChange({ base, head: deleted, actor: 'darrenpual' }), []);
  const promoted = { db: base.db, members: M.map((m) => (m.id === 'nathan' ? { ...m, role: 'owner' } : m)) };
  assert.match(verifyChange({ base, head: promoted, actor: 'nathan-gh' })[0], /팀원 명부/);
  assert.deepEqual(verifyChange({ base, head: promoted, actor: 'nathan-gh', repoAdmin: true }), []);
});

// ---------------- Actions: 발송(runNotify) ----------------

const files = (db, members = M) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members }) });
const CHATS = { TELEGRAM_CHAT_ID_CHANGMIN: '1001', TELEGRAM_CHAT_ID_MINHO: '1002', TELEGRAM_CHAT_ID_YURI: '1003', TELEGRAM_CHAT_ID_NATHAN: '1004', TELEGRAM_CHAT_ID_LUCAS: '1005' };
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_REPOSITORY_OWNER: 'newcode135-prog', ...CHATS };
const ghOf = (pushes) => ({ pushes: async () => new Map(Object.entries(pushes)), isRepoAdmin: async (l) => l === 'newcode135-prog' });
const newLedger = (verifiedSha = null) => ({ verifiedSha, owner: 'changmin', members: {}, alerts: [], flagged: [] });
const pushEnv = (git, before, after, actor, extra = {}) => ({ ...ENV, EVENT_NAME: 'push', BEFORE_SHA: before, AFTER_SHA: after, ACTOR: actor, ...extra });
const statuses = (r) => Object.fromEntries(r.results.map((x) => [x.member, x.status]));

// 창민이 민호 미션 3개를 등록한 push
function minhoSetup() {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  setMissions(db1, '민호', list3, 'changmin', M, T);
  const c1 = git.add(files(db1));
  return { git, c0, c1, db1, runs: { [c1]: 'darrenpual' } };
}

test('Actions 시나리오 4·13: 민호 미션이 main 에 반영되면 민호 chat id 로만, 민호 미션만 보낸다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  const r = await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(statuses(r), { minho: 'sent' });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ['1002']);
  assert.equal(tg.sent[0].text, renderTelegram(M[1], db1));
  assert.equal(ledger.verifiedSha, c1);
  assert.equal(ledger.members.minho.sentHash, hashText(tg.sent[0].text));
  // 다음 push: 유리만 바뀜 → 유리에게만
  const db2 = clone(db1);
  setMissions(db2, '유리', parseMissionList('1. 유리 업무'), 'changmin', M, T);
  const c2 = git.add(files(db2));
  const r2 = await runNotify({ env: pushEnv(git, c1, c2, 'darrenpual'), git, gh: ghOf({ ...runs, [c2]: 'darrenpual' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(statuses(r2), { yuri: 'sent' });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ['1002', '1003']);
  assert.match(tg.sent[1].text, /유리님의 미션[\s\S]*유리 업무/);
  assert.ok(!tg.sent[1].text.includes('로그인 UI'), '유리 메시지에 민호 미션이 섞이지 않는다');
});

test('Actions 시나리오 8: 변경 없이 다시 실행하면 보내지 않는다(재실행·10분 정기 검사·같은 내용 수동 요청), force 는 다시 보냄', async () => {
  const { git, c0, c1, runs } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  const opts = { git, gh: ghOf(runs), send: tg.send, ledger, now: () => T };
  await runNotify({ ...opts, env: pushEnv(git, c0, c1, 'darrenpual') });
  const rerun = await runNotify({ ...opts, env: pushEnv(git, c0, c1, 'darrenpual') });
  assert.deepEqual(rerun.results, []);
  const sched = await runNotify({ ...opts, env: { ...ENV, EVENT_NAME: 'schedule' } });
  assert.deepEqual(sched.results, []);
  const checkin = await runNotify({ ...opts, env: { ...ENV, EVENT_NAME: 'workflow_dispatch', INPUT_MEMBER: '민호', INPUT_FORCE: 'false' } });
  assert.deepEqual(statuses(checkin), { minho: 'already-sent' });
  assert.equal(tg.sent.length, 1);
  const forced = await runNotify({ ...opts, env: { ...ENV, EVENT_NAME: 'workflow_dispatch', INPUT_MEMBER: 'minho', INPUT_FORCE: 'true' } });
  assert.deepEqual(statuses(forced), { minho: 'sent' });
  assert.equal(tg.sent.length, 2);
});

test('Actions 시나리오 11: 미연결 팀원은 보류만 하고 다른 팀원 알림은 막지 않는다 → 연결되면 정기 검사에서 발송', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  setMissions(db1, '민호', list3, 'changmin', M, T);
  setMissions(db1, '루카스', parseMissionList('1. 루카스 업무'), 'changmin', M, T);
  const c1 = git.add(files(db1));
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  const { TELEGRAM_CHAT_ID_LUCAS, ...noLucas } = ENV;
  const r = await runNotify({ env: { ...noLucas, EVENT_NAME: 'push', BEFORE_SHA: c0, AFTER_SHA: c1, ACTOR: 'darrenpual' }, git, gh: ghOf({ [c1]: 'darrenpual' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(statuses(r), { minho: 'sent', lucas: 'unconnected' });
  assert.equal(ledger.members.lucas.pending, true);
  const later = await runNotify({ env: { ...ENV, TELEGRAM_CHAT_ID_LUCAS, EVENT_NAME: 'schedule' }, git, gh: ghOf({}), send: tg.send, ledger, now: () => T });
  assert.deepEqual(statuses(later), { lucas: 'sent' });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ['1002', '1005']);
  assert.equal(ledger.members.lucas.pending, false);
});

test('Actions: 봇 토큰이 없으면 아무것도 보내지 않고 보류(성공으로 치지 않음)', async () => {
  const { git, c0, c1, runs } = minhoSetup();
  const tg = fakeTelegram();
  const r = await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual', { TELEGRAM_BOT_TOKEN: '' }), git, gh: ghOf(runs), send: tg.send, ledger: newLedger(c0), now: () => T });
  assert.deepEqual(statuses(r), { minho: 'unconfigured' });
  assert.equal(tg.sent.length, 0);
});

test('Actions 시나리오 12: 텔레그램 오류 — 한 명이 실패해도 다른 사람은 발송, 실패는 보류 후 다음 실행에서 재시도', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  setMissions(db1, '민호', list3, 'changmin', M, T);
  setMissions(db1, '유리', parseMissionList('1. 유리 업무'), 'changmin', M, T);
  const c1 = git.add(files(db1));
  const ledger = newLedger(c0);
  const blocked = Object.assign(new Error('텔레그램 sendMessage 실패: Forbidden: bot was blocked by the user'), { code: 403 });
  const bad = fakeTelegram({ fail: { 1003: blocked } });
  const r = await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf({ [c1]: 'darrenpual' }), send: bad.send, ledger, now: () => T });
  assert.deepEqual(statuses(r), { minho: 'sent', yuri: 'failed' });
  assert.equal(r.results.find((x) => x.member === 'yuri').code, 403);
  assert.equal(ledger.members.yuri.pending, true);
  const good = fakeTelegram();
  const retry = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule' }, git, gh: ghOf({}), send: good.send, ledger, now: () => T });
  assert.deepEqual(statuses(retry), { yuri: 'sent' });
  assert.deepEqual(good.sent.map((s) => s.chatId), ['1003']);
});

test('Actions 시나리오 14(모의): sendMessage 응답의 chat id 가 다르면 성공으로 치지 않는다', async () => {
  const { git, c0, c1, runs } = minhoSetup();
  const r = await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: async () => ({ message_id: 1, chat: { id: 999 } }), ledger: newLedger(c0), now: () => T });
  assert.deepEqual(statuses(r), { minho: 'failed' });
});

test('Actions 시나리오 10: 권한 없는 push 는 알리지 않고 실패 표시 + 대표관리자에게 경고(한 번만)', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  db2.missions[0].title = '네이뜬이 몰래 바꿈';
  const c2 = git.add(files(db2));
  const all = { ...runs, [c2]: 'nathan-gh' };
  const r = await runNotify({ env: pushEnv(git, c1, c2, 'nathan-gh'), git, gh: ghOf(all), send: tg.send, ledger, now: () => T });
  assert.equal(r.problems[0].kind, 'unauthorized');
  assert.match(r.problems[0].detail[0], /네이뜬\(nathan-gh\): M-0001 수정\(title\)/);
  assert.deepEqual(statuses(r), { changmin: 'alert' });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ['1002', '1001'], '민호에게는 안 보내고 창민에게 경고만');
  assert.match(tg.sent[1].text, /MIMIC NOTE 경고/);
  const again = await runNotify({ env: pushEnv(git, c1, c2, 'nathan-gh'), git, gh: ghOf(all), send: tg.send, ledger, now: () => T });
  assert.deepEqual(again.results, []);
  assert.equal(tg.sent.length, 2);
});

test('Actions 리뷰 회귀: 권한 없는 변경은 확인된 상태가 되지 않아 수동 요청·보류 재시도에도 나가지 않고, 관리자 이상이 다시 저장해야 반영', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  db2.missions[0].title = 'TAMPERED';
  const c2 = git.add(files(db2));
  const pushes = { ...runs, [c2]: 'nathan-gh' };
  const flagged = await runNotify({ env: pushEnv(git, c1, c2, 'nathan-gh'), git, gh: ghOf(pushes), send: tg.send, ledger, now: () => T });
  assert.deepEqual(flagged.problems.map((p) => [p.kind, p.known]), [['unauthorized', false]]);
  assert.equal(ledger.verifiedSha, c1, '권한 없는 커밋은 확인된 상태가 아니다');
  // 체크인(수동 요청, force)·정기 검사: 확인된 상태(c1)로만 보낸다
  const checkin = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', ACTOR: 'nathan-gh', INPUT_MEMBER: 'minho', INPUT_FORCE: 'true' }, git, gh: ghOf(pushes), send: tg.send, ledger, now: () => T });
  assert.deepEqual(statuses(checkin), { minho: 'sent' });
  assert.ok(!tg.sent.some((s) => s.text.includes('TAMPERED')), '조작된 내용은 어떤 경로로도 나가지 않는다');
  assert.deepEqual(checkin.problems.map((p) => [p.kind, p.known]), [['unauthorized', true]], '같은 문제는 다시 실패로 치지 않음');
  // 팀원 push 가 이어져도 여전히 보류(확인된 상태와 비교)
  const db3 = clone(db2);
  setMissions(db3, '네이뜬', parseMissionList('1. N1'), 'changmin', M, T);
  const c3 = git.add(files(db3));
  const still = await runNotify({ env: pushEnv(git, c2, c3, 'nathan-gh'), git, gh: ghOf({ ...pushes, [c3]: 'nathan-gh' }), send: tg.send, ledger, now: () => T });
  assert.equal(still.problems.at(-1).kind, 'unauthorized');
  assert.equal(ledger.verifiedSha, c1);
  // 대표관리자(창민)가 이어서 저장 → 그 상태를 승인한 것으로 보고 반영
  const db4 = clone(db3);
  setMissions(db4, '유리', parseMissionList('1. 유리 업무'), 'changmin', M, T);
  const c4 = git.add(files(db4));
  const ok = await runNotify({ env: pushEnv(git, c3, c4, 'darrenpual'), git, gh: ghOf({ ...pushes, [c3]: 'nathan-gh', [c4]: 'darrenpual' }), send: tg.send, ledger, now: () => T });
  assert.equal(ledger.verifiedSha, c4);
  assert.deepEqual(Object.keys(statuses(ok)).sort(), ['minho', 'nathan', 'yuri']);
});

test('Actions 리뷰 회귀: 깨진 데이터와 함께 자기 권한을 올린 뒤 고쳐도, 확인된 명부 기준이라 권한 상승이 막힌다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const promoted = M.map((m) => (m.id === 'nathan' ? { ...m, role: 'admin' } : m));
  const db2 = clone(db1);
  db2.missions.push({ id: 'M-0004', assignee: 'minho', title: 'X', status: 'todo', createdBy: 'nathan', createdAt: T });
  db2.nextId = 5;
  const c2 = git.add(files(db2, promoted));
  const r2 = await runNotify({ env: pushEnv(git, c1, c2, 'nathan-gh'), git, gh: ghOf({ ...runs, [c2]: 'nathan-gh' }), send: tg.send, ledger, now: () => T });
  assert.equal(r2.problems[0].kind, 'schema');
  assert.deepEqual(statuses(r2), { changmin: 'alert' }, '깨진 데이터도 대표관리자에게 경고');
  const db3 = clone(db2);
  db3.missions.at(-1).order = 4;
  const c3 = git.add(files(db3, promoted));
  const r3 = await runNotify({ env: pushEnv(git, c2, c3, 'nathan-gh'), git, gh: ghOf({ ...runs, [c2]: 'nathan-gh', [c3]: 'nathan-gh' }), send: tg.send, ledger, now: () => T });
  assert.equal(r3.problems.at(-1).kind, 'unauthorized');
  assert.match(r3.problems.at(-1).detail.join('\n'), /팀원 명부/);
  assert.ok(!tg.sent.some((s) => s.chatId === '1002' && s.text.includes('X')), '민호에게 몰래 넣은 미션이 가지 않는다');
});

test('Actions 리뷰 회귀: [skip ci] push 도 활동 기록으로 그 push 한 사람에게 귀속되어 경고된다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  db2.missions[1].title = 'skip-ci 로 몰래 바꿈';
  const c2 = git.add(files(db2)); // 실행 없음([skip ci]) — 활동 기록에는 남음
  const db3 = clone(db2);
  completeMissions(db3, 'minho', ['1'], { by: 'minho', members: M }, T);
  const c3 = git.add(files(db3));
  const r = await runNotify({ env: pushEnv(git, c2, c3, 'newcode135-prog'), git, gh: ghOf({ ...runs, [c2]: 'nathan-gh', [c3]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(r.problems.map((p) => [p.kind, p.sha, p.actor]), [['unauthorized', c2, 'nathan-gh']]);
  assert.ok(tg.sent.some((s) => s.chatId === '1001' && s.text.includes('MIMIC NOTE 경고')));
});

test('Actions 리뷰 회귀: main 기록이 다시 쓰이면(force push) 저장소 관리자가 실행할 때까지 아무것도 보내지 않는다', async () => {
  const { git, c0, c1, runs } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = { ...newLedger(), verifiedSha: 'f'.repeat(40), members: { minho: { pending: true } } }; // main 에 없는 커밋
  const sched = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule', ACTOR: 'newcode135-prog' }, git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  assert.equal(sched.problems[0].kind, 'history-rewrite');
  assert.equal(sched.halted, true);
  assert.deepEqual(tg.sent.filter((s) => s.chatId !== '1001'), [], '팀원에게는 아무것도 안 보냄(대표관리자 경고만)');
  const byMember = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', ACTOR: 'nathan-gh', INPUT_MEMBER: 'minho' }, git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  assert.equal(byMember.halted, true);
  const byOwner = await runNotify({ env: pushEnv(git, c0, c1, 'newcode135-prog'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  assert.equal(byOwner.halted, false);
  assert.equal(ledger.verifiedSha, c1);
  assert.deepEqual(statuses(byOwner), { minho: 'sent' });
});

test('Actions: 저장소 주인 계정은 명부 변경도 통과, 깨진 데이터는 확인된 상태로만 보내고 경고, 없는 팀원 수동 요청은 실패', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0, M.map((m) => ({ ...m, github: null })))]);
  const c0 = git.head();
  const c1 = git.add(files(db0));
  const ledger = newLedger(c0);
  const ok = await runNotify({ env: pushEnv(git, c0, c1, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'newcode135-prog' }), send: fakeTelegram().send, ledger, now: () => T });
  assert.deepEqual(ok.problems, []);
  const c2 = git.add({ [DB_FILE]: '{ 깨진 json' });
  const tg = fakeTelegram();
  const broken = await runNotify({ env: { ...pushEnv(git, c1, c2, 'darrenpual'), INPUT_MEMBER: 'minho' }, git, gh: ghOf({ [c1]: 'newcode135-prog', [c2]: 'darrenpual' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(broken.problems.map((p) => p.kind), ['schema']);
  assert.deepEqual(statuses(broken), { minho: 'sent', changmin: 'alert' });
  assert.equal(ledger.verifiedSha, c1);
  const g2 = fakeGit([files(db0)]);
  const unknown = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', INPUT_MEMBER: '철수' }, git: g2, gh: ghOf({}), send: tg.send, ledger: newLedger(g2.head()), now: () => T });
  assert.equal(unknown.problems[0].kind, 'unknown-member');
});

test('Actions 2차 리뷰 회귀: 장부가 없으면 저장소 관리자가 "지금 main 그대로" 실행할 때만 시작(처음 배포 포함)', async () => {
  const { git, c0, c1 } = minhoSetup();
  const tg = fakeTelegram();
  // 장부 없음 + 정기 검사·팀원 수동 요청 → 멈춤(경고 받을 대표관리자를 모르면 경고도 안 함)
  const empty1 = { verifiedSha: null, owner: null, members: {}, alerts: [], flagged: [] };
  const sched = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule', ACTOR: 'newcode135-prog' }, git, gh: ghOf({ [c1]: 'darrenpual' }), send: tg.send, ledger: empty1, now: () => T });
  assert.deepEqual([sched.halted, sched.problems[0].kind], [true, 'no-ledger']);
  const member = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', ACTOR: 'nathan-gh', INPUT_MEMBER: 'minho' }, git, gh: ghOf({}), send: tg.send, ledger: empty1, now: () => T });
  assert.equal(member.halted, true);
  assert.equal(empty1.verifiedSha, null);
  assert.equal(tg.sent.length, 0);
  // 저장소 관리자의 push 인데 main 끝이 그 push 가 아니면(그 뒤 누가 또 push) 시작하지 않음
  const stale = await runNotify({ env: pushEnv(git, c0, c0, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'nathan-gh' }), send: tg.send, ledger: empty1, now: () => T });
  assert.equal(stale.halted, true);
  // 저장소 관리자의 push 가 main 끝이면 조용히 시작하고, 그 push 자체는 확인·발송
  const boot = { verifiedSha: null, owner: null, members: {}, alerts: [], flagged: [] };
  const ok = await runNotify({ env: pushEnv(git, c0, c1, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'newcode135-prog' }), send: tg.send, ledger: boot, now: () => T });
  assert.deepEqual([ok.halted, ok.problems], [false, []]);
  assert.deepEqual(statuses(ok), { minho: 'sent' });
  assert.equal(boot.verifiedSha, c1);
  assert.equal(boot.owner, 'changmin');
});

test('Actions 2차 리뷰 회귀: 데이터를 안 건드린 push 는 앞의 미확인 변경을 떠안지도, 승인하지도 않는다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  db2.missions[0].title = 'TAMPERED';
  const c2 = git.add(files(db2));
  const c3 = git.add({ 'README.md': '루카스 문서 수정' });
  const c4 = git.add({ 'mimic-note/uploads/x.md': '창민 업로드' });
  const pushes = { ...runs, [c2]: 'nathan-gh', [c3]: 'lucas-gh', [c4]: 'darrenpual' };
  const r = await runNotify({ env: pushEnv(git, c3, c4, 'darrenpual'), git, gh: ghOf(pushes), send: tg.send, ledger, now: () => T });
  assert.deepEqual(r.problems.map((p) => [p.kind, p.actor]), [['unauthorized', 'nathan-gh']], '루카스를 탓하지 않는다');
  assert.equal(ledger.verifiedSha, c1, '창민의 데이터 아닌 push 로 승인되지 않는다');
  assert.ok(!tg.sent.some((s) => s.text.includes('TAMPERED')));
});

test('Actions 2차 리뷰 회귀: 멈춘 실행의 경고는 지난번에 확인된 대표관리자에게(다시 쓰인 명부를 믿지 않음)', async () => {
  const promoted = M.map((m) => (m.id === 'nathan' ? { ...m, role: 'owner' } : m.id === 'changmin' ? { ...m, role: 'admin' } : m));
  const git = fakeGit([files(empty(), promoted)]);
  const tg = fakeTelegram();
  const ledger = { verifiedSha: 'e'.repeat(40), owner: 'changmin', members: {}, alerts: [], flagged: [] };
  const r = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule' }, git, gh: ghOf({}), send: tg.send, ledger, now: () => T });
  assert.equal(r.halted, true);
  assert.deepEqual(tg.sent.map((s) => s.chatId), ['1001']);
  assert.equal(ledger.verifiedSha, 'e'.repeat(40));
});

test('Actions 2차 리뷰 회귀: 깨진 main 은 처음 시작 기준으로도 저장하지 않는다', async () => {
  const git = fakeGit([files(empty())]);
  const c0 = git.head();
  const c1 = git.add({ [DB_FILE]: '{ 깨진' });
  const boot = { verifiedSha: null, owner: null, members: {}, alerts: [], flagged: [] };
  const r = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', ACTOR: 'newcode135-prog' }, git, gh: ghOf({ [c1]: 'darrenpual' }), send: fakeTelegram().send, ledger: boot, now: () => T });
  assert.ok(r.problems.some((p) => p.kind === 'schema'));
  assert.equal(boot.verifiedSha, null);
  assert.ok(c0);
});

test('2차 리뷰 회귀: 번호 없는 목록의 "미션설정" 머리줄도 버린다', () => {
  assert.deepEqual(parseMissionList('미션설정\n로그인 UI\nAPI 테스트').map((x) => x.title), ['로그인 UI', 'API 테스트']);
});

// ---------------- 텔레그램 API ----------------

test('telegramApi: 429 는 retry_after 만큼 기다려 재시도, 403 은 바로 실패, 네트워크 오류는 재시도, 오류 문구에 토큰 없음', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const replies = [{ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, { ok: true, result: { message_id: 9 } }];
  const fetchFn = async () => ({ status: 200, json: async () => replies.shift() });
  assert.deepEqual(await telegramApi('SECRET:TOKEN', 'sendMessage', {}, { fetchFn, sleep }), { message_id: 9 });
  assert.deepEqual(waits, [3000]);
  let calls = 0;
  const forbidden = async () => { calls += 1; return { status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) }; };
  await assert.rejects(telegramApi('SECRET:TOKEN', 'sendMessage', {}, { fetchFn: forbidden, sleep }), (e) => e.code === 403 && !e.message.includes('SECRET'));
  assert.equal(calls, 1);
  let n = 0;
  const flaky = async () => { n += 1; if (n < 3) throw new Error('getaddrinfo ENOTFOUND api.telegram.org/botSECRET:TOKEN'); return { status: 200, json: async () => ({ ok: true, result: 1 }) }; };
  assert.equal(await telegramApi('SECRET:TOKEN', 'getMe', {}, { fetchFn: flaky, sleep }), 1);
  const down = async () => { throw new Error('botSECRET:TOKEN unreachable'); };
  await assert.rejects(telegramApi('SECRET:TOKEN', 'getMe', {}, { fetchFn: down, sleep }), (e) => e.code === 'network' && !e.message.includes('SECRET'));
});

// ---------------- 팀원 연결(일회용 코드) ----------------

test('연결: 본인 일회용 코드로 /start 해야만 연결 — 코드 없는 /start·재사용·만료·단체방·다른 팀원 계정은 거절', () => {
  const now = Date.parse(T);
  const codeM = makeCode();
  const codeY = makeCode();
  const codeOld = makeCode();
  assert.match(codeM, /^[A-Za-z0-9_-]{16}$/);
  const codes = {
    [codeM]: { member: 'minho', expiresAt: new Date(now + 3600e3).toISOString(), usedAt: null },
    [codeY]: { member: 'yuri', expiresAt: new Date(now + 3600e3).toISOString(), usedAt: null },
    [codeOld]: { member: 'lucas', expiresAt: new Date(now - 1).toISOString(), usedAt: null },
  };
  const chatOwners = new Map([['77', 'changmin']]);
  const msg = (chatId, text, type = 'private') => ({ message: { chat: { id: chatId, type }, from: { first_name: '민호', username: 'mh' }, text } });
  const r = processUpdates([
    msg(10, '/start'), // 코드 없음
    msg(11, `/start ${codeM}`, 'group'), // 단체방
    msg(12, `/start ${codeM}`), // 정상
    msg(13, `/start ${codeM}`), // 재사용
    msg(14, `/start ${codeOld}`), // 만료
    msg(77, `/start ${codeY}`), // 이미 창민으로 연결된 계정
    msg(15, '안녕'), // 무시
  ], { codes, chatOwners, now });
  assert.deepEqual(r.links, [{ member: 'minho', chatId: '12', who: '민호 @mh' }]);
  const expect = [['10', /본인 연결 링크로/], ['11', /개인 대화에서만/], ['13', /이미 사용된/], ['14', /만료된/], ['77', /이미 다른 팀원으로/]];
  assert.equal(r.replies.length, expect.length);
  expect.forEach(([chatId, re], i) => {
    assert.equal(r.replies[i].chatId, chatId);
    assert.match(r.replies[i].text, re);
  });
  assert.ok(codes[codeM].usedAt);
  assert.equal(codes[codeY].usedAt, null);
  assert.equal(secretName('nathan'), 'TELEGRAM_CHAT_ID_NATHAN');
});

test('setEnvVar: 그 줄만 바꾸거나 붙이고 다른 줄은 그대로', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-env-')), '.env');
  fs.writeFileSync(f, 'A=1\r\nTELEGRAM_BOT_TOKEN=old\n\n');
  setEnvVar(f, 'TELEGRAM_BOT_TOKEN', 'new');
  setEnvVar(f, 'TELEGRAM_CHAT_ID_MINHO', '5');
  assert.equal(fs.readFileSync(f, 'utf8'), 'A=1\nTELEGRAM_BOT_TOKEN=new\nTELEGRAM_CHAT_ID_MINHO=5\n');
});

// ---------------- Claude Code 가 결과를 확인하는 부분 ----------------

test('waitForNotify: 그 커밋을 실제로 처리한 실행(MIMIC_COVERS)의 결과를 읽는다 — 취소·앞선 실행 처리·로그 실패', async () => {
  const runs = [
    { id: 1, event: 'push', head_sha: 'aaa', status: 'completed', conclusion: 'success', html_url: 'u1' },
    { id: 2, event: 'push', head_sha: 'abc', status: 'completed', conclusion: 'cancelled', html_url: 'u2' },
    { id: 3, event: 'schedule', status: 'in_progress', html_url: 'u3' },
  ];
  const logs = {
    1: 'x\ty\tz MIMIC_COVERS ["aaa"]\nx\ty\tz MIMIC_RESULT {"member":"yuri","status":"sent","messageId":1}',
    3: 'x\ty\tz MIMIC_COVERS ["abc"]\nx\ty\tz MIMIC_RESULT {"member":"minho","status":"sent","messageId":3}\nx\ty\tz MIMIC_PROBLEM {"kind":"unauthorized","known":true,"detail":["네이뜬: M-0001 수정"]}\nnoise',
  };
  const github = {
    runs: (q) => runs.filter((r) => !q.includes('head_sha=') || q.includes(`head_sha=${r.head_sha}`)),
    run: (id) => { const r = runs.find((x) => x.id === id); r.status = 'completed'; r.conclusion ||= 'success'; return r; },
    log: (id) => { if (!logs[id]) throw new Error('log not ready'); return logs[id]; },
  };
  const r = await waitForNotify(github, { commit: 'abc', sleep: noSleep });
  assert.equal(r.run.id, 3);
  assert.equal(r.coveredElsewhere, true);
  assert.deepEqual(r.results, [{ member: 'minho', status: 'sent', messageId: 3 }]);
  const text = formatNotify(r, M);
  assert.match(text, /민호: ✅ 발송 성공[\s\S]*권한 없는 변경 — 발송 보류\(아직 해결 안 됨\): 네이뜬: M-0001 수정[\s\S]*실행 기록: u3/);
  // 앞선 실행이 이미 처리한 커밋: 자기 실행엔 COVERS 가 없고 앞 실행에 있음
  runs.push({ id: 4, event: 'push', head_sha: 'bbb', status: 'completed', conclusion: 'success', html_url: 'u4' });
  logs[4] = 'x\ty\tz MIMIC_COVERS []';
  logs[1] = 'x\ty\tz MIMIC_COVERS ["aaa","bbb"]\nx\ty\tz MIMIC_RESULT {"member":"yuri","status":"sent","messageId":1}';
  const early = await waitForNotify(github, { commit: 'bbb', sleep: noSleep });
  assert.equal(early.run.id, 1);
  // 로그를 못 읽으면 "보낼 대상 없음"이라고 하지 않는다
  runs.push({ id: 5, event: 'push', head_sha: 'ccc', status: 'completed', conclusion: 'success', html_url: 'u5' });
  const noLog = await waitForNotify(github, { commit: 'ccc', sleep: noSleep });
  assert.match(formatNotify(noLog, M), /결과 로그를 읽지 못했습니다/);
  assert.doesNotMatch(formatNotify(noLog, M), /보낼 대상 없음/);
  // 수동 요청 실행이 취소되면 다른 실행 결과를 빌려 오지 않는다
  runs.push({ id: 6, event: 'workflow_dispatch', status: 'completed', conclusion: 'cancelled', html_url: 'u6' });
  const dispatchRuns = { ...github, runs: (q) => runs.filter((x) => !q.includes('workflow_dispatch') || x.event === 'workflow_dispatch') };
  assert.equal((await waitForNotify(dispatchRuns, { afterRunId: 5, actor: 'newcode135-prog', sleep: noSleep })).status, 'cancelled');
  assert.deepEqual(parseResults('no results'), []);
  let t = 0;
  const none = await waitForNotify({ runs: () => [] }, { commit: 'zzz', sleep: noSleep, timeoutMs: 10, now: () => (t += 20) });
  assert.equal(none.status, 'not-found');
});

test('리뷰 회귀: 미션완료 번호는 처음 읽은 목록의 ID 로 고정 — 충돌 후 다시 시도해도 엉뚱한 미션을 끝내지 않는다', async () => {
  const dir = tempNote();
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  let once = true;
  const github = fakeGithub({
    dir,
    login: 'newcode135-prog',
    db,
    beforeWrite(gh) {
      if (!once) return;
      once = false; // 그사이 누가 민호 1번을 끝냄 → 번호가 당겨짐
      const cur = JSON.parse(gh.store.get(DB_FILE).text);
      completeMissions(cur, 'minho', ['1'], {}, T);
      gh.put(DB_FILE, JSON.stringify(cur));
    },
  });
  const out = await run(['done', '민호', '2'], { dir, github, wait: false });
  assert.match(out, /완료: \[M-0002\] 파일 다운로드 API 테스트/);
  const after = JSON.parse(github.store.get(DB_FILE).text);
  assert.deepEqual(openMissions(after, 'minho').map((m) => m.id), ['M-0003'], 'M-0003(모바일 화면 검수)은 그대로');
});

test('리뷰 회귀: 목록 파서 — 들여쓴 하위 항목은 설명, "1.5배" 는 번호가 아님, 제목 끝의 "미션 추가" 는 버리지 않음', () => {
  assert.deepEqual(parseMissionList('민호 미션설정\n1. 로그인 UI\n   - 버튼 색\n   - 폰트\n2. 성능\n1.5배 빠르게\n3. 관리자 페이지 미션 추가'), [
    { title: '로그인 UI', detail: '- 버튼 색\n- 폰트' },
    { title: '성능', detail: '1.5배 빠르게' },
    { title: '관리자 페이지 미션 추가', detail: '' },
  ]);
});

test('리뷰 회귀: 미션설정의 입력 순서가 후순위 표시보다 우선', () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  setLowPriority(db, 'minho', '1', 'changmin', M);
  assert.equal(titles(db, 'minho')[2], '로그인 UI 개발');
  setMissions(db, '민호', list3, 'changmin', M, T);
  assert.deepEqual(titles(db, 'minho'), ['로그인 UI 개발', '파일 다운로드 API 테스트', '모바일 화면 검수']);
});

test('리뷰 회귀: /start __proto__ 같은 입력은 연결 코드로 취급하지 않는다(멈춤·오염 없음)', () => {
  const codes = Object.create(null);
  const r = processUpdates([{ message: { chat: { id: 9, type: 'private' }, text: '/start __proto__' } }, { message: { chat: { id: 9, type: 'private' }, text: '/start constructor' } }], { codes, chatOwners: new Map(), now: Date.parse(T) });
  assert.deepEqual(r.links, []);
  assert.equal(r.replies.length, 2);
  assert.equal({}.usedAt, undefined);
});

test('체크인 텔레그램: 실행이 겹쳐 취소되면 한 번 더 요청한다', async () => {
  const dir = tempNote();
  const github = fakeGithub({ dir, results: [{ member: 'minho', status: 'sent', messageId: 1 }] });
  const orig = github.dispatch;
  let n = 0;
  github.dispatch = (member, force) => { orig(member, force); if (n++ === 0) github.runs('').at(-1).conclusion = 'cancelled'; };
  const out = await telegramViaActions(M[1], { github, sleep: noSleep });
  assert.equal(github.dispatched.length, 2);
  assert.match(out, /민호: ✅ 발송 성공/);
});

test('체크인 텔레그램: Actions 에 요청하고 실제 결과를 보여 준다(같은 내용이면 Actions 가 건너뜀), 쓰기 권한 없으면 건너뜀', async () => {
  const dir = tempNote();
  const github = fakeGithub({ dir, results: [{ member: 'minho', status: 'already-sent' }] });
  const out = await telegramViaActions(M[1], { github, sleep: noSleep });
  assert.deepEqual(github.dispatched, [{ member: 'minho', force: false }]);
  assert.match(out, /같은 내용을 이미 보냈음 — 중복 발송 안 함/);
  const ro = fakeGithub({ dir, login: '250909bs-svg', push: false });
  assert.match(await telegramViaActions(M[1], { github: ro }), /쓰기 권한이 없어/);
  assert.deepEqual(ro.dispatched, []);
});

// ---------------- 워크플로 설정 ----------------

test('워크플로: main push(미션 DB)·10분 정기·수동 재전송, pull_request 없음, 최소 권한, 팀원마다 chat id 비밀값', () => {
  const y = fs.readFileSync(path.join(NOTE_DIR, '..', '.github', 'workflows', 'mimic-checkin.yml'), 'utf8').replace(/\r\n/g, '\n').replace(/^\s*#.*\n/gm, '');
  assert.match(y, /push:\n\s+branches: \[main\]\n\s+paths:\n\s+- mimic-note\/data\/missions\.json\n\s+- mimic-note\/data\/members\.json/);
  assert.match(y, /cron: '\*\/10 \* \* \* \*'/);
  assert.match(y, /workflow_dispatch:[\s\S]*member:[\s\S]*force:/);
  assert.doesNotMatch(y, /pull_request/);
  assert.match(y, /permissions:\n {2}contents: read\n {2}actions: read\n/);
  assert.match(y, /concurrency:\n {2}group: mimic-note-notify\n {2}cancel-in-progress: false/);
  assert.match(y, /if: github\.ref == 'refs\/heads\/main'/);
  for (const m of loadMembers()) {
    const k = `TELEGRAM_CHAT_ID_${m.id.toUpperCase()}`;
    assert.ok(y.includes(`${k}: \${{ secrets.${k} }}`), `${k} 비밀값이 워크플로에 연결되어야 한다`);
  }
});

// ---------------- 실제 텔레그램(선택) ----------------
// 자동 테스트는 위의 가짜 텔레그램으로만 돈다. 실제 전송은 아래 두 값을 줄 때만 시험한다(토큰은 화면에 출력하지 않음).
const REAL = process.env.MIMIC_TELEGRAM_TEST_TOKEN && process.env.MIMIC_TELEGRAM_TEST_CHAT_ID;
test('실제 텔레그램 sendMessage 응답 확인 (MIMIC_TELEGRAM_TEST_TOKEN·MIMIC_TELEGRAM_TEST_CHAT_ID 가 있을 때만)', { skip: REAL ? false : '실제 봇 토큰 없음 — 모의 테스트만 실행' }, async () => {
  const db = empty();
  setMissions(db, '민호', list3, 'changmin', M, T);
  const r = await telegramApi(process.env.MIMIC_TELEGRAM_TEST_TOKEN, 'sendMessage', { chat_id: process.env.MIMIC_TELEGRAM_TEST_CHAT_ID, text: renderTelegram(M[1], db), parse_mode: 'HTML' });
  assert.ok(r.message_id);
  assert.equal(String(r.chat.id), String(process.env.MIMIC_TELEGRAM_TEST_CHAT_ID));
});

// ---------------- 완료 알림 ----------------

const rows = (r) => r.results.map((x) => [x.member, x.kind || 'list', x.status]);

test('완료 알림: 담당자에게 "✅ 방금 완료" + 미션을 준 사람에게 완료 알림, 중복 판단은 상태 기준', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup(); // 창민이 준 민호 미션 3개
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['2'], { by: 'minho', members: M }, T);
  const c2 = git.add(files(db2));
  const r = await runNotify({ env: pushEnv(git, c1, c2, 'newcode135-prog'), git, gh: ghOf({ ...runs, [c2]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rows(r), [['minho', 'list', 'sent'], ['changmin', 'done-notice', 'sent']]);
  const [toMinho, toChangmin] = tg.sent.slice(-2);
  assert.equal(toMinho.chatId, '1002');
  assert.match(toMinho.text, /^🎯 <b>MIMIC NOTE<\/b>\n\n✅ 방금 완료: 파일 다운로드 API 테스트\n\n👤 <b>민호님의 미션<\/b>/);
  assert.match(toMinho.text, /📊 진행률 1\/3\n📌 남은 미션 2개$/);
  assert.equal(toChangmin.chatId, '1001');
  assert.equal(toChangmin.text, renderDoneNotice(M[1], ['파일 다운로드 API 테스트'], db2));
  assert.match(toChangmin.text, /민호님이 미션을 완료했어요\n• 파일 다운로드 API 테스트\n\n📊 민호님 진행률 1\/3 · 남은 미션 2개/);
  const checkin = await runNotify({ env: { ...ENV, EVENT_NAME: 'workflow_dispatch', INPUT_MEMBER: 'minho' }, git, gh: ghOf({}), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rows(checkin), [['minho', 'list', 'already-sent']], '방금 완료 줄 때문에 같은 목록을 다시 보내지 않는다');
  const rerun = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule' }, git, gh: ghOf({}), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rerun.results, [], '완료 알림도 한 번만');
  assert.match(formatNotify({ status: 'done', run: { conclusion: 'success', html_url: 'u' }, results: r.results, problems: [] }, M), /창민\(완료 알림 — 민호님\): ✅ 발송 성공/);
});

test('완료 알림: 스스로 만든 미션은 준 사람 알림 없음, 미션을 준 사람이 미연결이면 표시만 하고 버림', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  setMissions(db1, '민호', list3, 'minho', M, T);
  const c1 = git.add(files(db1));
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['1'], { by: 'minho', members: M }, T);
  const c2 = git.add(files(db2));
  const tg = fakeTelegram();
  const r = await runNotify({ env: pushEnv(git, c1, c2, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'newcode135-prog', [c2]: 'newcode135-prog' }), send: tg.send, ledger: newLedger(c0), now: () => T });
  assert.deepEqual(rows(r), [['minho', 'list', 'sent']]);
  assert.match(tg.sent[0].text, /✅ 방금 완료: 로그인 UI 개발/);

  const s = minhoSetup();
  const { TELEGRAM_CHAT_ID_CHANGMIN, ...noOwner } = ENV;
  const ledger = newLedger(s.c0);
  const tg2 = fakeTelegram();
  await runNotify({ env: { ...noOwner, EVENT_NAME: 'push', BEFORE_SHA: s.c0, AFTER_SHA: s.c1, ACTOR: 'darrenpual' }, git: s.git, gh: ghOf(s.runs), send: tg2.send, ledger, now: () => T });
  const e2 = clone(s.db1);
  completeMissions(e2, 'minho', ['1'], { by: 'minho', members: M }, T);
  const d2 = s.git.add(files(e2));
  const r2 = await runNotify({ env: { ...noOwner, EVENT_NAME: 'push', BEFORE_SHA: s.c1, AFTER_SHA: d2, ACTOR: 'newcode135-prog' }, git: s.git, gh: ghOf({ ...s.runs, [d2]: 'newcode135-prog' }), send: tg2.send, ledger, now: () => T });
  assert.deepEqual(rows(r2), [['minho', 'list', 'sent'], ['changmin', 'done-notice', 'unconnected']]);
  assert.deepEqual(ledger.notices, []);
});

test('완료 알림: 발송이 실패하면 남겨 두었다가 다음 실행에서 다시, 미연결 담당자는 연결 뒤 "방금 완료" 와 함께', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const ledger = newLedger(c0);
  const { TELEGRAM_CHAT_ID_MINHO, ...noMinho } = ENV;
  const down = Object.assign(new Error('텔레그램 sendMessage 실패: Internal Server Error'), { code: 500 });
  const flaky = fakeTelegram({ fail: { 1001: down } });
  await runNotify({ env: { ...noMinho, EVENT_NAME: 'push', BEFORE_SHA: c0, AFTER_SHA: c1, ACTOR: 'darrenpual' }, git, gh: ghOf(runs), send: flaky.send, ledger, now: () => T });
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['3'], { by: 'minho', members: M }, T);
  const c2 = git.add(files(db2));
  const r = await runNotify({ env: { ...noMinho, EVENT_NAME: 'push', BEFORE_SHA: c1, AFTER_SHA: c2, ACTOR: 'newcode135-prog' }, git, gh: ghOf({ ...runs, [c2]: 'newcode135-prog' }), send: flaky.send, ledger, now: () => T });
  assert.deepEqual(rows(r), [['minho', 'list', 'unconnected'], ['changmin', 'done-notice', 'failed']]);
  assert.equal(ledger.notices.length, 1);
  assert.deepEqual(ledger.members.minho.justDone, [{ id: 'M-0003', title: '모바일 화면 검수' }]);
  const ok = fakeTelegram();
  const later = await runNotify({ env: { ...ENV, EVENT_NAME: 'schedule' }, git, gh: ghOf({}), send: ok.send, ledger, now: () => T });
  assert.deepEqual(rows(later), [['minho', 'list', 'sent'], ['changmin', 'done-notice', 'sent']]);
  assert.match(ok.sent[0].text, /✅ 방금 완료: 모바일 화면 검수/);
  assert.deepEqual(ledger.notices, []);
  assert.equal(ledger.members.minho.justDone, undefined);
});

test('완료 알림 리뷰 회귀: 완료했다가 되돌린 미션은 알리지 않고, 두 번 완료해도 한 번만 적는다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['1'], { by: 'minho', members: M }, T);
  const c2 = git.add(files(db2));
  const db3 = clone(db2);
  Object.assign(db3.missions.find((m) => m.id === 'M-0001'), { status: 'todo', doneAt: null, doneBy: undefined });
  const c3 = git.add(files(db3)); // 창민이 되돌림
  const p = { ...runs, [c2]: 'newcode135-prog', [c3]: 'darrenpual' };
  const reopened = await runNotify({ env: pushEnv(git, c2, c3, 'darrenpual'), git, gh: ghOf(p), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rows(reopened), [['minho', 'list', 'already-sent']], '되돌린 미션의 완료 알림·방금 완료 없음');
  const db4 = clone(db3);
  completeMissions(db4, 'minho', ['1'], { by: 'minho', members: M }, T);
  const c4 = git.add(files(db4));
  const db5 = clone(db4);
  Object.assign(db5.missions.find((m) => m.id === 'M-0001'), { status: 'todo', doneAt: null, doneBy: undefined });
  const c5 = git.add(files(db5));
  const db6 = clone(db5);
  completeMissions(db6, 'minho', ['1'], { by: 'minho', members: M }, T);
  const c6 = git.add(files(db6));
  const twice = await runNotify({ env: pushEnv(git, c5, c6, 'newcode135-prog'), git, gh: ghOf({ ...p, [c4]: 'newcode135-prog', [c5]: 'darrenpual', [c6]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rows(twice), [['minho', 'list', 'sent'], ['changmin', 'done-notice', 'sent']]);
  assert.equal((tg.sent.at(-1).text.match(/• 로그인 UI 개발/g) || []).length, 1);
  assert.equal((tg.sent.at(-2).text.match(/방금 완료: 로그인 UI 개발/g) || []).length, 1);
});

test('완료 알림 리뷰 회귀: 담당자 본인이 만든 미션은 남이 완료 처리해도 따로 알리지 않고, 대신 처리한 사람은 이름을 적는다', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  setMissions(db1, '민호', list3, 'minho', M, T); // 민호가 자기 미션을 만듦
  setMissions(db1, '네이뜬', parseMissionList('1. N1'), 'changmin', M, T); // 창민이 네이뜬에게 줌
  const c1 = git.add(files(db1));
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['1'], { by: 'changmin', members: M }, T); // 창민이 민호 것을 완료 처리
  completeMissions(db2, 'nathan', ['1'], { by: 'yuri', members: M }, T); // 유리가 네이뜬 것을 완료 처리
  const c2 = git.add(files(db2));
  const r = await runNotify({ env: pushEnv(git, c1, c2, 'darrenpual'), git, gh: ghOf({ [c1]: 'newcode135-prog', [c2]: 'darrenpual' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(rows(r).sort(), [['changmin', 'done-notice', 'sent'], ['minho', 'list', 'sent'], ['nathan', 'list', 'sent']]);
  const notice = tg.sent.find((s) => s.chatId === '1001').text;
  assert.match(notice, /네이뜬님이 미션을 완료했어요\n• N1 \(유리님이 완료 처리\)/);
  assert.ok(!tg.sent.some((s) => s.chatId === '1002' && s.text.includes('완료 알림')), '민호에게 자기 자신에 대한 완료 알림을 따로 보내지 않음');
});

test('완료 알림 리뷰 회귀: "방금 완료" 줄 때문에 거절되면 기본 목록으로 다시 보내 막히지 않는다', async () => {
  const { git, c0, c1, runs, db1 } = minhoSetup();
  const ledger = newLedger(c0);
  await runNotify({ env: pushEnv(git, c0, c1, 'darrenpual'), git, gh: ghOf(runs), send: fakeTelegram().send, ledger, now: () => T });
  const db2 = clone(db1);
  completeMissions(db2, 'minho', ['2'], { by: 'minho', members: M }, T);
  const c2 = git.add(files(db2));
  const sent = [];
  const picky = async (token, chatId, text) => {
    if (text.includes('방금 완료')) throw Object.assign(new Error('텔레그램 sendMessage 실패: Bad Request: message is too long'), { code: 400 });
    sent.push({ chatId, text });
    return { message_id: 9, chat: { id: Number(chatId) } };
  };
  const r = await runNotify({ env: pushEnv(git, c1, c2, 'newcode135-prog'), git, gh: ghOf({ ...runs, [c2]: 'newcode135-prog' }), send: picky, ledger, now: () => T });
  assert.deepEqual(rows(r), [['minho', 'list', 'sent'], ['changmin', 'done-notice', 'sent']]);
  assert.match(sent.find((s) => s.chatId === '1002').text, /📊 진행률 1\/3/);
  assert.equal(ledger.members.minho.justDone, undefined);
  assert.equal(ledger.members.minho.pending, false);
});
