#!/usr/bin/env node
// 코어 오브 미믹노트 — 텔레그램 미션 앱 봇(이 컴퓨터에서 롱폴링). 처리 내용은 app.mjs 에 있고 클라우드플레어 워커와 똑같다.
// - 이름봇: 본인은 내 미션 + [✅ 번호] 완료·받은 요청 [수락][거절], 남은 그 사람 미션 + [📨 미션 주기](관리자)/[📨 미션 요청](팀원 → 관리자)
//   대전제(배정은 관리자만): 팀원이 보낸 것은 '요청'이고, 받은 관리자가 수락해야 미션이 된다. 팀원끼리는 주고받지 않는다.
// - 📋 팀 현황 · 📤 보낸 미션 · 🌐 언어(한국어·English·中文) · 글 명령("창민 이거 결제해줘" · "민호 미션완료 2" …)
// - 알림: 새 미션·완료는 GitHub Actions 가 보내고(목록 메시지에도 ✅ 버튼), 요청·수락·거절은 봇이 바로 보낸다.
// 처음 연결(/start <일회용 코드>)도 처리한다(코드는 이 컴퓨터에서 telegram.mjs connect --no-wait 로 만든 것).
//
//   node mimic-note/bot.mjs                  실행(Ctrl+C 로 종료) — 켜져 있는 동안 답한다(꺼져 있을 때 누른 버튼은 켜지면 처리)
//   bash mimic-note/bot-install-macmini.sh   맥미니에 상시 실행으로 설치
//   node worker/setup.mjs                    클라우드플레어 봇 서버(24시간)로 옮기기 — 그 뒤에는 이 봇을 켜지 않는다
//
// 신뢰 규칙
// - 보낸 사람은 텔레그램 연결(일회용 코드로 만든 chat id ↔ 팀원)로만 확인한다. 역할·미션은 GitHub Actions 가 "확인한 상태"
//   (MIMIC_VERIFIED)에서 읽는다 — 확인 안 된 변경(권한 없는 수정 등)은 보여 주지도, 근거로 쓰지도 않는다.
//   예외: 확인된 커밋 위에 이 봇이 직접 만든 커밋(+미션 데이터를 안 바꾼 코드·문서 커밋)만 있으면 Actions 확인 전이라도 이어서
//   쓴다(연달아 누르기, core.mjs safeHead). 내용이 아니라 커밋으로 믿으므로, 같은 내용으로 되돌린(revert) 남의 push 는 믿지 않는다.
// - 봇이 꺼져 있는 동안 누른 버튼은 텔레그램이 24시간 보관했다가 봇이 켜지면 처리된다(수락·거절은 그때 바로 저장).
// - 저장은 이 컴퓨터의 gh 계정(저장소 관리자이거나 관리자 팀원)으로 하고, 권한은 누른 팀원의 역할로 본다.
// - 같은 봇은 한 곳에서만 켠다(이 컴퓨터·맥미니·클라우드플레어 중 하나). 토큰·chat id 는 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  NOTE_DIR, loadMembers, readEnv, telegramApi, validateDb, validateMembers, BOT_NAME, menuKeyboard, menuText, missionsText,
  ownersFromEnv, decide, confirmText, resolveRefs, safeHead,
} from './lib.mjs';
import { handleUpdate } from './app.mjs';
import { processUpdates, applyLink, loadCodes, secretNames } from './telegram.mjs';
import { mutate } from './mission.mjs';
import { createGithub, DB_FILE, MEMBERS_FILE } from './github.mjs';
import { HOME_DIR } from './passive/compress.mjs';

export { BOT_NAME, menuKeyboard, menuText, missionsText, ownersFromEnv, decide, confirmText, resolveRefs };
export { withoutMission } from './app.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
export const LOCK = () => path.join(HOME_DIR(), 'core-bot.lock');

// 명령어 메뉴(언어별 설명) — 워커 설치(worker/setup.mjs)도 같은 것을 쓴다
export const COMMANDS = {
  ko: ['메뉴 열기', '내 미션 보기', '팀 현황', '내가 준·요청한 미션', '언어 바꾸기'],
  en: ['Open the menu', 'My missions', 'Team status', 'Missions I gave or requested', 'Change language'],
  zh: ['打开菜单', '我的任务', '团队概况', '我分配或请求的任务', '切换语言'],
};
export async function setCommands(token) {
  for (const [l, d] of Object.entries(COMMANDS)) {
    const commands = ['start', 'me', 'team', 'sent', 'lang'].map((command, i) => ({ command, description: d[i] }));
    await telegramApi(token, 'setMyCommands', { commands, ...(l === 'ko' ? {} : { language_code: l }) }).catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function botRunningHere() {
  try { const { pid } = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); return pid !== process.pid && alive(pid); } catch { return false; }
}
// 이 컴퓨터에만 남기는 봇 기록: 봇이 만든 커밋 → 부모(최근 500개)와 마지막으로 알아낸 확인된 커밋. 다시 켜도 이어진다.
const BOT_STATE = () => path.join(HOME_DIR(), 'core-bot-trusted.json');
const isSha = (s) => /^[0-9a-f]{40}$/.test(s || '');
export function loadBotState(file = BOT_STATE()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { trusted: new Map((j.commits || []).filter((x) => isSha(x?.[0]) && isSha(x?.[1]))), verified: isSha(j.verified) ? j.verified : null };
  } catch { return { trusted: new Map(), verified: null }; }
}
export function saveBotState(s, file = BOT_STATE()) {
  while (s.trusted.size > 500) s.trusted.delete(s.trusted.keys().next().value);
  try { fs.writeFileSync(file, JSON.stringify({ commits: [...s.trusted], verified: s.verified })); } catch (e) { console.log(`봇 기록 저장 실패: ${e.message}`); }
}

// 메모리 임시 저장(확인 대기·쓰기 대기·처리 중) — 워커는 같은 자리에 KV 를 쓴다
export function memoryKv(now = () => Date.now()) {
  const m = new Map();
  return {
    get: async (k) => { const v = m.get(k); if (!v) return null; if (v.until < now()) { m.delete(k); return null; } return v.value; },
    put: async (k, value, ttl) => {
      for (const [k2, v] of m) if (v.until < now()) m.delete(k2);
      m.set(k, { value: JSON.parse(JSON.stringify(value)), until: now() + ttl * 1000 });
    },
    del: async (k) => { m.delete(k); },
  };
}

async function main() {
  const token = readEnv(ROOT, process.env).TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 이 없습니다. 먼저 node mimic-note/telegram.mjs connect 로 봇 토큰을 등록하세요.');
  if (botRunningHere()) throw new Error('이 컴퓨터에서 이미 코어 오브 미믹노트 봇이 켜져 있습니다.');
  const hook = await telegramApi(token, 'getWebhookInfo');
  if (hook.url) { // 정상 종료(0) — 맥미니 launchd 가 실패로 보고 30초마다 다시 켜지 않게
    console.log(`이 봇은 클라우드플레어 봇 서버(${new URL(hook.url).host})에서 돌고 있어요 — 이 컴퓨터에서는 켜지 않습니다(같은 봇은 한 곳에서만).`);
    process.exit(0);
  }
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
  await setCommands(token);
  if (!secretNames()) console.log('⚠️ 이 컴퓨터의 gh 계정은 GitHub 비밀값을 등록할 수 없어, 봇으로 연결해도 자동 알림 등록은 관리자가 따로 해야 합니다.');
  console.log(`${BOT_NAME} 봇 실행 중: @${me.username} — 이 컴퓨터에서만 켜 두세요(Ctrl+C 로 종료)`);

  // GitHub Actions 가 확인한 상태(커밋)와 그때의 명부·미션. 커밋 내용은 바뀌지 않으므로 커밋별로 기억한다.
  const memo = new Map();
  const bs = loadBotState();
  let verified = { sha: bs.verified, at: 0 };
  // 확인된 커밋을 새로 찾는다. 못 찾으면(실행이 연달아 취소·건너뜀) 마지막으로 알아낸 것 — 예전 것이어도 확인된 상태다.
  const freshVerified = () => {
    const s = github.verifiedSha();
    if (s && s !== bs.verified) { bs.verified = s; saveBotState(bs); }
    verified = { sha: s || verified.sha, at: Date.now() };
    return verified.sha;
  };
  const verifiedSha = () => {
    if (Date.now() - verified.at > 60e3) freshVerified();
    if (!verified.sha) throw new Error('GitHub Actions 의 확인 상태를 아직 알 수 없어요');
    return verified.sha;
  };
  const store = { ...github, verifiedSha: freshVerified }; // 저장(mutate)은 늘 새로 찾되, 못 찾으면 마지막 것으로
  const read = (file, sha) => {
    const k = `${file}@${sha}`;
    if (!memo.has(k)) {
      if (memo.size > 200) memo.clear();
      const r = github.readFile(file, sha);
      memo.set(k, { json: JSON.parse(r.text), sha: r.sha });
    }
    return memo.get(k);
  };
  const trusted = bs.trusted; // 이 봇이 만든 커밋 → 그 부모(core.mjs safeHead)
  let lastLangs = {}; // 마지막으로 읽은 팀원별 언어 — GitHub 를 읽기 전에 보내는 문구(만료 버튼·오류)도 그 사람 언어로
  let chatOwners = new Map();

  const ctx = {
    tg: (method, body) => telegramApi(token, method, body),
    ownerOf: async (chatId) => chatOwners.get(String(chatId)) || null,
    chatOf: async (memberId) => { for (const [chat, id] of chatOwners) if (id === memberId) return chat; return null; },
    linked: async () => new Set(chatOwners.values()),
    langHint: async (memberId) => lastLangs[memberId] || null,
    async state() {
      let sha = verifiedSha();
      if (trusted.size) {
        // 확인된 커밋 위에 봇 커밋(+데이터를 안 바꾼 커밋)만 있으면 main 을 보여 준다(연달아 누르기). 아니거나 오류면 확인된 상태로.
        try {
          const h = github.headSha();
          if (h !== sha && await safeHead(github, h, sha, trusted)) sha = h;
        } catch { /* 확인된 상태로 */ }
      }
      const members = read(MEMBERS_FILE, sha).json.members;
      const db = read(DB_FILE, sha).json;
      if (validateMembers(members).length || validateDb(db, members).length) throw new Error('확인된 데이터가 올바르지 않아요');
      lastLangs = db.langs || {};
      return { members, db };
    },
    async save(apply, describe, as) {
      const w = await mutate(store, apply, describe, { as, via: '텔레그램', trusted });
      if (w.commit) {
        trusted.set(w.commit, w.parent);
        saveBotState(bs);
      }
      verified.at = 0; // 다음 버튼은 새 확인 상태를 보게
      return w;
    },
    kv: memoryKv(),
    unlinkedMembers: async () => loadMembers(),
    async link(u, lang) {
      const localMembers = loadMembers();
      const codes = loadCodes();
      const r = processUpdates([u], { codes, chatOwners, now: Date.now() });
      for (const l of r.links) {
        const { member } = await applyLink(l, { members: localMembers, codes, token, lang });
        return { member, members: localMembers };
      }
      return r.replies[0] ? { key: r.replies[0].key, text: r.replies[0].text } : { key: 'linkNeedCode' };
    },
    randomKey: () => crypto.randomBytes(6).toString('base64url'),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  };

  let offset;
  for (;;) {
    let updates;
    try {
      updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] });
    } catch (e) {
      console.log(e.code === 409 ? '다른 곳에서 같은 봇이 업데이트를 받고 있습니다(클라우드플레어 웹훅·다른 컴퓨터의 bot.mjs·기다리는 connect). 30초 뒤 다시 시도합니다.' : `업데이트 받기 실패: ${e.message}`);
      await sleep(e.code === 409 ? 30000 : 5000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      chatOwners = ownersFromEnv(readEnv(ROOT, process.env)); // 연결은 .env 에서(이 컴퓨터에서 연결하면 바로 반영)
      await handleUpdate(u, ctx);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
