// 텔레그램 언어 선택(한국어·English·中文): 문구표, 사람마다 고른 언어로 봇 화면·Actions 알림, 본인 것만 바꾸기.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMissions, completeMissions, requestMissions, validateDb, setLang, langOf, renderTelegram, renderDoneNotice, menuKeyboard, menuText,
  boardText, boardKeyboard, listKeyboard, teamText, sentText, requestNotice, respondNotice, decide, decideCallback, confirmText, resultText,
  composePrompt, langKeyboard, pendingRequests, tr, dn, guessLang, LANGS, resolveRefs,
} from '../mimic-note/lib.mjs';
import { processUpdates } from '../mimic-note/telegram.mjs';
import { runNotify, verifyChange } from '../mimic-note/notify.mjs';
import { fakeGit, fakeTelegram, DB_FILE, MEMBERS_FILE } from './mimic-note-fakes.js';

const T = '2026-11-13T00:00:00.000Z';
const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const [, MINHO, , NATHAN, LUCAS] = M;
const empty = () => ({ nextId: 1, missions: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const it = (...titles) => titles.map((title) => ({ title, detail: '' }));

test('문구표: 세 언어 모두 같은 키·같은 인자 수(빠진 번역 없음), 없는 키·언어는 한국어로', async () => {
  const src = await import('../mimic-note/i18n.mjs');
  const koKeys = Object.keys(tr('ko'));
  assert.ok(koKeys.length > 90);
  for (const l of ['en', 'zh']) {
    for (const k of koKeys) {
      if (k === 'langPrompt') continue; // 세 언어가 한 줄에 같이 있는 문구
      const a = tr('ko')[k];
      const b = tr(l)[k];
      assert.equal(typeof b, typeof a, `${l}.${k}`);
      if (typeof a === 'function') assert.equal(b.length, a.length, `${l}.${k} 인자 수`);
      if (typeof a === 'string') assert.notEqual(b, a, `${l}.${k} 번역 안 됨`);
    }
  }
  assert.equal(tr('fr').refresh, '🔄 새로고침');
  assert.deepEqual(LANGS, ['ko', 'en', 'zh']);
  assert.deepEqual([guessLang('en-US'), guessLang('zh-hans'), guessLang('ko'), guessLang(undefined), guessLang('ja')], ['en', 'zh', 'ko', 'ko', 'ko']);
  assert.deepEqual([dn(NATHAN, 'ko'), dn(NATHAN, 'en'), dn(NATHAN, 'zh')], ['네이뜬', 'Nathan', 'Nathan']);
  assert.ok(src.LANG_NAMES.zh === '中文');
});

test('언어 고르기: 본인 것만, 한국어로 돌아가면 기록 삭제, 같은 언어면 변경 없음, 검사(명부에 없는 사람·없는 언어)', () => {
  const db = empty();
  assert.equal(langOf(db, 'nathan'), 'ko');
  assert.deepEqual(setLang(db, 'nathan', 'en', 'nathan'), { changed: true });
  assert.deepEqual([langOf(db, 'nathan'), db.langs], ['en', { nathan: 'en' }]);
  assert.deepEqual(setLang(db, 'nathan', 'en', 'nathan'), { changed: false });
  assert.throws(() => setLang(db, 'lucas', 'zh', 'nathan'), /본인 것만/);
  assert.throws(() => setLang(db, 'nathan', 'fr', 'nathan'), /지원하지 않는 언어/);
  setLang(db, 'nathan', 'ko', 'nathan');
  assert.equal('langs' in db, false, '모두 한국어면 langs 자체를 지움');
  assert.deepEqual(validateDb({ ...empty(), langs: { nathan: 'zh' } }, M), []);
  assert.equal(validateDb({ ...empty(), langs: { ghost: 'en', nathan: 'fr' } }, M).length, 2);
  assert.equal(validateDb({ ...empty(), langs: ['en'] }, M).length, 1);
});

test('영어·중국어 화면: 목록·이름봇·버튼판·팀 현황·보낸 미션·요청 알림이 그 사람 언어로(미션 제목은 그대로, 이름은 영문 아이디)', () => {
  const db = empty();
  addMissions(db, 'nathan', it('개발 환경 설치', '첫 커밋'), 'minho', M, {}, T);
  requestMissions(db, 'minho', it('리뷰 부탁'), 'nathan', M, T);
  setLang(db, 'nathan', 'en', 'nathan');
  setLang(db, 'minho', 'zh', 'minho');
  const en = renderTelegram(NATHAN, db);
  assert.match(en, /👤 <b>Nathan's missions<\/b>\n\n1️⃣ 개발 환경 설치/);
  assert.match(en, /📊 Progress 0\/2\n📌 2 missions left$/);
  assert.match(renderTelegram(NATHAN, db, { justAdded: [{ title: '첫 커밋', by: 'Minho' }] }), /🆕 New mission: 첫 커밋 \(from Minho\)/);
  assert.match(renderTelegram(MINHO, db), /👤 <b>Minho 的任务<\/b>[\s\S]*🎉 没有剩余任务！/);
  assert.match(renderTelegram(NATHAN, db, { lang: 'ko' }), /네이뜬님의 미션/, 'lang 을 주면 그 언어로');
  // 버튼판·메뉴
  assert.deepEqual(menuKeyboard(M, 'en').keyboard.at(-1).map((b) => b.text), ['📋 Team', '📤 Sent', '🌐 Language']);
  assert.equal(menuKeyboard(M, 'zh').keyboard[0][1].text, 'Minho 机器人');
  assert.match(menuText(NATHAN, M, { lang: 'en' }), /Nathan, here's how it works[\s\S]*to admins \(Changmin, Minho, Yuri\): <b>📨 Request mission<\/b>/);
  assert.match(menuText(MINHO, M, { lang: 'zh' }), /Minho，使用方法[\s\S]*📨 分配任务/);
  assert.deepEqual(langKeyboard().inline_keyboard[0].map((b) => [b.text, b.callback_data]), [['한국어', 'l:ko'], ['English', 'l:en'], ['中文', 'l:zh']]);
  // 이름봇(보는 사람의 언어)
  assert.match(boardText(NATHAN, MINHO, db, M), /Minho's missions[\s\S]*request a mission from Minho/, '네이뜬(영어)이 민호 화면을 보면 영어');
  assert.match(boardText(MINHO, MINHO, db, M), /📨 <b>收到 1 个请求<\/b>[\s\S]*请求 1\. 리뷰 부탁 — 来自 Nathan/);
  assert.deepEqual(boardKeyboard(MINHO, MINHO, db).inline_keyboard.flat().map((b) => b.text), ['✅ 接受请求 1', '❌ 拒绝请求 1', '🔄 刷新']);
  assert.equal(boardKeyboard(NATHAN, MINHO, db).inline_keyboard[0][0].text, '📨 Request a mission from Minho');
  assert.equal(listKeyboard(db, 'nathan').inline_keyboard.at(-1)[0].text, '🔄 Refresh', 'Actions 목록 버튼도 그 사람 언어');
  assert.match(boardText(NATHAN, LUCAS, db, M), /👀 View only\. Members can't give each other missions/);
  assert.match(teamText(M, db, new Set(['minho']), 'en'), /• <b>Minho<\/b> — 0 left · 0 done · 📨 1 request\n[\s\S]*<b>Nathan<\/b> — 2 left · 0 done · <i>Telegram not linked<\/i>/);
  assert.match(sentText(NATHAN, M, db), /📤 <b>Sent missions<\/b>[\s\S]*⏳ Waiting for acceptance 1<\/b>\n• Minho — 리뷰 부탁/);
  // 요청·결과 알림(받는 사람의 언어)
  const req = pendingRequests(db, 'minho')[0];
  const n = requestNotice(NATHAN, [req], langOf(db, 'minho'));
  assert.match(n.text, /📨 <b>收到任务请求<\/b>\n\nNathan 发来：\n1\. 리뷰 부탁/);
  assert.deepEqual(n.reply_markup.inline_keyboard[0].map((b) => b.text), ['✅ 接受 1', '❌ 拒绝 1']);
  assert.match(respondNotice(req, true, MINHO, MINHO, 'en'), /✅ <b>Minho accepted your mission request<\/b>\n• 리뷰 부탁\n\nIt's now Minho's mission/);
  assert.match(composePrompt(MINHO, 'request', 'en'), /Type the mission to request from <b>Minho<\/b>/);
  assert.match(confirmText({ action: 'request', target: MINHO, items: it('리뷰 부탁') }, [], 'zh'), /📨 要向 <b>Minho<\/b> 请求以下任务吗？/);
  assert.match(resultText('add', 'Lucas', { result: { added: [{ id: 'M-0009', title: 'X' }], skipped: [] } }, 'en'), /✅ Sent to Lucas:\n• \[M-0009\] X\n\nLucas will get a Telegram notice shortly\./);
});

test('봇 판단: 세 언어의 버튼·명령을 모두 알아듣고, 안내는 보낸 사람 언어로', () => {
  const chatOwners = new Map([['1002', 'minho'], ['1004', 'nathan']]);
  const d = (id, text, lang = 'en', compose = null) => decide({ chat: { id, type: 'private' }, text }, { members: M, chatOwners, compose, lang });
  assert.deepEqual([d(1004, 'Minho bot').kind, d(1004, 'Minho bot').member.id], ['board', 'minho']);
  assert.equal(d(1004, 'Lucas 机器人').member.id, 'lucas');
  assert.equal(d(1004, '민호봇').member.id, 'minho', '언어를 바꾼 직후 예전 버튼도');
  assert.deepEqual([d(1004, '📋 Team').kind, d(1004, '📤 我发出的').kind, d(1004, '🌐 Language').kind, d(1004, '🌐 언어').kind, d(1004, '/lang').kind], ['team', 'sent', 'lang-menu', 'lang-menu', 'lang-menu']);
  assert.equal(d(1004, 'my missions').member.id, 'nathan');
  const done = d(1004, 'Nathan mission done 2');
  assert.deepEqual([done.kind, done.action, done.refs], ['act', 'done', ['2']]);
  assert.deepEqual([d(1002, 'Lucas 任务完成 1').action, d(1002, 'lucas mission set\n1. A\n2. B').action, d(1002, 'lucas mission add fix login').items[0].title], ['done', 'set', 'fix login']);
  assert.deepEqual([d(1002, 'Lucas complete the report').action, d(1002, 'Lucas complete the report').items[0].title], ['add', 'complete the report'], '"mission" 없는 영어 낱말은 그냥 미션 내용');
  assert.equal(d(1004, 'Minho please review my PR').action, 'request');
  assert.match(d(1004, 'Lucas do this').text, /Members can't give each other missions/);
  assert.match(d(1004, 'Lucas do this', 'zh').text, /成员之间不能互相分配任务/);
  assert.match(d(1004, 'Nathan mission done').error, /Add the number to complete, e\.g\. Nathan mission done 2/);
  assert.equal(d(1004, 'cancel', 'en', { target: MINHO }).kind, 'cancel');
  assert.equal(d(1004, '取消', 'zh', { target: MINHO }).kind, 'cancel');
  assert.equal(d(1004, 'menu').kind, 'menu');
  const cb = (data, viewer) => decideCallback(data, { viewer, members: M, db: empty() });
  assert.deepEqual(cb('l:zh', NATHAN), { kind: 'lang', lang: 'zh' });
  assert.equal(cb('l:fr', NATHAN).kind, 'stale');
  assert.equal(cb('l:en', null).kind, 'stale', '연결 전에는 저장할 수 없음');
  assert.equal(decideCallback('c:M-0001', { viewer: NATHAN, members: M, db: { nextId: 1, missions: [], langs: { nathan: 'en' } } }).text, 'That mission no longer exists.');
});

const files = (db, members = M) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members }) });
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_REPOSITORY_OWNER: 'newcode135-prog', TELEGRAM_CHAT_ID_CHANGMIN: '1001', TELEGRAM_CHAT_ID_MINHO: '1002', TELEGRAM_CHAT_ID_YURI: '1003', TELEGRAM_CHAT_ID_NATHAN: '1004', TELEGRAM_CHAT_ID_LUCAS: '1005' };
const ghOf = (pushes) => ({ pushes: async () => new Map(Object.entries(pushes)), isRepoAdmin: async (l) => l === 'newcode135-prog' });
const pushEnv = (before, after, actor) => ({ ...ENV, EVENT_NAME: 'push', BEFORE_SHA: before, AFTER_SHA: after, ACTOR: actor });

test('Actions 알림: 각자 고른 언어로(새 미션·버튼·완료 알림), 언어를 바꾸면 그 언어로 목록을 다시 보냄, 팀원은 남의 언어를 못 바꿈', async () => {
  const db0 = empty();
  setLang(db0, 'nathan', 'en', 'nathan');
  const git = fakeGit([files(db0)]);
  const c0 = git.head();
  const tg = fakeTelegram();
  const ledger = { verifiedSha: c0, owner: 'changmin', members: {}, alerts: [], flagged: [] };
  const run = (b, a, actor = 'newcode135-prog') => runNotify({ env: pushEnv(b, a, actor), git, gh: ghOf({ [a]: actor }), send: tg.send, ledger, now: () => T });
  // 민호(한국어)가 네이뜬(영어)에게 미션
  const db1 = clone(db0);
  addMissions(db1, 'nathan', it('개발 환경 설치'), 'minho', M, {}, T);
  const c1 = git.add(files(db1));
  await run(c0, c1);
  const toNathan = tg.sent.at(-1);
  assert.equal(toNathan.chatId, '1004');
  assert.match(toNathan.text, /🆕 New mission: 개발 환경 설치 \(from Minho\)[\s\S]*Nathan's missions/);
  assert.equal(toNathan.extra.reply_markup.inline_keyboard.at(-1)[0].text, '🔄 Refresh');
  // 네이뜬이 완료 → 민호(한국어)에게 한국어 완료 알림
  const db2 = clone(db1);
  completeMissions(db2, 'nathan', ['1'], { by: 'nathan', members: M }, T);
  const c2 = git.add(files(db2));
  await run(c1, c2);
  const toMinho = tg.sent.find((s) => s.chatId === '1002');
  assert.match(toMinho.text, /✅ <b>MIMIC NOTE 완료 알림<\/b>\n\n👤 네이뜬님이 미션을 완료했어요/);
  // 민호가 중국어로 바꾸면(봇 저장) 민호 목록이 중국어로 다시 감
  const db3 = clone(db2);
  setLang(db3, 'minho', 'zh', 'minho');
  const c3 = git.add(files(db3));
  const r3 = await run(c2, c3);
  assert.deepEqual(r3.results.map((x) => [x.member, x.status]), [['minho', 'sent']]);
  assert.match(tg.sent.at(-1).text, /Minho 的任务/);
  // 팀원이 직접 push 로 남의 언어를 바꾸면 권한 없는 변경
  const base = { db: db3, members: M };
  const head = { db: { ...clone(db3), langs: { ...db3.langs, lucas: 'zh' } }, members: M };
  assert.match(verifyChange({ base, head, actor: 'nathan-gh' }).join(' '), /lucas 의 텔레그램 언어 변경\(본인 것만\)/);
  assert.deepEqual(verifyChange({ base, head: { db: { ...clone(db3), langs: { ...db3.langs, nathan: 'zh' } }, members: M }, actor: 'nathan-gh' }), [], '본인 것은 됨');
  assert.deepEqual(verifyChange({ base, head, actor: 'newcode135-prog' }), [], '관리자는 됨');
});

test('리뷰 회귀: 중국어 보통 문장은 명령이 아니다(任务设置页面…), 완료 번호는 、，로도, 못 찾으면 그 사람 언어로', () => {
  const chatOwners = new Map([['1002', 'minho'], ['1005', 'lucas']]);
  const d = (id, text, lang = 'zh') => decide({ chat: { id, type: 'private' }, text }, { members: M, chatOwners, lang });
  const plain = (t) => { const r = d(1002, t); return [r.action, r.items?.[0]?.title]; };
  assert.deepEqual(plain('Lucas 任务设置页面有问题，帮忙看一下'), ['add', '任务设置页面有问题，帮忙看一下'], '목록 바꾸기(set)로 읽지 않음');
  assert.deepEqual(plain('Lucas 任务添加功能有bug'), ['add', '任务添加功能有bug'], '제목을 자르지 않음');
  assert.deepEqual(plain('Lucas 任务完成后告诉我'), ['add', '任务完成后告诉我']);
  assert.equal(d(1005, 'Minho 任务设置页面有问题').action, 'request', '팀원은 거절 대신 요청');
  assert.deepEqual([d(1002, 'Lucas 任务完成 2、3').refs, d(1002, 'Lucas 任务完成 2，3').refs, d(1002, 'Lucas mission done 2, 3', 'en').refs], [['2', '3'], ['2', '3'], ['2', '3']]);
  assert.deepEqual([d(1002, 'Lucas 任务设置\n1. A\n2. B').action, d(1002, 'Lucas 任务添加 修复登录').items[0].title], ['set', '修复登录']);
  const db = empty();
  addMissions(db, 'lucas', it('A'), 'minho', M, {}, T);
  let err;
  try { resolveRefs(db, 'lucas', ['9']); } catch (e) { err = e; }
  assert.match(err.message, /미션을 찾지 못했어요: 9 \(남은 미션 번호: 1\)/, '한국어 문구는 그대로');
  assert.deepEqual([tr('en').notFound(err.ref, err.left), tr('zh').notFound('9', '')], ["Couldn't find mission 9 (remaining numbers: 1)", '找不到任务：9（剩余编号：无）']);
});

test('리뷰 회귀: 영어 단수·복수, 여러 개에도 맞는 머리말, 연결 안내도 그 사람 언어로', () => {
  const db = empty();
  addMissions(db, 'nathan', it('A', 'B', 'C', 'D'), 'minho', M, {}, T);
  requestMissions(db, 'minho', it('R'), 'nathan', M, T);
  const en = renderTelegram(NATHAN, db, { lang: 'en' });
  assert.match(en, /➕ 1 more mission \(tap to expand\)/);
  assert.match(en, /📌 4 missions left$/);
  assert.match(renderTelegram(LUCAS, db, { lang: 'en' }), /📌 0 missions left$/);
  completeMissions(db, 'nathan', ['1', '2', '3'], { by: 'nathan', members: M }, T);
  assert.match(renderTelegram(NATHAN, db, { lang: 'en' }), /📌 1 mission left$/);
  assert.match(boardText(MINHO, MINHO, db, M, 'en'), /📨 <b>1 request received<\/b> \(accepting makes it your mission\)/);
  assert.match(teamText(M, db, null, 'en'), /<b>Minho<\/b> — 0 left · 0 done · 📨 1 request\n/);
  assert.match(renderDoneNotice(NATHAN, ['A', 'B'], db, M, 'en'), /👤 Nathan completed:\n• A\n• B/);
  assert.match(confirmText({ action: 'add', target: LUCAS, items: it('A', 'B') }, [], 'en'), /^📝 Give <b>Lucas<\/b> the following\?\n• A\n• B/);
  assert.match(confirmText({ action: 'add', target: LUCAS, items: it('A', 'B') }, [], 'zh'), /^📝 要把以下任务分配给 <b>Lucas<\/b> 吗？/);
  // 연결 안내: 문구 키를 달아 봇이 그 사람 언어로 보낸다(CLI 연결은 한국어 text 그대로)
  const r = processUpdates([{ message: { chat: { id: 7, type: 'private' }, text: '/start' } }], { codes: {}, chatOwners: new Map(), now: 0 });
  assert.equal(r.replies[0].key, 'linkNeedCode');
  assert.match(r.replies[0].text, /본인 연결 링크/);
  assert.match(tr('en')[r.replies[0].key], /personal link/);
});

test('완료 알림은 받는 사람(미션을 준 사람)의 언어로', () => {
  const db = empty();
  addMissions(db, 'nathan', it('A'), 'minho', M, {}, T);
  completeMissions(db, 'nathan', ['1'], { by: 'minho', members: M }, T);
  assert.match(renderDoneNotice(NATHAN, [{ title: 'A', doneBy: 'minho' }], db, M, 'en'), /✅ <b>MIMIC NOTE — mission completed<\/b>\n\n👤 Nathan completed:\n• A \(marked done by Minho\)\n\n📊 Nathan's progress 1\/1 · 0 left/);
  assert.match(renderDoneNotice(NATHAN, ['A'], db, M, 'zh'), /👤 Nathan 完成了任务\n• A\n\n📊 Nathan 的进度 1\/1 · 剩余 0 个/);
});
