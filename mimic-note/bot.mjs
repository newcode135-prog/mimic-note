#!/usr/bin/env node
// 코어 오브 미믹노트 — 텔레그램 미션 앱 봇. 대화창 아래에 [창민봇][민호봇]…[📋 팀 현황][📤 보낸 미션] 버튼이 늘 떠 있다.
// - 본인 이름봇: 내 미션 + [✅ 1][✅ 2]… 완료 버튼(확인 후 저장) · 관리자는 받은 요청 [수락][거절]
// - 다른 사람 이름봇: 그 사람 미션 보기 + [📨 미션 주기](관리자) / [📨 미션 요청](팀원 → 관리자) → 내용을 적으면 확인 후 저장
//   대전제(배정은 관리자만): 팀원이 보낸 것은 '요청'이고, 받은 관리자가 수락해야 미션이 된다. 팀원끼리는 주고받지 않는다.
// - 알림: 새 미션·완료는 GitHub Actions 가 보내고(목록 메시지에도 ✅ 버튼), 요청·수락·거절은 이 봇이 바로 보낸다.
// - 글 명령도 그대로: "창민 이거 결제해줘" · "창민 미션설정\n1. …" · "민호 미션완료 2"
// 처음 연결(/start <일회용 코드>)도 처리한다(코드는 이 컴퓨터에서 telegram.mjs connect --no-wait 로 만든 것).
//
//   node mimic-note/bot.mjs                  실행(Ctrl+C 로 종료) — 켜져 있는 동안만 답한다(버튼도 그때만 동작)
//   bash mimic-note/bot-install-macmini.sh   맥미니에 상시 실행으로 설치(권장)
//
// 신뢰 규칙
// - 보낸 사람은 텔레그램 연결(일회용 코드로 만든 chat id ↔ 팀원)로만 확인한다. 역할·미션은 GitHub Actions 가 "확인한 상태"
//   (MIMIC_VERIFIED)에서 읽는다 — 확인 안 된 변경(권한 없는 수정 등)은 보여 주지도, 근거로 쓰지도 않는다.
//   예외: main 이 이 봇이 이번 실행에서 직접 만든 커밋(확인된 상태 위에서만 저장)이면 Actions 확인 전이라도 이어서 쓴다(연달아 누르기).
//   내용이 아니라 커밋으로 믿으므로, 같은 내용으로 되돌린(revert) 남의 push 는 믿지 않는다.
// - 봇이 꺼져 있는 동안 누른 버튼은 텔레그램이 24시간 보관했다가 봇이 켜지면 처리된다(수락·거절은 그때 바로 저장).
// - 저장은 이 컴퓨터의 gh 계정(저장소 관리자이거나 관리자 팀원)으로 하고, 권한은 누른 팀원의 역할로 본다.
// - 같은 봇은 한 컴퓨터에서만 켠다. 토큰·chat id 는 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  NOTE_DIR, loadMembers, readEnv, telegramApi, validateDb, validateMembers, esc, BOT_NAME, menuKeyboard, menuText, missionsText,
  ownersFromEnv, decide, confirmText, resolveRefs, boardText, boardKeyboard, teamText, sentText, decideCallback, composePrompt,
  requestNotice, respondNotice, respondRequest, ACTIONS, resultText, trustedHead,
} from './lib.mjs';
import { processUpdates, applyLink, loadCodes, secretNames } from './telegram.mjs';
import { mutate } from './mission.mjs';
import { createGithub, DB_FILE, MEMBERS_FILE } from './github.mjs';
import { HOME_DIR } from './passive/compress.mjs';

export { BOT_NAME, menuKeyboard, menuText, missionsText, ownersFromEnv, decide, confirmText, resolveRefs };

const ROOT = path.resolve(NOTE_DIR, '..');
export const LOCK = () => path.join(HOME_DIR(), 'core-bot.lock');
const PENDING_MS = 10 * 60e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function botRunningHere() {
  try { const { pid } = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); return pid !== process.pid && alive(pid); } catch { return false; }
}
// 누른 버튼의 미션만 메시지에서 뺀다(처리한 요청 버튼이 남아 다시 눌리지 않게)
export const withoutMission = (markup, missionId) => ({
  inline_keyboard: (markup?.inline_keyboard || []).map((row) => row.filter((b) => !String(b.callback_data || '').endsWith(`:${missionId}`))).filter((row) => row.length),
});

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
  await telegramApi(token, 'setMyCommands', { commands: [
    { command: 'start', description: '메뉴 열기' }, { command: 'me', description: '내 미션 보기' },
    { command: 'team', description: '팀 현황' }, { command: 'sent', description: '내가 준·요청한 미션' },
  ] }).catch(() => {});
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
    if (!memo.has(k)) {
      if (memo.size > 200) memo.clear();
      const r = github.readFile(file, sha);
      memo.set(k, { json: JSON.parse(r.text), sha: r.sha });
    }
    return memo.get(k);
  };
  const trusted = new Map(); // 이 봇이 이번 실행에서 만든 커밋 → 그 부모(core.mjs trustedHead)
  const blobs = { readFile: (f, ref) => ({ sha: read(f, ref).sha }) };
  const state = async () => {
    let sha = verifiedSha();
    if (trusted.size) {
      // main 이 봇이 방금 만든 커밋이면 그걸 보여 준다(연달아 누르기). 확인이 안 되거나 오류면 확인된 상태로.
      try {
        const h = github.headSha();
        if (h !== sha && await trustedHead(blobs, h, trusted, sha)) sha = h;
      } catch { /* 확인된 상태로 */ }
    }
    const members = read(MEMBERS_FILE, sha).json.members;
    const db = read(DB_FILE, sha).json;
    if (validateMembers(members).length || validateDb(db, members).length) throw new Error('확인된 데이터가 올바르지 않아요');
    return { members, db };
  };
  const save = async (apply, describe, as) => {
    const w = await mutate(github, apply, describe, { as, via: '텔레그램', trusted });
    if (w.commit) {
      trusted.set(w.commit, w.parent);
      if (trusted.size > 50) trusted.delete(trusted.keys().next().value);
    }
    verified.at = 0; // 다음 버튼은 새 확인 상태를 보게
    return w;
  };

  const send = (chatId, text, extra = {}) => telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const edit = (chatId, messageId, text, markup) => telegramApi(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) })
    .catch((e) => (/not modified/i.test(e.message) ? null : send(chatId, text, markup ? { reply_markup: markup } : {})));
  const pending = new Map(); // 확인 대기 중인 저장(10분, 이 프로그램 메모리에만)
  const compose = new Map(); // 📨 버튼을 누르고 미션 내용을 기다리는 대화(10분)
  const busy = new Set(); // 처리 중인 요청(수락·거절 두 번 누름 방지)
  const ask = async (chatId, fromId, d, picked = []) => {
    const key = crypto.randomBytes(6).toString('base64url');
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
    pending.set(key, { action: d.action, chatId, fromId, ownerId: d.owner.id, targetId: d.target.id, targetName: d.target.name, items: d.items, ids: picked.map((x) => x.id), at: Date.now() });
    const yes = { add: '✅ 보내기', request: '📨 요청 보내기', set: '✅ 바꾸기', done: '✅ 완료' }[d.action];
    await send(chatId, confirmText(d, picked), { reply_markup: { inline_keyboard: [[{ text: yes, callback_data: `g:${key}` }, { text: '취소', callback_data: `x:${key}` }]] } });
  };

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
      const chatOf = (memberId) => { for (const [chat, id] of chatOwners) if (id === memberId) return chat; return null; };
      const replyTo = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
      try {
        if (u.callback_query) {
          const cq = u.callback_query;
          const answer = (text) => telegramApi(token, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
          const mid = cq.message?.message_id;
          const data = String(cq.data || '');
          if (cq.message?.chat?.type !== 'private') { await answer(); continue; }
          // 확인·취소: 그 확인을 만든 사람만, 10분 안에, 한 번만
          if (/^[gx]:/.test(data)) {
            const p = pending.get(data.slice(2));
            if (!p || p.chatId !== replyTo || p.fromId !== String(cq.from?.id)) { await answer('이미 처리했거나 만료된 버튼이에요.'); continue; }
            pending.delete(data.slice(2));
            await answer();
            if (Date.now() - p.at > PENDING_MS) { await edit(replyTo, mid, '확인 시간이 지났어요. 다시 보내 주세요.'); continue; }
            if (data[0] !== 'g') { await edit(replyTo, mid, '취소했어요.'); continue; }
            await edit(replyTo, mid, '저장 중…'); // 버튼을 없애 두 번 눌리지 않게
            const spec = ACTIONS[p.action];
            try {
              const w = await save(spec.apply(p), (r) => `${p.targetName} ${spec.label}${r.added ? ` ${r.added.length}개` : ''}`, p.ownerId);
              await edit(replyTo, mid, resultText(p.action, p.targetName, w), { inline_keyboard: [[{ text: `👀 ${p.targetName}님 미션 보기`, callback_data: `v:${p.targetId}` }]] });
              console.log(`${new Date().toISOString()} ${w.actor.name} → ${p.targetName} ${spec.label} (${w.commit ? w.commit.slice(0, 7) : '변경 없음'})`);
              if (p.action === 'request' && w.result.added.length) {
                const to = chatOf(p.targetId);
                if (to) {
                  const n = requestNotice(w.actor, w.result.added);
                  await send(to, n.text, { reply_markup: n.reply_markup }).catch((e) => send(replyTo, `(${esc(p.targetName)}님에게 요청 알림을 보내지 못했어요: ${esc(e.message)} — ${esc(p.targetName)}봇에서는 보여요)`));
                } else await send(replyTo, `(${esc(p.targetName)}님은 아직 텔레그램 미연결이라, 연결하면 ${esc(p.targetName)}봇에서 요청이 보여요)`);
              }
            } catch (e) {
              await edit(replyTo, mid, `❌ 저장하지 못했어요: ${esc(e.message)}`);
            }
            continue;
          }
          const viewerId = chatOwners.get(replyTo);
          if (!viewerId) { await answer('먼저 관리자에게 받은 본인 연결 링크로 연결해 주세요.'); continue; }
          const { members, db } = await state();
          const viewer = members.find((m) => m.id === viewerId) || null;
          const d = decideCallback(data, { viewer, members, db });
          if (d.kind === 'stale' || d.kind === 'pending') { await answer(d.text || '이미 처리했거나 만료된 버튼이에요.'); continue; }
          if (d.kind === 'board') {
            await answer();
            await edit(replyTo, mid, boardText(viewer, d.member, db, members), boardKeyboard(viewer, d.member, db));
          } else if (d.kind === 'compose') {
            await answer();
            compose.set(replyTo, { target: d.target, at: Date.now() });
            await send(replyTo, composePrompt(d.target, d.mode));
          } else if (d.kind === 'confirm-done') {
            await answer();
            await ask(replyTo, String(cq.from?.id), { action: 'done', owner: viewer, target: d.target }, d.picked);
          } else if (d.kind === 'respond') {
            if (busy.has(d.mission.id)) { await answer('처리 중이에요.'); continue; }
            busy.add(d.mission.id);
            await answer(d.accept ? '수락하는 중…' : '거절하는 중…');
            try {
              const label = d.accept ? '요청수락' : '요청거절';
              const w = await save((db2, ms, actor) => respondRequest(db2, d.mission.id, d.accept, actor.id, ms), () => `${d.target.name} ${label} ${d.mission.id}`, viewer.id);
              const m = w.result.mission;
              const assignee = w.members.find((x) => x.id === m.assignee) || { id: m.assignee, name: m.assignee };
              await telegramApi(token, 'editMessageReplyMarkup', { chat_id: replyTo, message_id: mid, reply_markup: withoutMission(cq.message.reply_markup, m.id) }).catch(() => {});
              await send(replyTo, d.accept ? `✅ 수락했어요 — ${esc(m.title)}\n${esc(assignee.name)}님 미션에 들어갔어요(목록 알림이 곧 가요).` : `❌ 거절했어요 — ${esc(m.title)}`, { reply_markup: { inline_keyboard: [[{ text: `👀 ${assignee.name}님 미션 보기`, callback_data: `v:${assignee.id}` }]] } });
              const reqChat = m.createdBy !== w.actor.id && chatOf(m.createdBy);
              if (reqChat) await send(reqChat, respondNotice(m, d.accept, w.actor, assignee)).catch((e) => console.log(`요청 결과 알림 실패: ${e.message}`));
              console.log(`${new Date().toISOString()} ${w.actor.name} ${label} ${m.id} (${w.commit ? w.commit.slice(0, 7) : '변경 없음'})`);
            } catch (e) {
              await send(replyTo, `❌ 처리하지 못했어요: ${esc(e.message)}`);
            } finally {
              busy.delete(d.mission.id);
            }
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
              await send(l.chatId, menuText(member, localMembers), { reply_markup: menuKeyboard(localMembers) });
            }
            for (const x of r.replies) await send(x.chatId, esc(x.text));
          } else await send(replyTo, menuText(null), { reply_markup: menuKeyboard(localMembers) });
          continue;
        }
        const { members, db } = await state();
        const c = compose.get(replyTo);
        const active = c && Date.now() - c.at < PENDING_MS ? { target: members.find((m) => m.id === c.target.id) || c.target } : null;
        const d = decide(msg, { members, chatOwners, compose: active });
        if (d.kind !== 'act-error') compose.delete(replyTo); // 내용이 잘못됐으면 다시 적을 수 있게 남겨 둔다
        if (d.kind === 'ignore' || d.kind === 'link') continue;
        if (d.kind === 'menu' || d.kind === 'unlinked') await send(d.chatId, menuText(d.owner || null, members), { reply_markup: menuKeyboard(members) });
        else if (d.kind === 'cancel') await send(d.chatId, '취소했어요.');
        else if (d.kind === 'board') {
          await send(d.chatId, boardText(d.owner, d.member, db, members), { reply_markup: boardKeyboard(d.owner, d.member, db) });
          console.log(`${new Date().toISOString()} ${d.owner.name} → ${d.member.name}봇`);
        } else if (d.kind === 'team') await send(d.chatId, teamText(members, db, new Set(chatOwners.values())));
        else if (d.kind === 'sent') await send(d.chatId, sentText(d.owner, members, db));
        else if (d.kind === 'act-denied') await send(d.chatId, d.text);
        else if (d.kind === 'act-error') await send(d.chatId, esc(d.error));
        else if (d.kind === 'act') {
          let picked = [];
          if (d.action === 'done') {
            try { picked = resolveRefs(db, d.target.id, d.refs); } catch (e) { await send(d.chatId, esc(e.message)); continue; }
          }
          await ask(d.chatId, String(msg.from?.id), d, picked);
        }
      } catch (e) {
        console.log(`처리 실패: ${e.message}`);
        if (u.callback_query) await telegramApi(token, 'answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {}); // 버튼 로딩 표시를 끝낸다
        if (replyTo) await send(replyTo, `지금 처리하지 못했어요(${esc(e.message)}). 잠시 뒤 다시 해 주세요.`).catch(() => {});
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
