// 아침 요약: 평일 9~12시(한국)에 사람마다 하루 한 번, 남은 미션·받은 요청이 있으면 그 사람 언어로 + ✅ 버튼.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMissions, requestMissions, setLang, digestText } from '../mimic-note/lib.mjs';
import { runNotify, dispatchInputs } from '../mimic-note/notify.mjs';
import { fakeGit, fakeTelegram, DB_FILE, MEMBERS_FILE } from './mimic-note-fakes.js';

const M = [
  { id: 'changmin', name: '창민', role: 'owner', github: 'darrenpual' },
  { id: 'minho', name: '민호', role: 'admin', github: 'newcode135-prog' },
  { id: 'yuri', name: '유리', role: 'admin', github: 'emileepark5281-cmd' },
  { id: 'nathan', name: '네이뜬', role: 'member', github: 'nathan-gh' },
  { id: 'lucas', name: '루카스', role: 'member', github: null },
];
const T0 = '2026-11-15T00:00:00.000Z';
// 2026-11-16 은 월요일. 한국 시간 = UTC + 9
const MON_0905 = '2026-11-16T00:05:00.000Z';
const MON_1130 = '2026-11-16T02:30:00.000Z';
const MON_1300 = '2026-11-16T04:00:00.000Z';
const TUE_0910 = '2026-11-17T00:10:00.000Z';
const SAT_0905 = '2026-11-21T00:05:00.000Z';
const ENV = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_REPOSITORY_OWNER: 'newcode135-prog', TELEGRAM_CHAT_ID_CHANGMIN: '1001', TELEGRAM_CHAT_ID_MINHO: '1002', TELEGRAM_CHAT_ID_NATHAN: '1004' };
const files = (db) => ({ [DB_FILE]: JSON.stringify(db), [MEMBERS_FILE]: JSON.stringify({ members: M }) });
const it = (...titles) => titles.map((title) => ({ title, detail: '' }));

function world() {
  const db = { nextId: 1, missions: [] };
  addMissions(db, 'minho', it('로그인 UI', '모바일 검수'), 'changmin', M, {}, T0);
  addMissions(db, 'nathan', it('개발 환경 설치'), 'minho', M, {}, T0);
  requestMissions(db, 'yuri', it('리뷰 부탁'), 'nathan', M, T0); // 유리: 남은 미션 없음, 받은 요청 1
  setLang(db, 'nathan', 'en', 'nathan');
  const git = fakeGit([files(db)]);
  const ledger = { verifiedSha: git.head(), owner: 'changmin', members: {}, alerts: [], flagged: [] };
  const tg = fakeTelegram();
  const run = (now, env = {}) => runNotify({ env: { ...ENV, EVENT_NAME: 'schedule', ...env }, git, gh: { pushes: async () => new Map(), isRepoAdmin: async () => false }, send: tg.send, ledger, now: () => now });
  return { db, git, ledger, tg, run };
}
const digests = (r) => r.results.filter((x) => x.kind === 'digest').map((x) => [x.member, x.status]);

test('아침 요약: 평일 9~12시에 남은 미션·받은 요청이 있는 사람에게만, 그 사람 언어로 + ✅ 버튼, 하루 한 번', async () => {
  const w = world();
  const r1 = await w.run(MON_0905);
  assert.deepEqual(digests(r1), [['minho', 'sent'], ['nathan', 'sent']], '창민(미션 없음)은 건너뜀, 유리(요청 1)는 미연결이라 조용히 건너뜀');
  const toMinho = w.tg.sent.find((s) => s.chatId === '1002');
  assert.match(toMinho.text, /^☀️ <b>좋은 아침이에요!<\/b> 오늘 남은 미션 2개\n\n🎯 <b>MIMIC NOTE<\/b>[\s\S]*1️⃣ 로그인 UI/);
  assert.deepEqual(toMinho.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['c:M-0001', 'c:M-0002', 'v:minho']);
  assert.match(w.tg.sent.find((s) => s.chatId === '1004').text, /^☀️ <b>Good morning!<\/b> 1 mission left today[\s\S]*Nathan's missions/);
  assert.deepEqual(digests(await w.run(MON_1130)), [], '같은 날 다시 안 보냄');
  assert.deepEqual(digests(await w.run(TUE_0910)), [['minho', 'sent'], ['nathan', 'sent']], '다음 날 다시');
});

test('아침 요약: 9시 전·12시 이후·주말에는 안 보냄, 놓친 날 12시 전 첫 실행이 보냄', async () => {
  const w = world();
  assert.deepEqual(digests(await w.run('2026-11-15T23:50:00.000Z')), [], '월요일 8시 50분');
  assert.deepEqual(digests(await w.run(MON_1300)), [], '오후 1시');
  assert.deepEqual(digests(await w.run(SAT_0905)), [], '토요일');
  assert.deepEqual(digests(await w.run(MON_1130)), [['minho', 'sent'], ['nathan', 'sent']], '9시 정기 실행이 빠져도 11시 반 실행이 보냄');
});

test('아침 요약: 발송 실패는 같은 시간대 다음 실행에서 다시, 받은 요청이 있는 관리자에게는 요청 수 안내', async () => {
  const w = world();
  w.tg.send = (() => { const ok = w.tg.send; let first = true; return async (token, chatId, text, extra) => { if (chatId === '1002' && first) { first = false; throw Object.assign(new Error('네트워크'), { code: 'network' }); } return ok(token, chatId, text, extra); }; })();
  const r1 = await w.run(MON_0905, { TELEGRAM_CHAT_ID_YURI: '1003' });
  assert.deepEqual(digests(r1).sort(), [['minho', 'failed'], ['nathan', 'sent'], ['yuri', 'sent']]);
  assert.match(w.tg.sent.find((s) => s.chatId === '1003').text, /오늘 남은 미션 0개[\s\S]*📨 수락을 기다리는 요청 1개/);
  assert.deepEqual(digests(await w.run('2026-11-16T00:15:00.000Z', { TELEGRAM_CHAT_ID_YURI: '1003' })), [['minho', 'sent']], '실패한 사람만 다시');
});

test('아침 요약 시험 실행(digest=true): 시간과 상관없이, member 를 주면 그 사람만, 같은 날이어도 다시', async () => {
  const w = world();
  assert.deepEqual(digests(await w.run(MON_1300, { EVENT_NAME: 'workflow_dispatch', INPUT_DIGEST: 'true', INPUT_MEMBER: '민호' })), [['minho', 'sent']]);
  assert.deepEqual(digests(await w.run(MON_1300, { EVENT_NAME: 'workflow_dispatch', INPUT_DIGEST: 'true', INPUT_MEMBER: '민호' })), [['minho', 'sent']]);
  assert.deepEqual(digests(await w.run(MON_1300, { EVENT_NAME: 'workflow_dispatch', INPUT_DIGEST: 'true', INPUT_MEMBER: '없는사람' })), []);
  assert.deepEqual(dispatchInputs({ inputs: { member: 'minho', digest: true } }), { member: 'minho', force: 'false', digest: 'true' });
  assert.match(digestText(M[1], w.db, 'zh'), /^☀️ <b>早上好！<\/b>今天还有 2 个任务/);
});
