#!/usr/bin/env node
// 미믹노트 텔레그램 연결 — 저장소 주인(GitHub 비밀값을 등록할 수 있는 계정)이 자기 터미널에서 직접 실행한다.
//
//   node mimic-note/telegram.mjs connect [이름 …] [--relink] [--minutes 10] [--no-wait]
//       ① 봇 토큰 확인(.env 에 없으면 화면에 안 보이게 입력) → getMe 로 진짜 봇인지 확인
//       ② 아직 연결 안 된 팀원마다 일회용 연결 링크(t.me/<봇>?start=<코드>, 24시간) 출력 → 각자에게 개인적으로 전달
//       ③ 팀원이 링크를 눌러 [시작]하면 /start <코드> 가 오고, 코드를 확인한 뒤에만 그 chat id 를 그 팀원에게 연결
//          (코드 없는 /start, 쓴 코드, 만료 코드, 단체방, 이미 다른 팀원으로 연결된 계정은 거절)
//       ④ chat id 를 .env 와 GitHub 비밀값 TELEGRAM_CHAT_ID_<아이디> 에 등록(팀원마다 따로라 서로 덮어쓰지 않음)
//       --no-wait: 링크만 만들고 기다리지 않음(코어 오브 미믹노트 봇 bot.mjs 가 켜져 있으면 연결은 봇이 처리)
//   node mimic-note/telegram.mjs status            연결 상태(아이디는 보여 주지 않음)
//   node mimic-note/telegram.mjs resend <이름>      같은 내용이어도 GitHub Actions 로 다시 보내고 결과 확인
//
// 토큰·chat id 는 화면·저장소·커밋·로그에 남기지 않는다. 저장 위치: 저장소 루트 .env(깃 제외) + GitHub 비밀값.
// 일회용 코드는 이 컴퓨터의 ~/.mimic-note/telegram-codes.json 에만 둔다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, REPO, loadMembers, requireMember, readEnv, chatIdFor, telegramApi } from './lib.mjs';
import { HOME_DIR } from './passive/compress.mjs';
import { createGithub, waitForNotify, formatNotify } from './github.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
const ENV_FILE = path.join(ROOT, '.env');
const CODE_TTL_MS = 24 * 3600e3; // 텔레그램도 받은 업데이트를 24시간만 보관한다
export const secretName = (memberId) => `TELEGRAM_CHAT_ID_${memberId.toUpperCase()}`;

export const makeCode = () => crypto.randomBytes(12).toString('base64url'); // 16자, t.me start 매개변수에 쓸 수 있는 글자만

// 받은 업데이트에서 연결 요청을 확인한다(순수 함수 — 테스트 대상).
// codes: { 코드: { member, expiresAt, usedAt } } (쓴 코드는 usedAt 이 채워짐), chatOwners: Map(chatId → 팀원 아이디)
export function processUpdates(updates, { codes, chatOwners, now = Date.now() }) {
  const links = [];
  const replies = [];
  for (const u of updates) {
    const msg = u.message;
    const m = typeof msg?.text === 'string' && msg.text.trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
    if (!m || !msg.chat) continue;
    const chatId = String(msg.chat.id);
    if (msg.chat.type !== 'private') { replies.push({ chatId, text: '미믹노트 연결은 봇과의 개인 대화에서만 할 수 있어요.' }); continue; }
    // 코드 형식(16자)과 "자기 키"만 인정 — /start __proto__ 같은 입력으로 객체 기본값을 건드리지 못하게
    const c = /^[A-Za-z0-9_-]{16}$/.test(m[1] || '') && Object.hasOwn(codes, m[1]) ? codes[m[1]] : null;
    if (!c) { replies.push({ chatId, text: '관리자에게 받은 본인 연결 링크로 다시 눌러 주세요. (/start 만으로는 연결되지 않아요)' }); continue; }
    if (c.usedAt) { replies.push({ chatId, text: '이미 사용된 연결 링크예요. 관리자에게 새 링크를 요청하세요.' }); continue; }
    if (Date.parse(c.expiresAt) <= now) { replies.push({ chatId, text: '만료된 연결 링크예요. 관리자에게 새 링크를 요청하세요.' }); continue; }
    const owner = chatOwners.get(chatId);
    if (owner && owner !== c.member) { replies.push({ chatId, text: '이 텔레그램 계정은 이미 다른 팀원으로 연결되어 있어요. 관리자에게 문의하세요.' }); continue; }
    c.usedAt = new Date(now).toISOString();
    chatOwners.set(chatId, c.member);
    links.push({ member: c.member, chatId, who: [msg.from?.first_name, msg.from?.last_name, msg.from?.username && `@${msg.from.username}`].filter(Boolean).join(' ') });
  }
  return { links, replies };
}

// .env 의 한 줄을 바꾸거나 붙인다(값은 화면에 출력하지 않는다).
export function setEnvVar(file, key, value) {
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const i = lines.findIndex((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1] === key);
  if (i === -1) lines.push(`${key}=${value}`);
  else lines[i] = `${key}=${value}`;
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const codesFile = () => path.join(HOME_DIR(), 'telegram-codes.json');
export function loadCodes() {
  try { return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(codesFile(), 'utf8')).codes); } catch { return Object.create(null); }
}
function saveCodes(codes) {
  fs.mkdirSync(path.dirname(codesFile()), { recursive: true });
  fs.writeFileSync(codesFile(), JSON.stringify({ codes }, null, 2), { mode: 0o600 });
}

export function secretNames() {
  try {
    return new Set(JSON.parse(execFileSync('gh', ['secret', 'list', '-R', REPO, '--json', 'name'], { encoding: 'utf8', stdio: 'pipe' })).map((s) => s.name));
  } catch {
    return null; // 저장소 주인이 아니면 목록을 못 본다
  }
}

export function setSecret(name, value) {
  try {
    execFileSync('gh', ['secret', 'set', name, '-R', REPO], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    console.log(`  ⚠️ GitHub 비밀값 ${name} 등록 실패: ${String(e.stderr || e.message).trim().split('\n').at(-1)}`);
    console.log(`     → 저장소 주인 계정으로 바꾸고(gh auth switch -u newcode135-prog) 다시 실행하거나, GitHub → Settings → Secrets and variables → Actions 에서 ${name} 를 직접 등록하세요.`);
    return false;
  }
}

// 연결 하나를 반영: .env + GitHub 비밀값 + 코드 저장 + 확인 메시지 + 지금 미션 발송 요청(Actions)
export async function applyLink(l, { members, codes, token, log = console.log }) {
  const m = members.find((x) => x.id === l.member);
  setEnvVar(ENV_FILE, secretName(m.id), l.chatId);
  const ok = setSecret(secretName(m.id), l.chatId);
  saveCodes(codes);
  await telegramApi(token, 'sendMessage', { chat_id: l.chatId, text: ok ? `✅ 미믹노트 연결 완료 — ${m.name}님의 미션 알림이 이 대화로 와요.` : `✅ ${m.name}님 연결은 됐어요. 자동 알림 등록은 관리자 확인이 필요해요(그동안 버튼으로 미션을 받을 수 있어요).` }).catch(() => {});
  log(`   ✅ ${m.name} 연결됨 — 텔레그램 이름: ${l.who || '(이름 없음)'}${ok ? ' · GitHub 비밀값 등록' : ' · GitHub 비밀값 등록은 실패(위 안내 참고)'}`);
  log('      본인이 맞는지 이름을 확인하세요. 아니면: node mimic-note/telegram.mjs connect --relink ' + m.id);
  if (ok) {
    try { createGithub().dispatch(m.id, false); log('      → 지금 미션을 보내도록 GitHub Actions 에 요청했습니다.'); } catch (e) { log(`      → 미션 발송 요청 실패: ${e.message}`); }
  }
  return { member: m, ok };
}

export async function askHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('이 터미널에서는 입력을 숨길 수 없습니다. 메모장으로 저장소 폴더의 .env 파일에 TELEGRAM_BOT_TOKEN=<토큰> 한 줄을 넣고 다시 실행하세요(.env 는 git 에 올라가지 않음). PowerShell·명령 프롬프트·macOS 터미널에서는 숨김 입력이 됩니다.');
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function connect(names, { relink = false, minutes = 10, wait = true } = {}) {
  const members = loadMembers();
  let env = readEnv(ROOT, process.env);
  let token = env.TELEGRAM_BOT_TOKEN;
  let fresh = false;
  if (!token) {
    console.log('BotFather 에서 받은 봇 토큰을 붙여 넣으세요(화면에 표시되지 않음). 미믹 클라우드 서비스 봇과는 다른 봇이어야 합니다.');
    token = await askHidden('봇 토큰: ');
    fresh = true;
  }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('봇 토큰 형식이 아닙니다(숫자:영문 형식). BotFather 메시지를 다시 확인하세요.');
  const me = await telegramApi(token, 'getMe');
  console.log(`① 봇 확인: @${me.username} (${me.first_name})`);
  if (fresh) {
    setEnvVar(ENV_FILE, 'TELEGRAM_BOT_TOKEN', token);
    console.log('   토큰을 이 컴퓨터의 .env 에 저장했습니다(git 에 올라가지 않음).');
    env = readEnv(ROOT, process.env);
  }
  const secrets = secretNames();
  if (fresh || (secrets && !secrets.has('TELEGRAM_BOT_TOKEN'))) {
    if (setSecret('TELEGRAM_BOT_TOKEN', token)) console.log('   GitHub 비밀값 TELEGRAM_BOT_TOKEN 등록 완료.');
  }
  // .env 에만 있고 GitHub 에 없는 연결은 다시 올린다(지난번 등록이 실패했을 때)
  for (const m of members) {
    const local = chatIdFor(m.id, env);
    if (local && secrets && !secrets.has(secretName(m.id)) && setSecret(secretName(m.id), local)) console.log(`   ${m.name}: 이 컴퓨터의 연결을 GitHub 비밀값에 다시 등록했습니다.`);
  }

  const linked = (m) => Boolean(chatIdFor(m.id, env) || secrets?.has(secretName(m.id)));
  const targets = (names.length ? names.map((n) => requireMember(n, members)) : members).filter((m) => relink || !linked(m));
  if (!targets.length) {
    console.log('② 연결할 팀원이 없습니다(모두 연결됨). 다시 연결하려면 --relink <이름>.');
    return;
  }
  const codes = loadCodes();
  const now = Date.now();
  for (const [c, v] of Object.entries(codes)) if (v.usedAt || Date.parse(v.expiresAt) <= now - CODE_TTL_MS) delete codes[c]; // 오래된 것 정리
  console.log('② 각 팀원에게 "본인 링크만" 개인 메시지로 보내세요(링크를 누르고 [시작]을 누르면 연결됩니다, 24시간 유효):');
  for (const m of targets) {
    let code = Object.keys(codes).find((c) => codes[c].member === m.id && !codes[c].usedAt && Date.parse(codes[c].expiresAt) > now);
    if (!code) {
      code = makeCode();
      codes[code] = { member: m.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + CODE_TTL_MS).toISOString(), usedAt: null };
    }
    console.log(`   ${m.name}: https://t.me/${me.username}?start=${code}`);
  }
  saveCodes(codes);
  // 이 컴퓨터에서 코어 오브 미믹노트 봇이 돌고 있으면 기다리지 않는다(같은 봇의 업데이트를 빼앗지 않게)
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(HOME_DIR(), 'core-bot.lock'), 'utf8'));
    if (wait && pid) { process.kill(pid, 0); console.log('   이 컴퓨터에서 코어 오브 미믹노트 봇이 켜져 있어 기다리지 않습니다 — 팀원이 링크로 [시작]하면 봇이 연결합니다.'); wait = false; }
  } catch { /* 봇 없음 */ }
  if (!wait) {
    console.log('③ 기다리지 않습니다(--no-wait). 코어 오브 미믹노트 봇(node mimic-note/bot.mjs)이 이 컴퓨터에서 켜져 있으면 팀원이 [시작]할 때 봇이 연결합니다.');
    return;
  }

  // 이미 연결된 chat id(같은 사람이 두 팀원으로 연결되는 것 방지). --relink 대상은 자기 자리를 비운다.
  const chatOwners = new Map(members.filter((m) => !targets.includes(m) || !relink).map((m) => [String(chatIdFor(m.id, env) || ''), m.id]).filter(([c]) => c));
  const waiting = new Set(targets.map((m) => m.id));
  const deadline = Date.now() + minutes * 60e3;
  console.log(`③ 연결을 기다립니다(최대 ${minutes}분, Ctrl+C 로 멈춤 — 나중에 같은 명령을 다시 실행하면 이어서 기다립니다).`);
  let offset;
  while (waiting.size && Date.now() < deadline) {
    let updates;
    try {
      updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset, allowed_updates: ['message'] });
    } catch (e) {
      if (e.code === 409) throw new Error('같은 봇이 다른 곳(다른 컴퓨터의 bot.mjs)에서 켜져 있어 여기서는 기다릴 수 없습니다. 봇이 켜진 그 컴퓨터에서 node mimic-note/telegram.mjs connect --no-wait 를 실행하세요(연결 코드는 그 컴퓨터에 있어야 봇이 확인할 수 있음).');
      throw e;
    }
    if (!updates.length) continue;
    offset = updates.at(-1).update_id + 1;
    const r = processUpdates(updates, { codes, chatOwners, now: Date.now() });
    for (const l of r.links) {
      await applyLink(l, { members, codes, token });
      waiting.delete(l.member);
    }
    saveCodes(codes);
    for (const x of r.replies) await telegramApi(token, 'sendMessage', { chat_id: x.chatId, text: x.text }).catch(() => {});
  }
  if (offset) await telegramApi(token, 'getUpdates', { offset, timeout: 0 }).catch(() => {}); // 처리한 업데이트 확인(재처리 방지)
  console.log(waiting.size
    ? `④ 아직 연결 안 됨: ${[...waiting].map((id) => members.find((m) => m.id === id).name).join(', ')} — 링크를 누른 뒤 같은 명령을 다시 실행하세요(24시간 안에).`
    : '④ 모두 연결됐습니다. 이제 미션이 바뀌면 GitHub Actions 가 그 사람에게만 보냅니다.');
}

function status() {
  const env = readEnv(ROOT, process.env);
  const secrets = secretNames();
  console.log(`봇 토큰: 이 컴퓨터 ${env.TELEGRAM_BOT_TOKEN ? '있음' : '없음'} · GitHub 비밀값 ${secrets ? (secrets.has('TELEGRAM_BOT_TOKEN') ? '있음' : '없음') : '확인 불가(저장소 주인만)'}`);
  for (const m of loadMembers()) {
    const where = [chatIdFor(m.id, env) && '이 컴퓨터', secrets?.has(secretName(m.id)) && 'GitHub'].filter(Boolean);
    console.log(`  ${m.name}(${m.id}): ${where.length ? `연결됨(${where.join('·')})` : '미연결'}`);
  }
}

async function resend(name) {
  const member = requireMember(name, loadMembers());
  const github = createGithub();
  const login = github.whoami();
  if (!github.access().push) throw new Error(`GitHub 계정 ${login} 에 저장소 쓰기 권한이 없어 발송을 요청할 수 없습니다.`);
  let r;
  for (let i = 0; i < 2; i++) { // 다른 실행과 겹쳐 취소되면 한 번 더
    const after = github.latestRunId();
    github.dispatch(member.id, true);
    r = await waitForNotify(github, { afterRunId: after, actor: login });
    if (r.status !== 'cancelled') break;
  }
  console.log(formatNotify(r, loadMembers()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const mi = args.indexOf('--minutes');
  const minutes = mi !== -1 ? Math.max(1, Math.min(120, Number(args[mi + 1]) || 10)) : 10;
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--minutes').slice(1);
  const cmd = args[0];
  const job = cmd === 'connect' ? connect(names, { relink: flags.has('--relink'), minutes, wait: !flags.has('--no-wait') })
    : cmd === 'status' ? Promise.resolve(status())
      : cmd === 'resend' ? resend(names[0])
        : Promise.reject(new Error('사용법: node mimic-note/telegram.mjs connect [이름 …] [--relink] | status | resend <이름>'));
  job.catch((e) => { console.error(e.message); process.exit(1); });
}
