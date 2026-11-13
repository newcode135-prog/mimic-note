// 코어 오브 미믹노트 봇 서버(클라우드플레어 워커)를 Node 에서 가짜 KV·GitHub·텔레그램으로 시험한다(네트워크 안 씀).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../worker/index.mjs';
import { setMissions, parseMissionList, DB_FILE, MEMBERS_FILE } from '../mimic-note/lib.mjs';
import { runNotify } from '../mimic-note/notify.mjs';
import { fakeGit } from './mimic-note-fakes.js';

const REPO = 'newcode135-prog/mimic-note';
const T = '2026-11-13T00:00:00.000Z';
const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function world() {
  const db = { nextId: 1, missions: [] };
  setMissions(db, '민호', parseMissionList('1. 로그인 UI 개발\n2. 파일 다운로드 API 테스트'), 'changmin', M, T);
  const files = { main: { [DB_FILE]: JSON.stringify(db, null, 2), [MEMBERS_FILE]: JSON.stringify({ members: M }) } };
  const verified = 'a'.repeat(40);
  files[verified] = { ...files.main };
  const kv = new Map();
  const tg = [];
  const gh = [];
  let mid = 100;
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.host === 'api.telegram.org') {
      const method = u.pathname.split('/').pop();
      tg.push({ method, body });
      if (method === 'sendMessage') return reply({ ok: true, result: { message_id: ++mid, chat: { id: Number(body.chat_id) } } });
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mimic_note_team_bot' } });
      return reply({ ok: true, result: true });
    }
    if (u.host === 'api.github.com') {
      gh.push({ method: init.method, path: u.pathname + u.search, body });
      if (u.pathname === '/user') return reply({ login: 'newcode135-prog' });
      if (u.pathname === `/repos/${REPO}`) return reply({ permissions: { push: true, admin: true } });
      const cm = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
      if (cm && init.method === 'GET') {
        const t = files[u.searchParams.get('ref')]?.[cm[1]];
        return t == null ? reply({ message: 'Not Found' }, 404) : reply({ content: Buffer.from(t).toString('base64'), sha: sha1(t) });
      }
      if (cm && init.method === 'PUT') {
        const cur = files.main[cm[1]];
        if (sha1(cur) !== body.sha) return reply({ message: `${cm[1]} is at ${sha1(cur)} but expected ${body.sha}` }, 409);
        files.main[cm[1]] = Buffer.from(body.content, 'base64').toString('utf8');
        return reply({ commit: { sha: sha1(`${files.main[cm[1]]}#c`), html_url: 'https://github.com/x/commit/1' } });
      }
      if (u.pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
      return reply({ message: 'unexpected' }, 500);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const env = {
    NOTE: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } },
    TELEGRAM_BOT_TOKEN: 'tg-token', GITHUB_TOKEN: 'gh-token', RELAY_SECRET: 'relay-secret-123', WEBHOOK_SECRET: 'hook-secret-123', REPO, fetch: fetchFn,
  };
  const post = async (pathName, body, headers = {}) => {
    const waits = [];
    const res = await worker.fetch(new Request(`https://bot.example${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  };
  const hook = (update) => post('/telegram', update, { 'x-telegram-bot-api-secret-token': 'hook-secret-123' });
  const relay = (pathName, body) => post(pathName, body, { authorization: 'Bearer relay-secret-123' });
  const msg = (chat, text) => hook({ update_id: Math.floor(Math.random() * 1e9), message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
  const lastSent = () => tg.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1)?.body;
  return { files, verified, kv, tg, gh, env, post, hook, relay, msg, lastSent };
}

test('워커: 비밀 헤더 없는 웹훅·중계는 거절, 상태 확인은 열림', async () => {
  const w = world();
  assert.equal((await w.post('/telegram', { message: {} }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 403);
  assert.equal((await w.post('/relay/send', { member: 'minho', text: 'x' }, { authorization: 'Bearer nope' })).status, 403);
  assert.equal((await w.post('/relay/send', { member: 'minho', text: 'x' })).status, 403);
  const health = await worker.fetch(new Request('https://bot.example/health'), w.env, { waitUntil() {} });
  assert.equal(await health.text(), 'ok');
  assert.equal(w.tg.length, 0);
});

test('워커 중계: 미연결이면 unconnected, 옮겨 온 연결로는 그 사람 chat id 로만 발송, 확인 상태 저장', async () => {
  const w = world();
  assert.deepEqual(await (await w.relay('/relay/send', { member: 'minho', text: '안녕' })).json(), { status: 'unconnected' });
  const imp = await (await w.relay('/relay/import', { owners: { 1002: 'minho' }, codes: [], verified: w.verified })).json();
  assert.deepEqual(imp.linked, ['minho']);
  const r = await (await w.relay('/relay/send', { member: 'minho', text: '<b>미션</b>' })).json();
  assert.equal(r.status, 'sent');
  assert.equal(w.tg.at(-1).body.chat_id, '1002');
  assert.equal((await w.relay('/relay/verified', { sha: 'not-a-sha' })).status, 400);
  await w.relay('/relay/verified', { sha: 'b'.repeat(40) });
  assert.equal(w.kv.get('verified'), 'b'.repeat(40));
  assert.equal((await (await w.relay('/relay/send', { member: '../x', text: 'x' })).json()).status, 'failed');
});

test('워커 연결: 일회용 코드로만 연결되고 코드는 한 번 쓰면 사라짐, 연결되면 지금 미션 발송 요청', async () => {
  const w = world();
  await w.relay('/relay/import', { owners: {}, codes: [{ code: 'ABCDEFGHijklmn12', member: 'lucas', ttl: 3600 }], verified: w.verified });
  await w.msg(5005, '/start');
  assert.match(w.lastSent().text, /본인 연결 링크/);
  await w.msg(5005, '/start wrongcode1234567');
  assert.match(w.lastSent().text, /올바르지 않거나 만료/);
  await w.msg(5005, '/start ABCDEFGHijklmn12');
  assert.match(w.lastSent().text, /연결 완료 — 루카스님/);
  assert.deepEqual(JSON.parse(w.kv.get('owners')), { 5005: 'lucas' });
  assert.equal(w.kv.has('code:ABCDEFGHijklmn12'), false);
  assert.ok(w.gh.some((c) => c.path.endsWith('/dispatches') && c.body.inputs.member === 'lucas'));
  await w.msg(6006, '/start ABCDEFGHijklmn12');
  assert.match(w.lastSent().text, /올바르지 않거나 만료/, '쓴 코드는 다시 못 씀');
});

test('워커 버튼: 본인 버튼은 확인된 상태의 미션, 남의 버튼은 거절, 단체방은 무시', async () => {
  const w = world();
  await w.relay('/relay/import', { owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.verified });
  await w.msg(1002, '민호봇');
  assert.match(w.lastSent().text, /민호님의 미션[\s\S]*1️⃣ 로그인 UI 개발/);
  await w.msg(1002, '창민봇');
  assert.match(w.lastSent().text, /창민봇은 창민님만/);
  const before = w.tg.length;
  await w.hook({ update_id: 1, message: { chat: { id: -100, type: 'group' }, from: { id: 1002 }, text: '민호봇' } });
  assert.equal(w.tg.length, before);
  // 확인 상태가 아직 없으면 정직하게 "잠시 뒤"
  w.kv.delete('verified');
  await w.msg(1002, '민호봇');
  assert.match(w.lastSent().text, /확인 상태를 아직 받지 못했어요/);
});

test('워커 미션 주기: 확인 버튼 뒤 GitHub 저장(준 사람 기록), 두 번 누르면 이미 처리, 팀원은 거절', async () => {
  const w = world();
  await w.relay('/relay/import', { owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.verified });
  await w.msg(1002, '창민 이거 결제해줘');
  const ask = w.tg.at(-1).body;
  assert.match(ask.text, /<b>창민<\/b>님에게 이 미션을 줄까요\?\n• 이거 결제해줘/);
  const data = ask.reply_markup.inline_keyboard[0][0].callback_data;
  const tap = () => w.hook({ update_id: 2, callback_query: { id: 'cb1', from: { id: 1002 }, message: { chat: { id: 1002 }, message_id: 77 }, data } });
  await tap();
  const db = JSON.parse(w.files.main[DB_FILE]);
  const added = db.missions.find((m) => m.title === '이거 결제해줘');
  assert.deepEqual([added.assignee, added.createdBy], ['changmin', 'minho']);
  assert.match(w.lastSent().text, /✅ 창민님에게 미션을 줬어요\n• \[M-0003\] 이거 결제해줘/);
  const put = w.gh.find((c) => c.method === 'PUT');
  assert.match(put.body.message, /\(by 민호·텔레그램, newcode135-prog 계정으로 저장\)$/);
  await tap();
  assert.match(w.tg.at(-1).body.text || '', /이미 처리했거나 만료/);
  await w.msg(1004, '민호 이거 해줘');
  assert.match(w.lastSent().text, /관리자\(창민·민호·유리\)만/);
  // 남이 누른 확인 버튼은 무시
  await w.msg(1002, '유리 회의록');
  const data2 = w.tg.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  await w.hook({ update_id: 3, callback_query: { id: 'cb2', from: { id: 1004 }, message: { chat: { id: 1004 }, message_id: 78 }, data: data2 } });
  assert.ok(!JSON.parse(w.files.main[DB_FILE]).missions.some((m) => m.title === '회의록'));
});

test('워커: main 에 확인 안 된 변경이 있으면 텔레그램 저장을 거절(소유자 계정으로 승인 세탁 방지)', async () => {
  const w = world();
  await w.relay('/relay/import', { owners: { 1003: 'yuri' }, codes: [], verified: w.verified });
  w.files.main[MEMBERS_FILE] = JSON.stringify({ members: M.map((m) => (m.id === 'yuri' ? { ...m, role: 'owner' } : m.id === 'changmin' ? { ...m, role: 'admin' } : m)) });
  await w.msg(1003, '루카스 이거 결제해줘');
  const data = w.tg.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  await w.hook({ update_id: 4, callback_query: { id: 'cb', from: { id: 1003 }, message: { chat: { id: 1003 }, message_id: 9 }, data } });
  assert.match(w.lastSent().text, /❌ 저장하지 못했어요: main 에 아직 확인되지 않은 변경/);
  assert.equal(w.gh.filter((c) => c.method === 'PUT').length, 0);
});

test('워커 완료·연결 링크: "민호 미션완료 2" 는 지금 목록의 ID 로 확인 후 완료, 관리자는 "루카스 연결링크" 로 링크 생성', async () => {
  const w = world();
  await w.relay('/relay/import', { owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.verified });
  await w.msg(1002, '민호 미션완료 2');
  const ask = w.tg.at(-1).body;
  assert.match(ask.text, /완료할까요\?\n• \[M-0002\] 파일 다운로드 API 테스트/);
  await w.hook({ update_id: 5, callback_query: { id: 'c', from: { id: 1002 }, message: { chat: { id: 1002 }, message_id: 1 }, data: ask.reply_markup.inline_keyboard[0][0].callback_data } });
  assert.equal(JSON.parse(w.files.main[DB_FILE]).missions.find((m) => m.id === 'M-0002').status, 'done');
  await w.msg(1002, '루카스 연결링크');
  const link = w.lastSent().text.match(/https:\/\/t\.me\/mimic_note_team_bot\?start=([A-Za-z0-9_-]{16})/);
  assert.ok(link);
  assert.equal(JSON.parse(w.kv.get(`code:${link[1]}`)).member, 'lucas');
  await w.msg(1004, '루카스 연결링크');
  assert.match(w.lastSent().text, /관리자만/);
});

test('notify 중계 모드: 워커가 미연결이면 보류, 워커 실패(4xx)면 "방금 완료" 없이 다시, 직접 토큰 없이도 동작', async () => {
  const db0 = { nextId: 1, missions: [] };
  const files = (db) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members: M }) });
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = JSON.parse(JSON.stringify(db0));
  setMissions(db1, '민호', parseMissionList('1. A\n2. B'), 'changmin', M, T);
  setMissions(db1, '루카스', parseMissionList('1. L'), 'changmin', M, T);
  const c1 = git.add(files(db1));
  const sent = [];
  const relay = async (member, text) => {
    if (member === 'lucas') return { status: 'unconnected' };
    if (text.includes('🆕')) throw Object.assign(new Error('Bad Request: message is too long'), { code: 400 });
    sent.push({ member, text });
    return { status: 'sent', messageId: 7 };
  };
  const ledger = { verifiedSha: c0, owner: 'changmin', members: {}, alerts: [], flagged: [], notices: [] };
  const r = await runNotify({ env: { EVENT_NAME: 'push', BEFORE_SHA: c0, AFTER_SHA: c1, ACTOR: 'darrenpual', GITHUB_REPOSITORY_OWNER: 'newcode135-prog' }, git, gh: { pushes: async () => new Map([[c1, 'darrenpual']]), isRepoAdmin: async () => false }, relay, ledger, now: () => T });
  assert.deepEqual(r.results.map((x) => [x.member, x.status]).sort(), [['lucas', 'unconnected'], ['minho', 'sent']]);
  assert.ok(!sent[0].text.includes('🆕'), '4xx 면 기본 목록으로');
  assert.equal(ledger.members.lucas.pending, true);
});
