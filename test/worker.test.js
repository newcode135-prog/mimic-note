// 코어 오브 미믹노트 봇 서버(클라우드플레어 워커)를 Node 에서 가짜 KV·GitHub(Git Data API 포함)·텔레그램으로 시험한다.
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
const S = { RELAY: 'r'.repeat(40), HOOK: 'w'.repeat(40), IMPORT: 'i'.repeat(40) };
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function world({ onPatch } = {}) {
  const db = { nextId: 1, missions: [] };
  setMissions(db, '민호', parseMissionList('1. 로그인 UI 개발\n2. 파일 다운로드 API 테스트'), 'changmin', M, T);
  // 일직선 커밋 기록: sha → { files, parent }
  const commits = new Map();
  const root = sha1('root');
  commits.set(root, { files: { [DB_FILE]: JSON.stringify(db, null, 2), [MEMBERS_FILE]: JSON.stringify({ members: M }) }, parent: null });
  const state = { head: root, blobs: new Map(), trees: new Map(), botCommits: 0 };
  const pushMain = (change) => { // 다른 사람이 main 에 push
    const files = { ...commits.get(state.head).files, ...change };
    const c = sha1(`push-${commits.size}-${JSON.stringify(change)}`);
    commits.set(c, { files, parent: state.head });
    state.head = c;
    return c;
  };
  const kv = new Map();
  const tg = [];
  const gh = [];
  let mid = 100;
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const filesAt = (ref) => (ref === 'main' ? commits.get(state.head) : commits.get(ref))?.files;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const method = init.method || 'GET';
    if (u.host === 'api.telegram.org') {
      const m = u.pathname.split('/').pop();
      tg.push({ method: m, body });
      if (m === 'sendMessage') return reply({ ok: true, result: { message_id: ++mid, chat: { id: Number(body.chat_id) } } });
      if (m === 'getMe') return reply({ ok: true, result: { username: 'mimic_note_team_bot' } });
      return reply({ ok: true, result: true });
    }
    if (u.host !== 'api.github.com') throw new Error(`unexpected url ${url}`);
    gh.push({ method, path: u.pathname + u.search, body });
    const p = u.pathname.replace(`/repos/${REPO}`, '');
    if (u.pathname === '/user') return reply({ login: 'newcode135-prog' });
    if (p === '' ) return reply({ permissions: { push: true, admin: true } });
    if (p === '/git/ref/heads/main') return reply({ object: { sha: state.head } });
    const cm = p.match(/^\/contents\/(.+)$/);
    if (cm && method === 'GET') {
      const t = filesAt(u.searchParams.get('ref'))?.[cm[1]];
      return t == null ? reply({ message: 'Not Found' }, 404) : reply({ content: Buffer.from(t).toString('base64'), sha: sha1(t) });
    }
    if (p === '/git/blobs') { const s = sha1(`blob${body.content}`); state.blobs.set(s, Buffer.from(body.content, 'base64').toString('utf8')); return reply({ sha: s }, 201); }
    const gc = p.match(/^\/git\/commits\/([0-9a-f]+)$/);
    if (gc) return reply({ tree: { sha: `tree-of-${gc[1]}` } });
    if (p === '/git/trees') { const s = sha1(`tree${JSON.stringify(body)}`); state.trees.set(s, body); return reply({ sha: s }, 201); }
    if (p === '/git/commits') {
      const tree = state.trees.get(body.tree);
      const parent = body.parents[0];
      const files = { ...commits.get(parent).files };
      for (const t of tree.tree) files[t.path] = state.blobs.get(t.sha);
      const s = sha1(`commit${body.message}${parent}${commits.size}`);
      commits.set(s, { files, parent, message: body.message });
      return reply({ sha: s, html_url: `https://github.com/${REPO}/commit/${s}` }, 201);
    }
    if (p === '/git/refs/heads/main' && method === 'PATCH') {
      await onPatch?.({ pushMain, state });
      if (commits.get(body.sha).parent !== state.head) return reply({ message: 'Update is not a fast forward' }, 422);
      state.head = body.sha;
      state.botCommits += 1;
      return reply({ object: { sha: body.sha } });
    }
    return reply({ message: `unexpected ${method} ${p}` }, 500);
  };
  const env = {
    NOTE: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } },
    TELEGRAM_BOT_TOKEN: 'tg-token', GITHUB_TOKEN: 'gh-token', RELAY_SECRET: S.RELAY, WEBHOOK_SECRET: S.HOOK, IMPORT_SECRET: S.IMPORT, REPO, fetch: fetchFn,
  };
  const post = async (pathName, body, headers = {}, e = env) => {
    const waits = [];
    const res = await worker.fetch(new Request(`https://bot.example${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), e, { waitUntil: (pr) => waits.push(pr) });
    await Promise.all(waits);
    return res;
  };
  const hook = (update) => post('/telegram', update, { 'x-telegram-bot-api-secret-token': S.HOOK });
  const relay = (pathName, body) => post(pathName, body, { authorization: `Bearer ${S.RELAY}` });
  const importer = (body) => post('/relay/import', body, { authorization: `Bearer ${S.IMPORT}` });
  let uid = 0;
  const msg = (chat, text) => hook({ update_id: ++uid, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
  const tap = (chat, data, from = chat) => hook({ update_id: ++uid, callback_query: { id: `cb${uid}`, from: { id: from }, message: { chat: { id: chat }, message_id: 50 + uid }, data } });
  const lastText = () => tg.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1)?.body.text;
  const askData = () => tg.filter((c) => c.method === 'sendMessage').at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  const dbAtHead = () => JSON.parse(commits.get(state.head).files[DB_FILE]);
  return { root, commits, state, pushMain, kv, tg, gh, env, post, hook, relay, importer, msg, tap, lastText, askData, dbAtHead };
}

test('워커 인증: 틀린·없는·짧은 비밀값은 모두 거절(fail closed), 중계 비밀로 import 불가', async () => {
  const w = world();
  assert.equal((await w.post('/telegram', { message: {} }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 403);
  assert.equal((await w.post('/relay/send', { member: 'minho', text: 'x' }, { authorization: 'Bearer nope' })).status, 403);
  assert.equal((await w.post('/relay/import', { owners: { 1: 'changmin' } }, { authorization: `Bearer ${S.RELAY}` })).status, 403, 'Actions 비밀(중계)로는 연결을 못 넣음');
  const noSecret = { ...w.env, RELAY_SECRET: undefined, IMPORT_SECRET: undefined };
  assert.equal((await w.post('/relay/import', { owners: { 666: 'changmin' } }, { authorization: 'Bearer undefined' }, noSecret)).status, 403);
  assert.equal((await w.post('/relay/send', { member: 'x', text: 'x' }, { authorization: 'Bearer undefined' }, noSecret)).status, 403);
  const short = { ...w.env, RELAY_SECRET: 'abc' };
  assert.equal((await w.post('/relay/send', { member: 'x', text: 'x' }, { authorization: 'Bearer abc' }, short)).status, 403);
  assert.equal(w.kv.size, 0);
  const health = await worker.fetch(new Request('https://bot.example/health'), w.env, { waitUntil() {} });
  assert.equal(await health.text(), 'ok');
});

test('워커 중계·import: 미연결은 unconnected, import 는 이미 연결된 사람을 덮어쓰지 않음, 긴 메시지도 텔레그램에 맡김', async () => {
  const w = world();
  assert.deepEqual(await (await w.relay('/relay/send', { member: 'minho', text: '안녕' })).json(), { status: 'unconnected' });
  await w.importer({ owners: { 1002: 'minho' }, codes: [], verified: w.root });
  const r = await (await w.relay('/relay/send', { member: 'minho', text: '<b>미션</b>' })).json();
  assert.equal(r.status, 'sent');
  assert.equal(w.tg.at(-1).body.chat_id, '1002');
  await w.importer({ owners: { 7777: 'minho' } }); // 다시 실행해도 민호의 연결은 그대로
  assert.equal(w.kv.get('member:minho'), '1002');
  assert.equal(w.kv.has('chat:7777'), false);
  const long = 'ㄱ'.repeat(4500); // 태그를 빼면 4096 이하일 수 있으니 길이 판단은 텔레그램에 맡김
  assert.equal((await (await w.relay('/relay/send', { member: 'minho', text: long })).json()).status, 'sent');
  assert.equal((await w.relay('/relay/verified', { sha: 'not-a-sha' })).status, 400);
  await w.relay('/relay/verified', { sha: 'b'.repeat(40) });
  assert.equal(w.kv.get('verified'), 'b'.repeat(40));
  assert.equal((await (await w.relay('/relay/send', { member: '../x', text: 'x' })).json()).status, 'failed');
});

test('워커 연결: 일회용 코드로만, 한 번 쓰면 사라짐, 연결되면 지금 미션을 바로 보냄(Actions 를 부르지 않음)', async () => {
  const w = world();
  await w.importer({ owners: {}, codes: [{ code: 'ABCDEFGHijklmn12', member: 'lucas', ttl: 3600 }], verified: w.root });
  await w.msg(5005, '/start');
  assert.match(w.lastText(), /본인 연결 링크/);
  await w.msg(5005, '/start wrongcode1234567');
  assert.match(w.lastText(), /올바르지 않거나 만료/);
  await w.msg(5005, '/start ABCDEFGHijklmn12');
  const sent = w.tg.filter((c) => c.method === 'sendMessage').slice(-2).map((c) => c.body.text);
  assert.match(sent[0], /연결 완료 — 루카스님/);
  assert.match(sent[1], /루카스님의 미션/);
  assert.equal(w.kv.get('chat:5005'), 'lucas');
  assert.equal(w.kv.get('member:lucas'), '5005');
  assert.equal(w.kv.has('code:ABCDEFGHijklmn12'), false);
  assert.ok(!w.gh.some((c) => c.path.endsWith('/dispatches')), '저장소 주인 토큰으로 Actions 를 부르지 않음');
  await w.msg(6006, '/start ABCDEFGHijklmn12');
  assert.match(w.lastText(), /올바르지 않거나 만료/, '쓴 코드는 다시 못 씀');
});

test('워커 연결 보안: 이미 연결된 사람의 재연결 링크는 대표관리자만, 재연결되면 예전 대화에 알림, 동시에 연결해도 둘 다 저장', async () => {
  const w = world();
  await w.importer({ owners: { 1001: 'changmin', 1003: 'yuri' }, codes: [{ code: 'LUCAScode1234567', member: 'lucas', ttl: 3600 }, { code: 'NATHANcode123456', member: 'nathan', ttl: 3600 }], verified: w.root });
  await w.msg(1003, '창민 연결링크'); // 관리자 유리가 대표관리자(이미 연결됨) 링크를 만들려 함
  assert.match(w.lastText(), /대표관리자만/);
  assert.equal([...w.kv.keys()].filter((k) => k.startsWith('code:')).length, 2);
  await Promise.all([w.msg(5005, '/start LUCAScode1234567'), w.msg(6006, '/start NATHANcode123456')]);
  assert.equal(w.kv.get('member:lucas'), '5005');
  assert.equal(w.kv.get('member:nathan'), '6006');
  await w.msg(1001, '유리 연결링크'); // 대표관리자는 재연결 링크 가능
  const code = w.lastText().match(/start=([A-Za-z0-9_-]{16})/)[1];
  await w.msg(9009, `/start ${code}`);
  assert.equal(w.kv.get('member:yuri'), '9009');
  assert.equal(w.kv.has('chat:1003'), false);
  assert.ok(w.tg.some((c) => c.method === 'sendMessage' && c.body.chat_id === '1003' && /연결\(유리\)이 해제됐어요/.test(c.body.text)), '예전 대화에 알림');
});

test('워커 버튼: 본인 버튼은 확인된 상태의 미션, 남의 버튼은 거절, 단체방은 무시, 확인 상태 없으면 정직하게 답함', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.root });
  await w.msg(1002, '민호봇');
  assert.match(w.lastText(), /민호님의 미션[\s\S]*1️⃣ 로그인 UI 개발/);
  await w.msg(1002, '창민봇');
  assert.match(w.lastText(), /창민봇은 창민님만/);
  const before = w.tg.length;
  await w.hook({ update_id: 999, message: { chat: { id: -100, type: 'group' }, from: { id: 1002 }, text: '민호봇' } });
  assert.equal(w.tg.length, before);
  w.kv.delete('verified');
  await w.msg(1002, '민호봇');
  assert.match(w.lastText(), /확인 상태를 아직 받지 못했어요/);
});

test('워커 미션 주기: 확인 버튼 뒤 확인한 커밋 위에만 저장(준 사람 기록), 두 번 누르면 이미 처리, 남의 버튼·팀원은 거절', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.root });
  await w.msg(1002, '창민 이거 결제해줘');
  assert.match(w.lastText(), /<b>창민<\/b>님에게 이 미션을 줄까요\?\n• 이거 결제해줘/);
  const data = w.askData();
  await w.tap(1002, data);
  const added = w.dbAtHead().missions.find((m) => m.title === '이거 결제해줘');
  assert.deepEqual([added.assignee, added.createdBy], ['changmin', 'minho']);
  assert.equal(w.commits.get(w.state.head).parent, w.root, '확인한 커밋 바로 위에 저장');
  assert.match(w.commits.get(w.state.head).message, /\(by 민호·텔레그램, newcode135-prog 계정으로 저장\)$/);
  assert.match(w.lastText(), /✅ 창민님에게 미션을 줬어요\n• \[M-0003\] 이거 결제해줘/);
  await w.tap(1002, data);
  assert.match(w.tg.at(-1).body.text || '', /이미 처리했거나 만료/);
  await w.msg(1004, '민호 이거 해줘');
  assert.match(w.lastText(), /관리자\(창민·민호·유리\)만/);
  await w.msg(1002, '유리 회의록');
  await w.tap(1004, w.askData(), 1004); // 다른 대화에서 누른 버튼
  assert.ok(!w.dbAtHead().missions.some((m) => m.title === '회의록'));
  assert.equal(w.state.botCommits, 1);
});

test('워커: main 에 확인 안 된 변경이 있거나, 확인과 저장 사이에 끼어들면 저장하지 않음(승인 세탁 방지)', async () => {
  // ① 처음부터 main 에 확인 안 된 명부 변경
  const a = world();
  await a.importer({ owners: { 1003: 'yuri' }, codes: [], verified: a.root });
  a.pushMain({ [MEMBERS_FILE]: JSON.stringify({ members: M.map((m) => (m.id === 'yuri' ? { ...m, role: 'owner' } : m.id === 'changmin' ? { ...m, role: 'admin' } : m)) }) });
  await a.msg(1003, '루카스 이거 결제해줘');
  await a.tap(1003, a.askData());
  assert.match(a.lastText(), /❌ 저장하지 못했어요: main 에 아직 확인되지 않은 변경/);
  assert.equal(a.state.botCommits, 0);
  // ② 확인을 통과한 뒤 저장 직전에 누가 명부를 바꿈 → 빨리감기 실패(422) → 다시 확인 → 거절
  let once = true;
  const b = world({
    onPatch: ({ pushMain }) => {
      if (!once) return;
      once = false;
      pushMain({ [MEMBERS_FILE]: JSON.stringify({ members: M.map((m) => (m.id === 'nathan' ? { ...m, role: 'owner' } : m.id === 'changmin' ? { ...m, role: 'admin' } : m)) }) });
    },
  });
  await b.importer({ owners: { 1002: 'minho' }, codes: [], verified: b.root });
  await b.msg(1002, '창민 이거 결제해줘');
  await b.tap(1002, b.askData());
  assert.match(b.lastText(), /❌ 저장하지 못했어요: main 에 아직 확인되지 않은 변경/);
  assert.equal(b.state.botCommits, 0, '끼어든 변경 위에 저장해 승인해 버리지 않음');
});

test('워커 완료·연결 링크: "민호 미션완료 2" 확인 후 완료, 거의 동시에 두 번 눌러도 실패로 덮어쓰지 않음, 관리자만 링크 생성', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.root });
  await w.msg(1002, '민호 미션완료 2');
  assert.match(w.lastText(), /완료할까요\?\n• \[M-0002\] 파일 다운로드 API 테스트/);
  const data = w.askData();
  await Promise.all([w.tap(1002, data), w.tap(1002, data)]);
  assert.equal(w.dbAtHead().missions.find((m) => m.id === 'M-0002').status, 'done');
  const edits = w.tg.filter((c) => c.method === 'editMessageText').map((c) => c.body.text);
  assert.ok(!edits.some((t) => t.startsWith('❌')), `실패로 덮어쓰지 않음: ${edits.join(' | ')}`);
  await w.msg(1002, '루카스 연결링크');
  const link = w.lastText().match(/https:\/\/t\.me\/mimic_note_team_bot\?start=([A-Za-z0-9_-]{16})/);
  assert.ok(link);
  assert.equal(JSON.parse(w.kv.get(`code:${link[1]}`)).member, 'lucas');
  await w.msg(1004, '루카스 연결링크');
  assert.match(w.lastText(), /관리자만/);
});

test('notify 중계 모드: 워커가 미연결이면 보류, 워커 실패(4xx)면 "🆕" 줄 없이 다시, 직접 토큰 없이도 동작', async () => {
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
