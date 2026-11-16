// ✏️ 수정·취소(관리자): 남은 미션 하나를 고치거나 취소(지우지 않고 보관), 권한·화면·문구·Actions 알림.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMissions, requestMissions, openMissions, cancelMission, editMission, validateDb, decide, decideCallback, boardKeyboard, manageText, manageKeyboard,
  editPrompt, confirmText, resultText, changeNotice, sentText, ACTIONS,
} from '../mimic-note/lib.mjs';
import { applied } from '../mimic-note/app.mjs';
import { runNotify } from '../mimic-note/notify.mjs';
import { fakeGit, fakeTelegram, DB_FILE, MEMBERS_FILE } from './mimic-note-fakes.js';

const T = '2026-11-13T05:00:00.000Z'; // 금요일 오후 2시(한국) — 아침 요약 시간대 밖
const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const [CHANGMIN, MINHO, YURI, NATHAN] = M;
const clone = (x) => JSON.parse(JSON.stringify(x));
const it = (...titles) => titles.map((title) => ({ title, detail: '' }));
const datas = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data);

// 네이뜬: 창민이 준 미션 3개(2번은 설명 있음)
function sample() {
  const db = { nextId: 1, missions: [] };
  addMissions(db, 'nathan', [{ title: '개발 환경 설치', detail: '' }, { title: '로그인 화면', detail: '피그마 시안대로' }, { title: '회의록 정리', detail: '' }], 'changmin', M, {}, T);
  return db;
}

test('취소: 관리자만, 남은 미션 하나를 지우지 않고 보관(예전 코드도 읽는 상태) — 목록·진행률에서 빠지고 다시 취소·완료 안 됨', () => {
  const db = sample();
  const [m1, m2] = openMissions(db, 'nathan');
  assert.throws(() => cancelMission(db, 'nathan', m1.id, 'nathan', M, T), /관리자가 아니라 미션을 취소할 수 없습니다/, '본인 미션이어도 팀원은 취소 못 함');
  assert.throws(() => cancelMission(db, 'minho', m1.id, 'minho', M, T), /이미 완료·취소됐거나 바뀐 미션/, '다른 사람 미션 ID 로는 안 됨');
  const r = cancelMission(db, 'nathan', m1.id, 'yuri', M, T);
  assert.deepEqual([r.changed, r.mission.status, r.mission.cancelledBy, r.mission.cancelledAt], [true, 'replaced', 'yuri', T]);
  assert.deepEqual(openMissions(db, 'nathan').map((m) => m.title), ['로그인 화면', '회의록 정리'], '남은 미션 번호가 당겨짐');
  assert.ok(db.missions.some((m) => m.id === m1.id), '기록은 남김');
  assert.deepEqual(validateDb(db, M), []);
  assert.throws(() => cancelMission(db, 'nathan', m1.id, 'minho', M, T), /이미 완료·취소/);
  assert.throws(() => cancelMission(db, 'nathan', 'M-9999', 'minho', M, T), /이미 완료·취소/);
  const req = requestMissions(db, 'minho', it('요청 건'), 'nathan', M, T).added[0];
  assert.throws(() => cancelMission(db, 'minho', req.id, 'minho', M, T), /이미 완료·취소/, '대기 요청은 취소가 아니라 거절');
  assert.equal(m2.status, 'todo');
});

test('수정: 관리자만, ID·순서는 그대로, 제목만 보내면 설명 유지, 같은 제목·빈 제목 거절, 그대로면 변경 없음', () => {
  const db = sample();
  const [m1, m2, m3] = openMissions(db, 'nathan');
  assert.throws(() => editMission(db, 'nathan', m2.id, { title: '새 제목' }, 'nathan', M, T), /관리자가 아니라 미션을 고칠/);
  const r = editMission(db, 'nathan', m2.id, { title: '로그인 화면 (모바일 포함)', detail: '' }, 'minho', M, T);
  assert.deepEqual([r.changed, r.before, r.mission.title, r.mission.detail, r.mission.editedBy, r.mission.editedAt], [true, { title: '로그인 화면', detail: '피그마 시안대로' }, '로그인 화면 (모바일 포함)', '피그마 시안대로', 'minho', T]);
  assert.deepEqual(openMissions(db, 'nathan').map((m) => m.id), [m1.id, m2.id, m3.id], '순서 그대로');
  assert.equal(editMission(db, 'nathan', m2.id, { title: '로그인 화면 (모바일 포함)', detail: '새 설명' }, 'minho', M, T).mission.detail, '새 설명', '설명을 적으면 바뀜');
  assert.throws(() => editMission(db, 'nathan', m1.id, { title: '  회의록   정리 ' }, 'minho', M, T), /같은 제목의 미션이 이미 있어요/);
  assert.throws(() => editMission(db, 'nathan', m1.id, { title: '  ' }, 'minho', M, T), /비어 있습니다/);
  const same = editMission(db, 'nathan', m3.id, { title: '회의록 정리', detail: '' }, 'minho', M, T);
  assert.deepEqual([same.changed, 'editedBy' in same.mission], [false, false], '그대로면 변경 없음(커밋·알림 없음)');
  assert.equal(editMission(db, 'nathan', m3.id, { title: '회의록 정리 ' }, 'minho', M, T).changed, false, '앞뒤 공백만 다르면 그대로');
  assert.equal(editMission(db, 'nathan', m1.id, { title: '개발 환경 설치 (맥)' }, 'minho', M, T).changed, true);
  cancelMission(db, 'nathan', m1.id, 'minho', M, T);
  assert.throws(() => editMission(db, 'nathan', m1.id, { title: 'X' }, 'minho', M, T), /이미 완료·취소/, '취소한 미션은 못 고침');
  assert.deepEqual(validateDb(db, M), []);
});

test('화면: 관리자 이름봇에만 [✏️ 수정·취소](남은 미션이 있을 때), 누르면 미션마다 [✏️ n][🗑 n] + [◀ 돌아가기]', () => {
  const db = sample();
  const ids = openMissions(db, 'nathan').map((m) => m.id);
  assert.deepEqual(datas(boardKeyboard(MINHO, NATHAN, db)), ['s:nathan', 'm:nathan', 'v:nathan']);
  assert.equal(boardKeyboard(MINHO, NATHAN, db).inline_keyboard[1][0].text, '✏️ 수정·취소');
  assert.deepEqual(datas(boardKeyboard(NATHAN, NATHAN, db)), [...ids.map((id) => `c:${id}`), 'v:nathan'], '팀원은 본인 것도 수정·취소 버튼 없음');
  assert.deepEqual(datas(boardKeyboard(MINHO, YURI, db)), ['s:yuri', 'v:yuri'], '남은 미션이 없으면 버튼 없음');
  const kb = manageKeyboard(NATHAN, db);
  assert.deepEqual(kb.inline_keyboard.map((r) => r.map((b) => `${b.text}=${b.callback_data}`)), [
    [`✏️ 1=u:${ids[0]}`, `🗑 1=d:${ids[0]}`], [`✏️ 2=u:${ids[1]}`, `🗑 2=d:${ids[1]}`], [`✏️ 3=u:${ids[2]}`, `🗑 3=d:${ids[2]}`], ['◀ 돌아가기=v:nathan']]);
  assert.match(manageText(NATHAN, db), /네이뜬님의 미션[\s\S]*1️⃣ 개발 환경 설치[\s\S]*✏️ 번호<\/b>, 취소할 미션은 <b>🗑 번호/);
  assert.match(manageText(NATHAN, db, 'en'), /Nathan's missions[\s\S]*to cancel it\.$/);
  const many = { nextId: 1, missions: [] };
  addMissions(many, 'nathan', Array.from({ length: 12 }, (_, i) => ({ title: `일${i + 1}` })), 'minho', M, {}, T);
  assert.equal(manageKeyboard(NATHAN, many).inline_keyboard.length, 11, '10개 + 돌아가기');
  assert.match(manageText(NATHAN, many), /버튼은 1~10번만/);
  assert.ok(manageKeyboard(NATHAN, many).inline_keyboard.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
});

test('버튼 판단: m:/u:/d: 는 관리자만, 남은 미션만 — 팀원·완료/취소된 미션·없는 미션은 안내만', () => {
  const db = sample();
  const [m1] = openMissions(db, 'nathan');
  const cb = (data, viewer, d = db) => decideCallback(data, { viewer, members: M, db: d });
  assert.deepEqual(cb('m:nathan', MINHO), { kind: 'manage', member: NATHAN });
  assert.deepEqual(cb(`d:${m1.id}`, YURI), { kind: 'confirm-cancel', target: NATHAN, picked: [{ id: m1.id, title: '개발 환경 설치' }] });
  assert.deepEqual([cb(`u:${m1.id}`, CHANGMIN).kind, cb(`u:${m1.id}`, CHANGMIN).mission.id], ['edit-start', m1.id]);
  for (const data of ['m:nathan', `d:${m1.id}`, `u:${m1.id}`]) assert.match(cb(data, NATHAN).text, /관리자만/, data);
  assert.equal(cb('m:nobody', MINHO).kind, 'stale');
  assert.match(cb('d:M-9999', MINHO).text, /없는 미션/);
  const gone = clone(db);
  cancelMission(gone, 'nathan', m1.id, 'minho', M, T);
  assert.match(cb(`d:${m1.id}`, MINHO, gone).text, /이미 완료됐거나 바뀐/);
  assert.match(cb(`u:${m1.id}`, MINHO, gone).text, /이미 완료됐거나 바뀐/);
  assert.match(cb(`u:${m1.id}`, MINHO, gone).text, /새로고침/);
});

test('✏️ 수정 중 보낸 글: 미션 하나면 확인으로, 여러 개·팀원·그사이 바뀐 미션은 안내, "취소"·버튼·/명령은 그대로', () => {
  const db = sample();
  const [m1, m2] = openMissions(db, 'nathan');
  const chatOwners = new Map([['1002', 'minho'], ['1004', 'nathan']]);
  const d = (id, text, edit = m2) => decide({ chat: { id, type: 'private' }, text }, { members: M, chatOwners, compose: { target: NATHAN, edit } });
  const ok = d(1002, '로그인 화면\n모바일 포함');
  assert.deepEqual([ok.kind, ok.action, ok.target.id, ok.items, ok.picked], ['act', 'edit', 'nathan', [{ title: '로그인 화면 모바일 포함', detail: '' }], [{ id: m2.id, title: '로그인 화면' }]]);
  assert.deepEqual(d(1002, '1. 로그인 화면\n   모바일도').items, [{ title: '로그인 화면', detail: '모바일도' }], '번호 하나 + 들여쓴 설명');
  // 리뷰 회귀: 안내문 그대로 — 번호가 없으면 길이·글머리표와 상관없이 글 전체가 제목(설명 그대로), 첫 줄 번호 뒤는 전부 설명
  assert.deepEqual(d(1002, '로그인 화면\n- 버튼 색').items, [{ title: '로그인 화면 - 버튼 색', detail: '' }], '첫 줄을 버리지 않음');
  assert.deepEqual(d(1002, '1. 새 제목\n- a\n- b').items, [{ title: '새 제목', detail: '- a\n- b' }], '번호 뒤 글머리표 줄은 설명');
  assert.deepEqual(d(1002, '1. A\n2. B').items, [{ title: 'A', detail: '2. B' }]);
  assert.match(d(1002, `${'가'.repeat(120)}\n${'나'.repeat(100)}`).error, /제목은 200자/, '200자 넘는 제목은 설명으로 몰래 바꾸지 않고 안내');
  assert.match(d(1002, `1. 제목\n${'설'.repeat(4001)}`).error, /설명은 4000자/);
  assert.equal(d(1002, '취소').kind, 'cancel');
  assert.equal(d(1002, '유리봇').kind, 'board');
  assert.equal(d(1002, '/menu').kind, 'menu');
  assert.match(d(1004, '고친 제목').text, /관리자만/);
  assert.match(d(1002, '고친 제목', null).text, /이미 완료됐거나 바뀐/, '그사이 없어진 미션');
  const done = clone(m1);
  done.status = 'done';
  assert.match(d(1002, '고친 제목', done).text, /이미 완료됐거나 바뀐/);
  assert.match(d(1002, '고친 제목', { ...m2, assignee: 'yuri' }).text, /이미 완료됐거나 바뀐/, '다른 사람 미션');
  const give = decide({ chat: { id: 1002, type: 'private' }, text: '그냥 미션' }, { members: M, chatOwners, compose: { target: NATHAN } });
  assert.equal(give.action, 'add', 'edit 가 없는 쓰기는 예전처럼 미션 주기');
});

test('문구: 확인·결과·알림(받는 사람 언어, 담당자에게는 "내 미션"), 보낸 미션의 취소됨, 저장 재확인(applied)', () => {
  const db = sample();
  const [m1, m2] = openMissions(db, 'nathan');
  const picked = [{ id: m1.id, title: m1.title }];
  assert.equal(confirmText({ action: 'cancel', target: NATHAN }, picked), `🗑 <b>네이뜬</b>님의 이 미션을 취소할까요? (지우지 않고 보관해요)\n• [${m1.id}] 개발 환경 설치`);
  assert.equal(confirmText({ action: 'edit', target: NATHAN, items: [{ title: 'A <b>', detail: '설명' }] }, [{ id: m2.id, title: m2.title }]),
    '✏️ <b>네이뜬</b>님의 미션을 이렇게 고칠까요?\n• 지금: 로그인 화면\n• 새로: A &lt;b&gt;\n<blockquote expandable>설명</blockquote>');
  assert.match(editPrompt(NATHAN, m2, db), /^✏️ <b>네이뜬<\/b>님의 2번 미션을 고쳐요\.\n지금: <code>로그인 화면<\/code>[\s\S]*보낸 글 전체가 새 제목이에요[\s\S]*설명도 바꾸려면 <code>1\. 새 제목<\/code>/);
  assert.match(editPrompt(NATHAN, m2, db, 'zh'), /第 2 个任务/);

  const p = { ids: [m1.id], targetId: 'nathan' };
  assert.equal(applied({ ...p, action: 'cancel' }, db), false);
  const w1 = { result: ACTIONS.cancel.apply(p)(db, M, YURI) };
  assert.equal(applied({ ...p, action: 'cancel' }, db), true, '이미 취소돼 있으면 실패로 덮어쓰지 않음');
  assert.match(resultText('cancel', '네이뜬', w1), /^🗑 네이뜬님의 미션을 취소했어요\n• \[M-0001\] 개발 환경 설치\n\n네이뜬님에게 곧 텔레그램 알림이 가요\.$/);
  assert.equal(changeNotice('cancel', w1.result, YURI, NATHAN, true), '🗑 <b>미션이 취소됐어요</b>\n\n유리님이 내 미션을 취소했어요:\n• 개발 환경 설치');
  assert.equal(changeNotice('cancel', w1.result, YURI, NATHAN, false, 'en'), '🗑 <b>Mission cancelled</b>\n\nYuri cancelled Nathan\'s mission:\n• 개발 환경 설치');
  assert.match(changeNotice('cancel', w1.result, YURI, NATHAN, true, 'zh'), /Yuri 取消了你的任务：/);

  const e = { ids: [m2.id], targetId: 'nathan', items: [{ title: '로그인 화면 v2', detail: '' }] };
  const w2 = { result: ACTIONS.edit.apply(e)(db, M, MINHO) };
  assert.equal(applied({ ...e, action: 'edit' }, db), true);
  assert.equal(applied({ ...e, action: 'edit', items: [{ title: '다른 제목' }] }, db), false);
  // 리뷰 회귀: 설명만 고치다 저장이 실패하면 "이미 저장됨"이 아니라 실패로(제목이 같아도 설명을 비교)
  assert.equal(applied({ ...e, action: 'edit', items: [{ title: '로그인 화면 v2', detail: '아직 저장 안 된 설명' }] }, db), false);
  assert.match(resultText('edit', '네이뜬', w2), /^✏️ 네이뜬님의 미션을 고쳤어요\n• 로그인 화면\n→ 로그인 화면 v2\n\n/);
  assert.equal(changeNotice('edit', w2.result, MINHO, NATHAN, false), '✏️ <b>미션이 바뀌었어요</b>\n\n민호님이 네이뜬님의 미션을 고쳤어요:\n• 로그인 화면\n→ 로그인 화면 v2');
  const w3 = { result: editMission(db, 'nathan', m2.id, { title: '로그인 화면 v2', detail: '새 설명' }, 'minho', M, T) };
  assert.match(changeNotice('edit', w3.result, MINHO, NATHAN, true, 'en'), /Minho edited your mission:\n• 로그인 화면 v2 \(description edited\)$/, '제목이 같으면 설명만 고친 것');

  assert.match(sentText(CHANGMIN, M, db), /🔨 진행 중 2<\/b>[\s\S]*<b>🗑 취소됨 1<\/b>\n• 네이뜬 — 개발 환경 설치$/);
  assert.match(sentText(CHANGMIN, M, db, 'en'), /🗑 Cancelled 1/);
});

test('리뷰 회귀: 확인 화면에 보여 준 제목(was)과 지금 제목이 다르면(다른 관리자가 그사이 고침) 취소·수정하지 않음', () => {
  const db = sample();
  const [m1, m2] = openMissions(db, 'nathan');
  ACTIONS.edit.apply({ targetId: 'nathan', ids: [m2.id], items: [{ title: 'C' }], was: '로그인 화면' })(db, M, YURI); // 유리가 먼저 C 로
  assert.throws(() => ACTIONS.edit.apply({ targetId: 'nathan', ids: [m2.id], items: [{ title: 'B' }], was: '로그인 화면' })(db, M, MINHO), /바뀐 미션/);
  assert.throws(() => ACTIONS.cancel.apply({ targetId: 'nathan', ids: [m2.id], was: '로그인 화면' })(db, M, MINHO), /바뀐 미션/, '보지 못한 제목의 미션은 취소 안 함');
  assert.equal(m2.title, 'C');
  assert.equal(ACTIONS.cancel.apply({ targetId: 'nathan', ids: [m1.id] })(db, M, MINHO).mission.status, 'replaced', 'was 가 없는 예전 확인은 그대로 동작');
});

// ---------------- GitHub Actions(notify): 봇이 저장한 취소·수정 ----------------
const files = (db) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members: M }) });
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_REPOSITORY_OWNER: 'newcode135-prog', TELEGRAM_CHAT_ID_CHANGMIN: '1001', TELEGRAM_CHAT_ID_NATHAN: '1004' };
const ghOf = (pushes) => ({ pushes: async () => new Map(Object.entries(pushes)), isRepoAdmin: async (l) => l === 'newcode135-prog' });
const newLedger = (verifiedSha) => ({ verifiedSha, owner: 'changmin', members: {}, alerts: [], flagged: [] });
const pushEnv = (before, after, actor) => ({ ...ENV, EVENT_NAME: 'push', BEFORE_SHA: before, AFTER_SHA: after, ACTOR: actor });

test('Actions: 관리자의 취소·수정 push 는 담당자에게 바뀐 목록(✅ 버튼도 새 번호로), 팀원이 직접 올린 취소는 권한 없는 변경', async () => {
  const db0 = sample();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const [m1, m2, m3] = openMissions(db0, 'nathan');
  const db1 = clone(db0);
  cancelMission(db1, 'nathan', m1.id, 'yuri', M, T);
  editMission(db1, 'nathan', m2.id, { title: '로그인 화면 v2' }, 'yuri', M, T);
  const c1 = git.add(files(db1));
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  const r = await runNotify({ env: pushEnv(c0, c1, 'emileepark5281-cmd'), git, gh: ghOf({ [c1]: 'emileepark5281-cmd' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual([r.problems, r.verified, r.results.map((x) => [x.member, x.status])], [[], c1, [['nathan', 'sent']]], '유리(관리자 팀원) 계정 push 도 통과');
  const msg = tg.sent.at(-1);
  assert.equal(msg.chatId, '1004');
  assert.match(msg.text, /1️⃣ 로그인 화면 v2[\s\S]*2️⃣ 회의록 정리[\s\S]*📌 남은 미션 2개/);
  assert.ok(!msg.text.includes('개발 환경 설치') && !msg.text.includes('🆕'), '취소한 미션은 안 보이고, 고친 미션을 새 미션이라고 하지 않음');
  assert.deepEqual(datas(msg.extra.reply_markup), [`c:${m2.id}`, `c:${m3.id}`, 'v:nathan']);

  const db2 = clone(db1);
  cancelMission(db2, 'nathan', m3.id, 'minho', M, T); // 규칙상 관리자만 — 팀원이 파일을 직접 고쳐 push 한 경우
  const c2 = git.add(files(db2));
  const r2 = await runNotify({ env: pushEnv(c1, c2, 'nathan-gh'), git, gh: ghOf({ [c2]: 'nathan-gh' }), send: tg.send, ledger, now: () => T });
  assert.equal(r2.problems[0].kind, 'unauthorized');
  assert.match(r2.problems[0].detail.join(' '), /수정\(status, cancelledAt, cancelledBy\) — 팀원은 본인 미션 완료만 가능/);
  assert.equal(r2.verified, c1);
});
