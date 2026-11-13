// 코어 오브 미믹노트 봇 서버(클라우드플레어 워커)를 Node 에서 가짜 KV·GitHub(Git Data·compare·commits API)·텔레그램으로 시험한다.
// 워커는 PC 봇과 같은 app.mjs 를 쓰므로 미션 앱 기능(버튼·요청·수락·언어)이 똑같이 동작해야 한다.
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
    if (p === '') return reply({ permissions: { push: true, admin: true } });
    if (p === '/git/ref/heads/main') return reply({ object: { sha: state.head } });
    const cm = p.match(/^\/contents\/(.+)$/);
    if (cm && method === 'GET') {
      const t = filesAt(u.searchParams.get('ref'))?.[cm[1]];
      return t == null ? reply({ message: 'Not Found' }, 404) : reply({ content: Buffer.from(t).toString('base64'), sha: sha1(t) });
    }
    const cmp = p.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
    if (cmp) { // head 에서 부모를 따라 base 까지(일직선)
      const [, base, h] = cmp;
      const list = [];
      for (let c = h; c && c !== base; c = commits.get(c)?.parent) list.unshift({ sha: c, parents: [{ sha: commits.get(c)?.parent }] });
      const reached = base === h || list.length && commits.get(list[0].sha)?.parent === base;
      return reply({ status: base === h ? 'identical' : reached ? 'ahead' : 'diverged', commits: reached ? list : [] });
    }
    const one = p.match(/^\/commits\/([0-9a-f]+)$/);
    if (one) { // 첫 부모와 비교해 바뀐 파일
      const c = commits.get(one[1]);
      const prev = commits.get(c.parent)?.files || {};
      return reply({ files: Object.keys({ ...prev, ...c.files }).filter((f) => prev[f] !== c.files[f]).map((filename) => ({ filename })) });
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
    NOTE: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, String(v)); },
      delete: async (k) => { kv.delete(k); },
      list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
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
  const tap = (chat, data, from = chat, markup = undefined) => hook({ update_id: ++uid, callback_query: { id: `cb${uid}`, from: { id: from }, message: { chat: { id: chat, type: 'private' }, message_id: 50 + uid, reply_markup: markup }, data } });
  const sends = () => tg.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  const lastText = () => sends().at(-1)?.body.text;
  const lastMarkup = () => sends().at(-1)?.body.reply_markup;
  const askData = () => tg.filter((c) => c.method === 'sendMessage').at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  const toast = () => tg.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.body.text;
  const dbAtHead = () => JSON.parse(commits.get(state.head).files[DB_FILE]);
  const verify = () => relay('/relay/verified', { sha: state.head }); // Actions 가 지금 main 을 확인했다고 알림
  return { root, commits, state, pushMain, kv, tg, gh, env, post, hook, relay, importer, msg, tap, lastText, lastMarkup, askData, toast, dbAtHead, verify };
}
const datas = (m) => (m?.inline_keyboard || []).flat().map((b) => b.callback_data);

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

test('워커 중계·import: 미연결은 unconnected, import 는 이미 연결된 사람을 덮어쓰지 않음, ✅ 버튼은 미션 앱 버튼만', async () => {
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
  // Actions 목록 메시지의 ✅·🔄 버튼은 그대로 붙여 보내고, 다른 버튼(링크·수락 등)은 거절
  const kb = { inline_keyboard: [[{ text: '✅ 1', callback_data: 'c:M-0001' }], [{ text: '🔄 새로고침', callback_data: 'v:minho' }]] };
  assert.equal((await (await w.relay('/relay/send', { member: 'minho', text: '목록', reply_markup: kb })).json()).status, 'sent');
  assert.deepEqual(w.tg.at(-1).body.reply_markup, kb);
  for (const bad of [{ inline_keyboard: [[{ text: 'x', url: 'https://evil.example' }]] }, { inline_keyboard: [[{ text: 'x', callback_data: 'a:M-0001' }]] }, { keyboard: [] }]) {
    assert.equal((await (await w.relay('/relay/send', { member: 'minho', text: 'x', reply_markup: bad })).json()).status, 'failed');
  }
  assert.equal((await w.relay('/relay/verified', { sha: 'not-a-sha' })).status, 400);
  await w.relay('/relay/verified', { sha: 'b'.repeat(40) });
  assert.equal(w.kv.get('verified'), 'b'.repeat(40));
  assert.equal((await (await w.relay('/relay/send', { member: '../x', text: 'x' })).json()).status, 'failed');
});

test('워커 연결: 일회용 코드로만, 한 번 쓰면 사라짐, 연결되면 지금 미션·메뉴·언어 고르기를 보냄(Actions 를 부르지 않음)', async () => {
  const w = world();
  await w.importer({ owners: {}, codes: [{ code: 'ABCDEFGHijklmn12', member: 'lucas', ttl: 3600 }], verified: w.root });
  await w.msg(5005, '/start');
  assert.match(w.lastText(), /본인 연결 링크/);
  await w.msg(5005, '/start wrongcode1234567');
  assert.match(w.lastText(), /만료된 연결 링크/);
  await w.msg(5005, '/start ABCDEFGHijklmn12');
  const sent = w.tg.filter((c) => c.method === 'sendMessage').slice(-4).map((c) => c.body.text);
  assert.match(sent[0], /연결 완료 — 루카스님/);
  assert.match(sent[1], /루카스님의 미션/);
  assert.match(sent[2], /루카스님, 이렇게 써요/);
  assert.match(sent[3], /Choose your language/);
  assert.equal(w.kv.get('chat:5005'), 'lucas');
  assert.equal(w.kv.get('member:lucas'), '5005');
  assert.equal(w.kv.has('code:ABCDEFGHijklmn12'), false);
  assert.ok(!w.gh.some((c) => c.path.endsWith('/dispatches')), '저장소 주인 토큰으로 Actions 를 부르지 않음');
  await w.msg(6006, '/start ABCDEFGHijklmn12');
  assert.match(w.lastText(), /만료된 연결 링크/, '쓴 코드는 다시 못 씀');
  await w.msg(5005, '/start ABCDEFGHijklmn12');
  assert.match(w.lastText(), /이미 <b>루카스<\/b>님으로 연결돼 있어요/, '연결된 대화에서 링크를 다시 누르면 안내만');
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

test('워커 이름봇: 본인은 ✅ 버튼, 남은 주기/요청 버튼, 팀 현황(연결 여부), 단체방은 무시, 확인 상태 없으면 정직하게 답함', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.root });
  await w.msg(1002, '민호봇');
  assert.match(w.lastText(), /민호님의 미션[\s\S]*1️⃣ 로그인 UI 개발[\s\S]*✅ 번호/);
  assert.deepEqual(datas(w.lastMarkup()), ['c:M-0001', 'c:M-0002', 'v:minho']);
  await w.msg(1002, '창민봇');
  assert.match(w.lastText(), /창민님에게 미션을 줄 수 있어요/);
  assert.deepEqual(datas(w.lastMarkup()), ['s:changmin', 'v:changmin']);
  await w.msg(1004, '민호봇');
  assert.match(w.lastText(), /민호님에게 미션을 요청할 수 있어요/);
  await w.msg(1004, '📋 팀 현황');
  assert.match(w.lastText(), /<b>민호<\/b> — 남은 2 · 완료 0\n[\s\S]*<b>루카스<\/b> — 남은 0 · 완료 0 · <i>텔레그램 미연결<\/i>/);
  const before = w.tg.length;
  await w.hook({ update_id: 999, message: { chat: { id: -100, type: 'group' }, from: { id: 1002 }, text: '민호봇' } });
  assert.equal(w.tg.length, before);
  w.kv.delete('verified');
  await w.msg(1002, '민호봇');
  assert.match(w.lastText(), /확인 상태를 아직 받지 못했어요/);
});

test('워커 미션 주기: 확인 버튼 뒤 확인한 커밋 위에만 저장(준 사람 기록), 두 번 누르면 이미 처리, 다른 대화의 버튼은 무시', async () => {
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
  assert.match(w.toast(), /이미 처리했거나 만료/);
  await w.msg(1004, '루카스 이거 해줘');
  assert.match(w.lastText(), /팀원끼리는/);
  await w.msg(1002, '유리 회의록');
  await w.tap(1004, w.askData(), 1004); // 다른 대화에서 누른 버튼
  assert.ok(!w.dbAtHead().missions.some((m) => m.title === '회의록'));
  assert.equal(w.state.botCommits, 1);
});

test('워커 요청·수락: 팀원 요청 → 관리자에게 [수락][거절] 알림 → 수락하면 미션, 요청한 사람에게 결과, 버튼은 메시지에서 빠짐', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho', 1004: 'nathan' }, codes: [], verified: w.root });
  await w.msg(1004, '민호봇');
  await w.tap(1004, 's:minho'); // 📨 미션 요청
  assert.match(w.lastText(), /<b>민호<\/b>님에게 요청할 미션을 이 대화에 적어/);
  await w.msg(1004, '리뷰 부탁해요\nPR 확인');
  assert.match(w.lastText(), /<b>민호<\/b>님에게 이 미션을 요청할까요\?[\s\S]*• 리뷰 부탁해요 PR 확인/);
  await w.tap(1004, w.askData());
  const req = w.dbAtHead().missions.find((m) => m.status === 'requested');
  assert.deepEqual([req.assignee, req.createdBy, req.title], ['minho', 'nathan', '리뷰 부탁해요 PR 확인']);
  const notice = w.tg.filter((c) => c.method === 'sendMessage' && c.body.chat_id === '1002').at(-1);
  assert.match(notice.body.text, /미션 요청이 왔어요[\s\S]*네이뜬님이 보냈어요/);
  assert.deepEqual(datas(notice.body.reply_markup), [`a:${req.id}`, `n:${req.id}`]);
  // Actions 확인 전이라도 봇이 만든 커밋 위라서 바로 수락 가능(연달아 누르기)
  await w.tap(1002, `a:${req.id}`, 1002, notice.body.reply_markup);
  assert.equal(w.dbAtHead().missions.find((m) => m.id === req.id).status, 'todo');
  assert.equal(w.state.botCommits, 2);
  assert.deepEqual(w.tg.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).body.reply_markup, { inline_keyboard: [] }, '처리한 요청 버튼은 뺌');
  const toNathan = w.tg.filter((c) => c.method === 'sendMessage' && c.body.chat_id === '1004').at(-1);
  assert.match(toNathan.body.text, /민호님이 미션 요청을 수락했어요/);
  await w.tap(1002, `a:${req.id}`);
  assert.match(w.toast(), /이미 처리한 요청/);
});

test('워커 ✅ 완료·언어: 버튼으로 완료(확인 한 번 더), 🌐 English 를 고르면 저장되고 그 뒤 화면이 영어', async () => {
  const w = world();
  await w.importer({ owners: { 1002: 'minho' }, codes: [], verified: w.root });
  await w.tap(1002, 'c:M-0002');
  assert.match(w.lastText(), /완료할까요\?\n• \[M-0002\] 파일 다운로드 API 테스트/);
  await w.tap(1002, w.askData());
  assert.equal(w.dbAtHead().missions.find((m) => m.id === 'M-0002').status, 'done');
  await w.msg(1002, '🌐 언어');
  assert.deepEqual(datas(w.lastMarkup()), ['l:ko', 'l:en', 'l:zh']);
  await w.tap(1002, 'l:en');
  assert.equal(w.dbAtHead().langs.minho, 'en');
  assert.match(w.lastText(), /English from now on[\s\S]*Minho, here's how it works/);
  await w.msg(1002, 'Minho bot');
  assert.match(w.lastText(), /👤 <b>Minho's missions<\/b>[\s\S]*📌 1 mission left/);
});

test('워커: main 에 확인 안 된 변경이 있거나, 확인과 저장 사이에 끼어들거나, 확인 전 변경을 되돌린 push 위에는 저장하지 않음', async () => {
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
  // ③ 봇 저장 뒤(확인 전) 팀원이 그 저장을 되돌린 push(내용은 확인된 상태와 같음) → 봇은 그 위에 저장하지 않음
  const c = world();
  await c.importer({ owners: { 1002: 'minho' }, codes: [], verified: c.root });
  await c.msg(1002, '루카스 주말 당직');
  await c.tap(1002, c.askData());
  assert.equal(c.state.botCommits, 1);
  c.pushMain({ [DB_FILE]: c.commits.get(c.root).files[DB_FILE] });
  await c.msg(1002, '루카스 다른 일');
  await c.tap(1002, c.askData());
  assert.match(c.lastText(), /❌ 저장하지 못했어요: main 에 아직 확인되지 않은 변경/);
  assert.equal(c.state.botCommits, 1);
  // Actions 가 확인한 뒤에는 정상
  await c.verify();
  await c.msg(1002, '루카스 다른 일');
  await c.tap(1002, c.askData());
  assert.equal(c.state.botCommits, 2);
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

test('notify 중계 모드: 워커가 미연결이면 보류, 워커 실패(4xx)면 "🆕" 줄 없이 다시, ✅ 버튼도 함께 넘김', async () => {
  const db0 = { nextId: 1, missions: [] };
  const files = (db) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members: M }) });
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const db1 = JSON.parse(JSON.stringify(db0));
  setMissions(db1, '민호', parseMissionList('1. A\n2. B'), 'changmin', M, T);
  setMissions(db1, '루카스', parseMissionList('1. L'), 'changmin', M, T);
  const c1 = git.add(files(db1));
  const sent = [];
  const relay = async (member, text, extra) => {
    if (member === 'lucas') return { status: 'unconnected' };
    if (text.includes('🆕')) throw Object.assign(new Error('Bad Request: message is too long'), { code: 400 });
    sent.push({ member, text, extra });
    return { status: 'sent', messageId: 7 };
  };
  const ledger = { verifiedSha: c0, owner: 'changmin', members: {}, alerts: [], flagged: [], notices: [] };
  const r = await runNotify({ env: { EVENT_NAME: 'push', BEFORE_SHA: c0, AFTER_SHA: c1, ACTOR: 'darrenpual', GITHUB_REPOSITORY_OWNER: 'newcode135-prog' }, git, gh: { pushes: async () => new Map([[c1, 'darrenpual']]), isRepoAdmin: async () => false }, relay, ledger, now: () => T });
  assert.deepEqual(r.results.map((x) => [x.member, x.status]).sort(), [['lucas', 'unconnected'], ['minho', 'sent']]);
  assert.ok(!sent[0].text.includes('🆕'), '4xx 면 기본 목록으로');
  assert.deepEqual(datas(sent[0].extra.reply_markup), ['c:M-0001', 'c:M-0002', 'v:minho']);
  assert.equal(ledger.members.lucas.pending, true);
});
