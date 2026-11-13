#!/usr/bin/env node
// 코어 오브 미믹노트 — 텔레그램 봇. 대화창 아래에 [창민봇][민호봇][유리봇][네이뜬봇][루카스봇] 버튼이 늘 떠 있고,
// 본인 버튼을 누르면 지금 보고할 미션이 온다(남의 버튼은 거절, 단체방은 무시).
// 미션 명령도 텔레그램에서: "창민 이거 결제해줘"(=미션추가) · "창민 미션설정\n1. …" · "민호 미션완료 2"
//   → [✅ 확인][취소] 를 누르면 GitHub 에 저장 → GitHub Actions 가 받는 사람에게 "🆕 새 미션 … (민호님이 줌)" 등을 보낸다.
// 처음 연결(/start <일회용 코드>)도 처리한다(코드는 이 컴퓨터에서 telegram.mjs connect --no-wait 로 만든 것).
//
//   node mimic-note/bot.mjs                  실행(Ctrl+C 로 종료) — 켜져 있는 동안만 답한다
//   bash mimic-note/bot-install-macmini.sh   맥미니에 상시 실행으로 설치(권장)
//
// 신뢰 규칙
// - 보낸 사람은 텔레그램 연결(일회용 코드로 만든 chat id ↔ 팀원)로만 확인한다. 역할·미션은 GitHub Actions 가 "확인한 상태"
//   (MIMIC_VERIFIED)에서 읽는다 — 확인 안 된 변경(권한 없는 수정 등)은 보여 주지도, 근거로 쓰지도 않는다.
// - 저장은 이 컴퓨터의 gh 계정(저장소 관리자이거나 관리자 팀원)으로 하고, main 에 확인 안 된 변경이 있으면 저장하지 않는다.
// - 같은 봇은 한 컴퓨터에서만 켠다. 토큰·chat id 는 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, ADMIN_ROLES, loadMembers, readEnv, telegramApi, validateDb, validateMembers, parseMissionList, openMissions, addMissions, setMissions, completeMissions , esc, BOT_NAME, menuKeyboard, menuText, missionsText, ownersFromEnv, decide, confirmText, resolveRefs } from './lib.mjs';

export { BOT_NAME, menuKeyboard, menuText, missionsText, ownersFromEnv, decide, confirmText, resolveRefs };
import { renderTelegram } from './notify.mjs';
import { processUpdates, applyLink, loadCodes, secretNames } from './telegram.mjs';
import { mutate } from './mission.mjs';
import { createGithub, DB_FILE, MEMBERS_FILE } from './github.mjs';
import { HOME_DIR } from './passive/compress.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
export const LOCK = () => path.join(HOME_DIR(), 'core-bot.lock');
const PENDING_MS = 10 * 60e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function botRunningHere() {
  try { const { pid } = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); return pid !== process.pid && alive(pid); } catch { return false; }
}

async function main() {
  const token = readEnv(ROOT, process.env).TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 이 없습니다. 먼저 node mimic-note/telegram.mjs connect 로 봇 토큰을 등록하세요.');
  if (botRunningHere()) throw new Error('이 컴퓨터에서 이미 코어 오브 미믹노트 봇이 켜져 있습니다.');
  fs.mkdirSync(HOME_DIR(), { recursive: true });
  fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const unlock = () => { try { if (JSON.parse(fs.readFileSync(LOCK(), 'utf8')).pid === process.pid) fs.unlinkSync(LOCK()); } catch { /* 이미 없음 */ } };
  process.on('exit', unlock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  const github = createGithub();
  const me = await telegramApi(token, 'getMe');
  try {
    if ((await telegramApi(token, 'getMyName')).name !== BOT_NAME) await telegramApi(token, 'setMyName', { name: BOT_NAME });
  } catch (e) { console.log(`봇 이름 바꾸기 실패(나중에 다시): ${e.message}`); }
  await telegramApi(token, 'setMyCommands', { commands: [{ command: 'start', description: '메뉴 열기' }, { command: 'me', description: '내 미션 보기' }] }).catch(() => {});
  if (!secretNames()) console.log('⚠️ 이 컴퓨터의 gh 계정은 GitHub 비밀값을 등록할 수 없어, 봇으로 연결해도 자동 알림 등록은 관리자가 따로 해야 합니다.');
  console.log(`${BOT_NAME} 봇 실행 중: @${me.username} — 이 컴퓨터에서만 켜 두세요(Ctrl+C 로 종료)`);

  // GitHub Actions 가 확인한 상태(커밋)와 그때의 명부·미션. 커밋 내용은 바뀌지 않으므로 커밋별로 기억한다.
  const memo = new Map();
  let verified = { sha: null, at: 0 };
  const verifiedSha = () => {
    if (Date.now() - verified.at > 60e3) verified = { sha: github.verifiedSha(), at: Date.now() };
    if (!verified.sha) throw new Error('GitHub Actions 의 확인 상태를 아직 알 수 없어요');
    return verified.sha;
  };
  const read = (file, sha) => {
    const k = `${file}@${sha}`;
    if (!memo.has(k)) memo.set(k, JSON.parse(github.readFile(file, sha).text));
    return memo.get(k);
  };
  const state = () => {
    const sha = verifiedSha();
    const members = read(MEMBERS_FILE, sha).members;
    const db = read(DB_FILE, sha);
    if (validateMembers(members).length || validateDb(db, members).length) throw new Error('확인된 데이터가 올바르지 않아요');
    return { members, db };
  };

  const send = (chatId, text, extra = {}) => telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const edit = (chatId, messageId, text) => telegramApi(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }).catch(() => send(chatId, text));
  const pending = new Map(); // 확인 대기 중인 미션 명령(10분, 이 프로그램 메모리에만)
  let offset;
  for (;;) {
    let updates;
    try {
      updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] });
    } catch (e) {
      console.log(e.code === 409 ? '다른 곳에서 같은 봇이 업데이트를 받고 있습니다(다른 컴퓨터의 bot.mjs 나 기다리는 connect). 30초 뒤 다시 시도합니다.' : `업데이트 받기 실패: ${e.message}`);
      await sleep(e.code === 409 ? 30000 : 5000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const env = readEnv(ROOT, process.env);
      const chatOwners = ownersFromEnv(env);
      const replyTo = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
      try {
        // 확인 버튼
        if (u.callback_query) {
          const cq = u.callback_query;
          const [act, key] = String(cq.data || '').split(':');
          const p = pending.get(key);
          if (!p || p.chatId !== replyTo || p.fromId !== String(cq.from?.id)) {
            await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: '이미 처리했거나 만료된 버튼이에요.' }).catch(() => {});
            continue;
          }
          pending.delete(key);
          await telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          if (Date.now() - p.at > PENDING_MS) { await edit(replyTo, cq.message.message_id, '확인 시간이 지났어요. 다시 보내 주세요.'); continue; }
          if (act !== 'g') { await edit(replyTo, cq.message.message_id, '취소했어요.'); continue; }
          await edit(replyTo, cq.message.message_id, '저장 중…'); // 버튼을 없애 두 번 눌리지 않게
          try {
            const apply = {
              add: (db, ms, actor) => addMissions(db, p.target.id, p.items, actor.id, ms),
              set: (db, ms, actor) => setMissions(db, p.target.id, p.items, actor.id, ms),
              done: (db, ms, actor) => ({ done: completeMissions(db, p.target.id, p.ids, { by: actor.id, members: ms }), changed: true }),
            }[p.action];
            const label = { add: '미션추가', set: '미션설정', done: '미션완료' }[p.action];
            const w = await mutate(github, apply, (r) => `${p.target.name} ${label}${r.added ? ` ${r.added.length}개` : ''}`, { as: p.owner.id, via: '텔레그램' });
            verified.at = 0; // 다음 버튼은 새 확인 상태를 보게
            const r = w.result;
            const n = esc(p.target.name);
            const out = w.unchanged ? [`변경 없음 — ${n}님에게 이미 그대로 있어요.`]
              : p.action === 'done' ? [`☑️ ${n}님의 미션을 완료했어요`, ...r.done.map((m) => `• [${m.id}] ${esc(m.title)}`)]
                : p.action === 'set' ? [`♻️ ${n}님의 미션을 바꿨어요 — 새 ${r.added.length} · 유지 ${r.kept.length} · 보관 ${r.replaced.length}`]
                  : [`✅ ${n}님에게 미션을 줬어요`, ...r.added.map((m) => `• [${m.id}] ${esc(m.title)}`), ...(r.skipped.length ? [`(이미 있어서 건너뜀: ${r.skipped.map(esc).join(', ')})`] : [])];
            if (!w.unchanged) out.push('', `${n}님에게 곧 텔레그램 알림이 가요.`);
            await edit(replyTo, cq.message.message_id, out.join('\n'));
            console.log(`${new Date().toISOString()} ${p.owner.name} → ${p.target.name} ${label} (${w.commit ? w.commit.slice(0, 7) : '변경 없음'})`);
          } catch (e) {
            await edit(replyTo, cq.message.message_id, `❌ 저장하지 못했어요: ${esc(e.message)}`);
          }
          continue;
        }
        const msg = u.message;
        if (!msg?.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') continue; // 단체방·사진 등은 무시
        const localMembers = loadMembers();
        // 연결 안 된 대화: GitHub 를 부르지 않고 연결 안내만(연결 코드는 처리)
        if (!chatOwners.has(replyTo)) {
          const d0 = decide(msg, { members: localMembers, chatOwners });
          if (d0.kind === 'link') {
            const codes = loadCodes();
            const r = processUpdates([u], { codes, chatOwners, now: Date.now() });
            for (const l of r.links) {
              const { member } = await applyLink(l, { members: localMembers, codes, token });
              await send(l.chatId, menuText(member), { reply_markup: menuKeyboard(localMembers) });
            }
            for (const x of r.replies) await send(x.chatId, esc(x.text));
          } else await send(replyTo, menuText(null), { reply_markup: menuKeyboard(localMembers) });
          continue;
        }
        const { members, db } = state();
        const d = decide(msg, { members, chatOwners });
        if (d.kind === 'ignore' || d.kind === 'link') continue;
        if (d.kind === 'menu') await send(d.chatId, menuText(d.owner), { reply_markup: menuKeyboard(members) });
        else if (d.kind === 'unlinked') await send(d.chatId, menuText(null), { reply_markup: menuKeyboard(members) });
        else if (d.kind === 'deny') await send(d.chatId, `${esc(d.target.name)}봇은 ${esc(d.target.name)}님만 쓸 수 있어요. 본인 버튼(<b>${esc(d.owner.name)}봇</b>)을 누르세요.`);
        else if (d.kind === 'missions') {
          await send(d.chatId, missionsText(d.member, db));
          console.log(`${new Date().toISOString()} ${d.member.name}봇 → 미션 보냄`);
        } else if (d.kind === 'act-denied') {
          await send(d.chatId, d.action === 'done' ? '다른 사람의 미션 완료는 관리자만 할 수 있어요. 본인 미션만 완료하세요.' : `미션 주기·바꾸기는 관리자(${members.filter((m) => ADMIN_ROLES.has(m.role)).map((m) => esc(m.name)).join('·')})만 할 수 있어요.`);
        } else if (d.kind === 'act-error') await send(d.chatId, esc(d.error));
        else if (d.kind === 'act') {
          let picked = [];
          if (d.action === 'done') {
            try { picked = resolveRefs(db, d.target.id, d.refs); } catch (e) { await send(d.chatId, esc(e.message)); continue; }
          }
          const key = crypto.randomBytes(6).toString('base64url');
          for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
          pending.set(key, { action: d.action, chatId: d.chatId, fromId: String(msg.from?.id), owner: d.owner, target: d.target, items: d.items, ids: picked.map((x) => x.id), at: Date.now() });
          await send(d.chatId, confirmText(d, picked), { reply_markup: { inline_keyboard: [[{ text: '✅ 확인', callback_data: `g:${key}` }, { text: '취소', callback_data: `x:${key}` }]] } });
        }
      } catch (e) {
        console.log(`처리 실패: ${e.message}`);
        if (replyTo) await send(replyTo, `지금 처리하지 못했어요(${esc(e.message)}). 잠시 뒤 다시 해 주세요.`).catch(() => {});
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
