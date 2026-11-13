#!/usr/bin/env node
// 코어 오브 미믹노트 — 텔레그램 봇 메뉴. 대화창 아래에 [창민봇][유리봇][민호봇][네이뜬봇][루카스봇] 버튼이 늘 떠 있고,
// 본인 버튼을 누르면 GitHub main 의 최신 미션(보고할 것)을 바로 보낸다. 남의 버튼은 거절(미션은 본인에게만).
// 처음 연결(/start <일회용 코드>)도 이 봇이 처리한다(코드는 이 컴퓨터에서 telegram.mjs connect --no-wait 로 만든 것).
//
//   node mimic-note/bot.mjs        실행(Ctrl+C 로 종료) — 켜져 있는 동안만 버튼에 답한다
//   bash mimic-note/bot-install-macmini.sh   맥미니에 상시 실행으로 설치(권장)
//
// 같은 봇은 한 컴퓨터에서만 켠다(텔레그램이 동시에 하나만 받음). 필요: 저장소 루트 .env 의 TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID_<아이디>(연결되면 자동으로 들어감). 토큰·chat id 는 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, REPO, readEnv, chatIdFor, telegramApi, validateDb, validateMembers } from './lib.mjs';
import { renderTelegram } from './notify.mjs';
import { processUpdates, applyLink, loadCodes } from './telegram.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
export const BOT_NAME = '코어 오브 미믹노트';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 늘 떠 있는 버튼판: 팀원 이름 + "봇", 한 줄에 3개
export function menuKeyboard(members) {
  const buttons = members.map((m) => ({ text: `${m.name}봇` }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

export function menuText(owner) {
  return ['🎯 <b>코어 오브 미믹노트</b>', '',
    owner ? `${esc(owner.name)}님, 아래 <b>${esc(owner.name)}봇</b>을 누르면 지금 보고할 미션이 와요.` : '아래에서 본인 이름 버튼을 누르세요. 처음이면 관리자에게 받은 본인 연결 링크로 [시작]을 먼저 눌러 주세요.',
  ].join('\n');
}

export function missionsText(member, db) {
  return `${renderTelegram(member, db)}\n\n끝낸 미션은 Claude Code 에 <code>${esc(member.name)} 미션완료 1</code> 처럼 보고하세요.`;
}

// 받은 메시지 하나를 어떻게 처리할지(순수 함수 — 테스트 대상). chatOwners: Map(chatId → 팀원 아이디)
export function decide(msg, { members, chatOwners }) {
  if (!msg?.chat || typeof msg.text !== 'string') return { kind: 'ignore' };
  if (msg.chat.type !== 'private') return { kind: 'ignore' }; // 단체방에서는 답하지 않는다(미션 공개 방지)
  const chatId = String(msg.chat.id);
  const owner = members.find((m) => m.id === chatOwners.get(chatId)) || null;
  const text = msg.text.trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (start?.[1]) return { kind: 'link', chatId };
  if (start || /^\/(menu|help)(@\w+)?$/.test(text) || text === '메뉴') return { kind: 'menu', chatId, owner };
  const me = /^\/me(@\w+)?$/.test(text) || /^내\s*미션$/.test(text);
  const btn = text.match(/^(.+?)\s*봇$/);
  if (!me && !btn) return { kind: 'menu', chatId, owner };
  if (!owner) return { kind: 'unlinked', chatId };
  const target = me ? owner : members.find((m) => m.name === btn[1] || m.id === btn[1].toLowerCase());
  if (!target) return { kind: 'menu', chatId, owner };
  if (target.id !== owner.id) return { kind: 'deny', chatId, owner, target };
  return { kind: 'missions', chatId, member: owner };
}

// 최신 데이터: GitHub main(API) → 안 되면 이 폴더의 파일
function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
async function readLatest(file, token) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${file}?ref=main`, {
      headers: { accept: 'application/vnd.github.raw+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (r.ok) return JSON.parse(await r.text());
  } catch { /* 아래 로컬로 */ }
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const token = readEnv(ROOT, process.env).TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 이 없습니다. 먼저 node mimic-note/telegram.mjs connect 로 봇 토큰을 등록하세요.');
  const gh = ghToken();
  const me = await telegramApi(token, 'getMe');
  try {
    if ((await telegramApi(token, 'getMyName')).name !== BOT_NAME) await telegramApi(token, 'setMyName', { name: BOT_NAME });
  } catch (e) { console.log(`봇 이름 바꾸기 실패(나중에 다시): ${e.message}`); }
  await telegramApi(token, 'setMyCommands', { commands: [{ command: 'start', description: '메뉴 열기' }, { command: 'me', description: '내 미션 보기' }] }).catch(() => {});
  console.log(`${BOT_NAME} 봇 실행 중: @${me.username} — 이 컴퓨터에서만 켜 두세요(Ctrl+C 로 종료)`);

  const send = (chatId, text, extra = {}) => telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  let offset;
  for (;;) {
    let updates;
    try {
      updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset, allowed_updates: ['message'] });
    } catch (e) {
      console.log(e.code === 409 ? '다른 곳에서 같은 봇이 업데이트를 받고 있습니다(연결 명령 또는 다른 컴퓨터의 봇). 30초 뒤 다시 시도합니다.' : `업데이트 받기 실패: ${e.message}`);
      await sleep(e.code === 409 ? 30000 : 5000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        const members = (await readLatest('mimic-note/data/members.json', gh)).members;
        if (validateMembers(members).length) throw new Error('팀원 명부가 올바르지 않음');
        const env = readEnv(ROOT, process.env);
        const chatOwners = new Map(members.map((m) => [String(chatIdFor(m.id, env) || ''), m.id]).filter(([c]) => c));
        const d = decide(u.message, { members, chatOwners });
        if (d.kind === 'ignore') continue;
        if (d.kind === 'link') {
          const codes = loadCodes();
          const r = processUpdates([u], { codes, chatOwners, now: Date.now() });
          for (const l of r.links) {
            const { member } = await applyLink(l, { members, codes, token });
            await send(l.chatId, menuText(member), { reply_markup: menuKeyboard(members) });
          }
          for (const x of r.replies) await send(x.chatId, esc(x.text));
          continue;
        }
        if (d.kind === 'menu') await send(d.chatId, menuText(d.owner), { reply_markup: menuKeyboard(members) });
        else if (d.kind === 'unlinked') await send(d.chatId, '아직 연결되지 않았어요. 관리자에게 받은 <b>본인 연결 링크</b>로 [시작]을 눌러 주세요.', { reply_markup: menuKeyboard(members) });
        else if (d.kind === 'deny') await send(d.chatId, `${esc(d.target.name)}봇은 ${esc(d.target.name)}님만 쓸 수 있어요. 본인 버튼(<b>${esc(d.owner.name)}봇</b>)을 누르세요.`);
        else if (d.kind === 'missions') {
          const db = await readLatest('mimic-note/data/missions.json', gh);
          if (validateDb(db, members).length) throw new Error('미션 데이터가 올바르지 않음');
          await send(d.chatId, missionsText(d.member, db));
          console.log(`${new Date().toISOString()} ${d.member.name}봇 → 미션 보냄`);
        }
      } catch (e) {
        console.log(`처리 실패: ${e.message}`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
