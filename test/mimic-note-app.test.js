// 코어 오브 미믹노트 미션 앱: 이름봇 보기·버튼(✅ 완료·📨 주기/요청·수락/거절·🔄), 요청 규칙(대전제), 알림 버튼.
// 가짜 GitHub·git·텔레그램만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openMissions, pendingRequests, addMissions, setMissions, completeMissions, requestMissions, respondRequest, validateDb, sendMode,
  decide, decideCallback, boardText, boardKeyboard, listKeyboard, teamText, sentText, renderTelegram, requestNotice, respondNotice,
  resultText, ACTIONS, REQUEST_LIMIT, menuText, composePrompt,
} from '../mimic-note/lib.mjs';
import { mutate } from '../mimic-note/mission.mjs';
import { runNotify } from '../mimic-note/notify.mjs';
import { blobSha, withoutMission } from '../mimic-note/bot.mjs';
import { fakeGithub, fakeGit, fakeTelegram, DB_FILE, MEMBERS_FILE } from './mimic-note-fakes.js';

const T = '2026-11-13T00:00:00.000Z';
const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const [CHANGMIN, MINHO, YURI, NATHAN, LUCAS] = M;
const empty = () => ({ nextId: 1, missions: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const it = (...titles) => titles.map((title) => ({ title, detail: '' }));
const datas = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data);

// 민호: 창민이 준 미션 2개 + 네이뜬이 보낸 요청 1개, 네이뜬: 민호가 준 미션 1개
function sample() {
  const db = empty();
  addMissions(db, 'minho', it('로그인 UI', '모바일 검수'), 'changmin', M, {}, T);
  requestMissions(db, 'minho', it('회의록 정리'), 'nathan', M, T);
  addMissions(db, 'nathan', it('개발 환경 설치'), 'minho', M, {}, T);
  return db;
}

// ---------------- 요청 규칙(대전제: 배정은 관리자만) ----------------

test('요청: 팀원 → 관리자만, 대기 요청은 목록·진행률에 안 들어감, 같은 제목·본인·팀원끼리·관리자의 요청은 거절', () => {
  assert.deepEqual([sendMode(MINHO, NATHAN), sendMode(MINHO, MINHO), sendMode(NATHAN, MINHO), sendMode(NATHAN, LUCAS), sendMode(NATHAN, NATHAN)], ['add', 'add', 'request', null, null]);
  const db = sample();
  const req = db.missions.find((m) => m.title === '회의록 정리');
  assert.deepEqual([req.status, req.assignee, req.createdBy, req.doneAt], ['requested', 'minho', 'nathan', null]);
  assert.deepEqual(openMissions(db, 'minho').map((m) => m.title), ['로그인 UI', '모바일 검수'], '요청은 아직 미션이 아님');
  assert.deepEqual(pendingRequests(db, 'minho').map((m) => m.id), [req.id]);
  assert.match(renderTelegram(MINHO, db), /진행률 0\/2/);
  assert.deepEqual(validateDb(db, M), []);
  const again = requestMissions(db, 'minho', it('회의록 정리', '로그인 UI', '새 일'), 'nathan', M, T);
  assert.deepEqual([again.added.map((m) => m.title), again.skipped], [['새 일'], ['회의록 정리', '로그인 UI']], '대기 요청·남은 미션과 같은 제목은 건너뜀');
  assert.throws(() => requestMissions(db, 'lucas', it('A'), 'nathan', M, T), /팀원끼리는/);
  assert.throws(() => requestMissions(db, 'nathan', it('A'), 'nathan', M, T), /본인 미션을 직접/);
  assert.throws(() => requestMissions(db, 'yuri', it('A'), 'minho', M, T), /배정은 관리자만|관리자/, '관리자는 요청이 아니라 바로 줌');
  assert.throws(() => addMissions(db, 'minho', it('몰래 추가'), 'nathan', M), /관리자가 아니라/, '팀원은 여전히 미션을 직접 만들 수 없음');
});

test(`요청: 한 사람당 대기 요청 ${REQUEST_LIMIT}개까지(도배 방지)`, () => {
  const db = empty();
  requestMissions(db, 'minho', Array.from({ length: REQUEST_LIMIT }, (_, i) => ({ title: `일${i}` })), 'nathan', M, T);
  assert.throws(() => requestMissions(db, 'yuri', it('하나 더'), 'nathan', M, T), /10개까지/);
  respondRequest(db, pendingRequests(db, 'minho')[0].id, false, 'minho', M, T);
  assert.equal(requestMissions(db, 'yuri', it('하나 더'), 'nathan', M, T).added.length, 1, '처리되면 다시 보낼 수 있음');
});

test('요청 수락·거절: 수락은 관리자만(목록 맨 뒤로), 거절은 받은 사람·관리자, 두 번 처리 안 됨', () => {
  const db = sample();
  const req = pendingRequests(db, 'minho')[0];
  assert.throws(() => respondRequest(db, req.id, true, 'nathan', M, T), /관리자만/);
  assert.throws(() => respondRequest(db, req.id, false, 'lucas', M, T), /받은 사람이나 관리자만/);
  respondRequest(db, req.id, true, 'minho', M, T);
  assert.deepEqual([req.status, req.acceptedBy, req.acceptedAt], ['todo', 'minho', T]);
  assert.deepEqual(openMissions(db, 'minho').map((m) => m.title), ['로그인 UI', '모바일 검수', '회의록 정리'], '수락한 미션은 맨 뒤');
  assert.throws(() => respondRequest(db, req.id, true, 'minho', M, T), /이미 처리/);
  const r2 = requestMissions(db, 'yuri', it('디자인 검토'), 'lucas', M, T).added[0];
  respondRequest(db, r2.id, false, 'yuri', M, T);
  assert.deepEqual([r2.status, r2.declinedBy], ['declined', 'yuri']);
  assert.deepEqual(openMissions(db, 'yuri'), []);
  assert.deepEqual(validateDb(db, M), []);
  completeMissions(db, 'minho', [req.id], { by: 'minho', members: M }, T);
  assert.equal(req.status, 'done', '수락한 요청은 보통 미션처럼 완료');
});

// ---------------- 봇 판단(글·버튼) ----------------

test('봇 📨 미션 쓰기: 버튼을 누른 뒤 보낸 글은 그 사람에게 줄(관리자)·요청할(팀원) 미션, 이름봇·/start·취소는 그대로', () => {
  const chatOwners = new Map([['1002', 'minho'], ['1004', 'nathan']]);
  const d = (id, text, compose) => decide({ chat: { id, type: 'private' }, text }, { members: M, chatOwners, compose });
  const give = d(1002, '이번 주 보고서\n결제 확인', { target: CHANGMIN });
  assert.deepEqual([give.kind, give.action, give.target.id, give.items.map((x) => x.title)], ['act', 'add', 'changmin', ['이번 주 보고서', '결제 확인']]);
  const ask = d(1004, '1. 리뷰 부탁\n   PR 링크 확인', { target: MINHO });
  assert.deepEqual([ask.action, ask.items], ['request', [{ title: '리뷰 부탁', detail: 'PR 링크 확인' }]]);
  assert.equal(d(1004, '이거 해줘', { target: LUCAS }).kind, 'act-denied', '팀원끼리는 쓰기 중이어도 막힘');
  assert.equal(d(1002, '취소', { target: CHANGMIN }).kind, 'cancel');
  assert.equal(d(1002, '취소').kind, 'menu', '쓰기 중이 아니면 "취소" 는 그냥 글');
  assert.deepEqual([d(1002, '유리봇', { target: CHANGMIN }).kind, d(1002, '/start', { target: CHANGMIN }).kind, d(1002, '📤 보낸 미션', { target: CHANGMIN }).kind], ['board', 'menu', 'sent']);
  assert.equal(d(1002, '/me', { target: CHANGMIN }).kind, 'board');
  assert.equal(d(1002, '/unknown', { target: CHANGMIN }).kind, 'menu', '/명령은 미션 내용으로 보지 않음');
  assert.equal(d(9999, '이거', { target: CHANGMIN }).kind, 'menu', '연결 안 된 대화는 쓰기 상태가 있어도 무시');
});

test('봇 버튼(callback): 보기·쓰기·완료·수락·거절의 권한을 누른 사람 기준으로 다시 확인', () => {
  const db = sample();
  const [m1] = openMissions(db, 'minho');
  const req = pendingRequests(db, 'minho')[0];
  const cb = (data, viewer) => decideCallback(data, { viewer, members: M, db });
  assert.deepEqual(cb('v:changmin', NATHAN), { kind: 'board', member: CHANGMIN });
  assert.deepEqual(cb('s:changmin', MINHO), { kind: 'compose', target: CHANGMIN, mode: 'add' });
  assert.deepEqual(cb('s:minho', NATHAN), { kind: 'compose', target: MINHO, mode: 'request' });
  assert.match(cb('s:lucas', NATHAN).text, /팀원끼리는/);
  assert.deepEqual(cb(`c:${m1.id}`, MINHO), { kind: 'confirm-done', target: MINHO, picked: [{ id: m1.id, title: '로그인 UI' }] });
  assert.match(cb(`c:${m1.id}`, NATHAN).text, /본인 미션만/);
  assert.equal(cb(`c:${req.id}`, MINHO).kind, 'stale', '요청은 완료 버튼 대상이 아님');
  const acc = cb(`a:${req.id}`, MINHO);
  assert.deepEqual([acc.kind, acc.accept, acc.mission.id, acc.requester.id], ['respond', true, req.id, 'nathan']);
  assert.match(cb(`a:${req.id}`, NATHAN).text, /관리자만/);
  assert.equal(cb(`n:${req.id}`, YURI).accept, false, '다른 관리자도 거절 가능');
  assert.deepEqual(cb('g:abcDEF12', null), { kind: 'pending', confirm: true, key: 'abcDEF12' });
  assert.match(cb('v:minho', null).text, /연결/);
  for (const bad of ['', 'v:', 'v:nobody', 'z:minho', 'c:M-9999', 'v:../x', `v:${'a'.repeat(41)}`]) assert.equal(cb(bad, MINHO).kind, 'stale', bad);
  const done = clone(db);
  completeMissions(done, 'minho', [m1.id], { by: 'minho', members: M }, T);
  assert.match(decideCallback(`c:${m1.id}`, { viewer: MINHO, members: M, db: done }).text, /이미 완료/);
});

test('이름봇 화면: 본인은 ✅ 번호 버튼(미션 ID)·받은 요청 수락/거절, 남은 주기/요청 버튼 또는 보기만', () => {
  const db = sample();
  const ids = openMissions(db, 'minho').map((m) => m.id);
  const req = pendingRequests(db, 'minho')[0];
  const own = boardKeyboard(MINHO, MINHO, db);
  assert.deepEqual(datas(own), [...ids.map((id) => `c:${id}`), `a:${req.id}`, `n:${req.id}`, 'v:minho']);
  assert.deepEqual(own.inline_keyboard[0].map((b) => b.text), ['✅ 1', '✅ 2']);
  assert.match(boardText(MINHO, MINHO, db, M), /📨 <b>받은 요청 1개<\/b>[\s\S]*요청 1\. 회의록 정리 — 네이뜬님[\s\S]*✅ 번호/);
  assert.deepEqual(datas(boardKeyboard(MINHO, CHANGMIN, db)), ['s:changmin', 'v:changmin']);
  assert.equal(boardKeyboard(NATHAN, MINHO, db).inline_keyboard[0][0].text, '📨 민호님에게 미션 요청');
  assert.deepEqual(datas(boardKeyboard(NATHAN, LUCAS, db)), ['v:lucas'], '팀원끼리는 보기만');
  assert.match(boardText(NATHAN, LUCAS, db, M), /보기만 할 수 있어요/);
  assert.ok(!boardText(NATHAN, MINHO, db, M).includes('받은 요청'), '남의 요청함은 안 보임');
  const many = empty();
  addMissions(many, 'minho', Array.from({ length: 12 }, (_, i) => ({ title: `일${i + 1}` })), 'minho', M, {}, T);
  const rows = listKeyboard(many, 'minho').inline_keyboard;
  assert.deepEqual(rows.map((r) => r.length), [5, 5, 1], '완료 버튼은 10개까지, 한 줄에 5개 + 새로고침');
  assert.equal(rows[1][4].text, '✅ 10');
  assert.ok(rows.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64), 'callback_data 64바이트 제한');
});

test('팀 현황·보낸 미션·요청/결과 알림·확인 결과 문구', () => {
  const db = sample();
  assert.match(teamText(M, db, new Set(['minho', 'nathan'])), /<b>민호<\/b> — 남은 2 · 완료 0 · 📨 요청 1\n[\s\S]*<b>루카스<\/b> — 남은 0 · 완료 0 · <i>텔레그램 미연결<\/i>/);
  const req = pendingRequests(db, 'minho')[0];
  assert.match(sentText(NATHAN, M, db), /⏳ 수락 기다리는 요청 1<\/b>\n• 민호 — 회의록 정리/);
  assert.match(sentText(LUCAS, M, db), /아직 다른 사람에게/);
  respondRequest(db, req.id, true, 'minho', M, T);
  assert.match(sentText(NATHAN, M, db), /🔨 진행 중 1<\/b>\n• 민호 — 회의록 정리/);
  const n = requestNotice(NATHAN, [req]);
  assert.match(n.text, /미션 요청이 왔어요[\s\S]*네이뜬님이 보냈어요:\n1\. 회의록 정리/);
  assert.deepEqual(datas(n.reply_markup), [`a:${req.id}`, `n:${req.id}`]);
  assert.match(respondNotice(req, true, MINHO, MINHO), /민호님이 미션 요청을 수락했어요<\/b>\n• 회의록 정리/);
  assert.match(respondNotice(req, false, YURI, MINHO), /거절했어요<\/b> \(유리님이 처리\)/);
  assert.match(resultText('request', '민호', { result: { added: [req], skipped: [] } }), /민호님에게 미션을 요청했어요[\s\S]*수락하거나 거절하면 알려 드려요/);
  assert.equal(resultText('add', '민호', { unchanged: true, result: {} }), '변경 없음 — 민호님에게 이미 그대로 있어요.');
  assert.match(menuText(NATHAN, M), /관리자\(창민·민호·유리\)에게는 <b>📨 미션 요청<\/b>/);
  assert.match(menuText(MINHO, M), /📨 미션 주기/);
  assert.deepEqual(composePrompt(CHANGMIN, 'add').reply_markup.force_reply, true);
  assert.deepEqual(withoutMission(n.reply_markup, req.id), { inline_keyboard: [] }, '처리한 요청 버튼은 메시지에서 뺌');
});

// ---------------- 저장(봇) ----------------

function tempNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-note-app-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'members.json'), JSON.stringify({ members: M }, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'missions.json'), JSON.stringify(empty()));
  return dir;
}

test('봇 저장: 요청·수락을 텔레그램 팀원 이름으로 기록, 봇이 방금 저장한 내용 위에서는 Actions 확인 전에도 이어서 저장', async () => {
  const dir = tempNote();
  const github = fakeGithub({ dir, login: 'newcode135-prog' });
  github.access = () => ({ push: true, admin: true });
  const trusted = new Set();
  const save = async (spec, as) => {
    const w = await mutate(github, spec, () => 'test', { as, via: '텔레그램', trusted });
    if (w.commit) trusted.add(`${w.membersSha}:${blobSha(w.body)}`);
    return w;
  };
  const w1 = await save(ACTIONS.request.apply({ targetId: 'minho', items: it('회의록 정리') }), 'nathan');
  assert.equal(blobSha(w1.body), github.store.get(DB_FILE).sha, '봇이 기억하는 내용 = GitHub 가 돌려주는 sha');
  // 이제 main(봇이 저장한 내용) ≠ Actions 가 확인한 상태 — 봇이 저장한 내용이므로 이어서 수락 저장 가능
  github.atVerified = { [DB_FILE]: { text: '', sha: 'older' } };
  const id = w1.result.added[0].id;
  const w2 = await save((db, ms, actor) => respondRequest(db, id, true, actor.id, ms), 'minho');
  assert.ok(w2.commit);
  const saved = JSON.parse(github.store.get(DB_FILE).text).missions.find((m) => m.id === id);
  assert.deepEqual([saved.status, saved.createdBy, saved.acceptedBy], ['todo', 'nathan', 'minho']);
  assert.match(github.commits[0].message, /\(by 네이뜬·텔레그램, newcode135-prog 계정으로 저장\)$/);
  // 남이 끼어들어 main 내용이 봇이 저장한 것과 다르면 다시 확인된 상태만 믿는다
  github.put(DB_FILE, `${github.store.get(DB_FILE).text.trimEnd()} \n`);
  await assert.rejects(save(ACTIONS.request.apply({ targetId: 'yuri', items: it('B') }), 'nathan'), /확인되지 않은 변경/);
  await assert.rejects(mutate(github, ACTIONS.request.apply({ targetId: 'lucas', items: it('C') }), () => 't', { as: 'nathan', trusted: new Set([`${w2.membersSha}:${github.store.get(DB_FILE).sha}`]) }), /팀원끼리는/, '권한은 누른 팀원 기준');
});

test('blobSha 는 git blob id 와 같다(GitHub Contents API 의 sha)', () => {
  assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(blobSha('미믹'), blobSha('미믹'));
  assert.notEqual(blobSha('a'), blobSha('b'));
});

// ---------------- Actions 알림 ----------------

const files = (db, members = M) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members }) });
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_REPOSITORY_OWNER: 'newcode135-prog', TELEGRAM_CHAT_ID_CHANGMIN: '1001', TELEGRAM_CHAT_ID_MINHO: '1002', TELEGRAM_CHAT_ID_YURI: '1003', TELEGRAM_CHAT_ID_NATHAN: '1004', TELEGRAM_CHAT_ID_LUCAS: '1005' };
const ghOf = (pushes) => ({ pushes: async () => new Map(Object.entries(pushes)), isRepoAdmin: async (l) => l === 'newcode135-prog' });
const newLedger = (verifiedSha) => ({ verifiedSha, owner: 'changmin', members: {}, alerts: [], flagged: [] });
const pushEnv = (before, after, actor) => ({ ...ENV, EVENT_NAME: 'push', BEFORE_SHA: before, AFTER_SHA: after, ACTOR: actor });

test('Actions: 목록 메시지에 ✅ 완료·🔄 버튼, 대기 요청은 알리지 않고, 수락되면 받은 사람에게 "🆕 새 미션 (요청한 사람)"', async () => {
  const db0 = empty();
  addMissions(db0, 'minho', it('로그인 UI'), 'changmin', M, {}, T);
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  requestMissions(db1, 'minho', it('회의록 정리'), 'nathan', M, T); // 봇이 저장(저장소 주인 계정)
  const c1 = git.add(files(db1));
  const tg = fakeTelegram();
  const ledger = newLedger(c0);
  const r1 = await runNotify({ env: pushEnv(c0, c1, 'newcode135-prog'), git, gh: ghOf({ [c1]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual([r1.problems, r1.results, r1.verified], [[], [], c1], '대기 요청은 목록이 안 바뀌어 보내지 않음(요청 알림은 봇이 바로 보냄)');
  const db2 = clone(db1);
  const req = pendingRequests(db2, 'minho')[0];
  respondRequest(db2, req.id, true, 'minho', M, T);
  const c2 = git.add(files(db2));
  const r2 = await runNotify({ env: pushEnv(c1, c2, 'newcode135-prog'), git, gh: ghOf({ [c2]: 'newcode135-prog' }), send: tg.send, ledger, now: () => T });
  assert.deepEqual(r2.results.map((x) => [x.member, x.status]), [['minho', 'sent']]);
  const msg = tg.sent.at(-1);
  assert.match(msg.text, /🆕 새 미션: 회의록 정리 \(네이뜬님이 줌\)[\s\S]*1️⃣ 로그인 UI\n\n2️⃣ 회의록 정리/);
  assert.deepEqual(datas(msg.extra.reply_markup), [`c:${db0.missions[0].id}`, `c:${req.id}`, 'v:minho']);
});

test('Actions: 팀원이 GitHub 에 직접 요청·수락을 올리면(봇이 아닌 push) 권한 없는 변경으로 막는다', async () => {
  const db0 = empty();
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = clone(db0);
  requestMissions(db1, 'minho', it('직접 올린 요청'), 'nathan', M, T);
  const c1 = git.add(files(db1));
  const tg = fakeTelegram();
  const r = await runNotify({ env: pushEnv(c0, c1, 'nathan-gh'), git, gh: ghOf({ [c1]: 'nathan-gh' }), send: tg.send, ledger: newLedger(c0), now: () => T });
  assert.equal(r.problems[0].kind, 'unauthorized');
  assert.equal(r.verified, c0);
});
