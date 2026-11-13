#!/usr/bin/env node
// 패시브 스킬 [자동 다운로드] — 대전제에 따라 반드시 돌아가는 타이머 프로그램(10분마다, 맥미니 launchd).
//
// 한 번 실행할 때 하는 일
//   1) git pull 로 모든 플레이어의 최종 기록(라벨링·압축·업로드)과 미션 DB 를 받는다
//   2) 규칙(rules.mjs)으로 플레이어별 '더 중요한 일'과 투두를 계산한다
//   3) 이전 결과(data/auto/todos.json)와 비교해 바뀐 사람에게만 알린다(텔레그램 / 맥 알림창)
//   4) 결과가 바뀌었을 때만 data/auto/todos.json 을 commit·push 한다(이 파일은 이 프로그램만 쓴다)
//   5) AI 하네스용 판단 기록을 이 컴퓨터에만 남긴다(~/.mimic-note/harness/decisions.jsonl)
//
//   node mimic-note/passive/auto-download.mjs                 한 번 실행(타이머가 부르는 형태)
//   node mimic-note/passive/auto-download.mjs --dry           git·알림 없이 계산 결과만 출력
//   node mimic-note/passive/auto-download.mjs --mac-notify    맥 알림창으로도 알림
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, loadDb, readEnv, chatIdFor, telegramApi } from '../lib.mjs';
import { loadAllWorks } from '../work.mjs';
import { computeAuto, diffForNotify, formatNotify, RULES_VERSION } from './rules.mjs';
import { consult, applySuggestions } from '../harness/harness.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
const AUTO_REL = 'mimic-note/data/auto/todos.json';
const HARNESS_REL = 'mimic-note/data/harness/suggestions.json';
const STALE_LOCK_MS = 15 * 60 * 1000;

export function autoPath(dir = NOTE_DIR) {
  return path.join(dir, 'data', 'auto', 'todos.json');
}

export function homeDir(env = process.env) {
  return env.MIMIC_NOTE_HOME || path.join(os.homedir(), '.mimic-note');
}

// 10분 검사 중복 실행 방지: 앞 실행이 안 끝났으면 이번 회차는 건너뛴다. 15분 넘은 잠금은 죽은 것으로 보고 치운다.
export function acquireLock(lockDir) {
  try {
    fs.mkdirSync(lockDir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age < STALE_LOCK_MS) return null;
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

function pushWithRetry(message, log) {
  const paths = [AUTO_REL, HARNESS_REL].filter((p) => fs.existsSync(path.join(ROOT, p)));
  git(['add', ...paths]);
  if (!git(['status', '--porcelain', '--', ...paths])) return 'nothing';
  git(['-c', 'user.name=미믹노트 패시브 스킬', '-c', 'user.email=mimic-note@localhost', 'commit', '-q', '-m', message, '--', ...paths]);
  for (let i = 1; i <= 3; i++) {
    try {
      git(['push', '-q', 'origin', 'HEAD']);
      return 'pushed';
    } catch (e) {
      log(`push 실패(${i}/3): ${String(e.stderr || e.message).split('\n')[0]} → pull --rebase 후 재시도`);
      git(['pull', '-q', '--rebase', '--autostash']);
    }
  }
  return 'push-failed';
}

function macNotify(title, text) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFileSync('osascript', ['-e', `display notification "${esc(text.slice(0, 220))}" with title "${esc(title)}"`], { stdio: 'ignore' });
}

export async function runOnce(opts = {}) {
  const {
    dir = NOTE_DIR,
    useGit = true,
    notify = true,
    macNotifyOn = false,
    env = readEnv(ROOT),
    now = new Date().toISOString(),
    log = (m) => console.log(`[${new Date().toISOString()}] ${m}`),
    send = (token, chatId, text) => telegramApi(token, 'sendMessage', { chat_id: chatId, text }),
    ask, // AI 하네스 호출(테스트에서 갈아끼움). 없으면 ANTHROPIC_API_KEY 가 있을 때만 Claude 를 부른다
  } = opts;

  const release = acquireLock(path.join(os.tmpdir(), `mimic-note-auto-${Buffer.from(dir).toString('hex').slice(-16)}.lock`));
  if (!release) { log('앞 회차가 아직 실행 중이라 이번 회차는 건너뜁니다.'); return { skipped: true }; }
  try {
    if (useGit) git(['pull', '-q', '--rebase', '--autostash']);

    const members = loadMembers(dir);
    const works = loadAllWorks(members, dir);
    const db = loadDb(dir);
    const result = computeAuto({ members, db, works });
    // AI 하네스: 규칙이 애매하다고 넘긴 후보만, 처음 볼 때 한 번 Claude 에게 묻는다. 실패해도 규칙 결과로 계속.
    let ai = { called: 0, changed: false, active: [] };
    try {
      ai = await consult({ escalations: result.escalations, members, db, works, dir, env, now, log, ...(ask ? { ask } : {}) });
    } catch (e) { log(`AI 하네스 건너뜀: ${e.message}`); }
    applySuggestions(result.players, ai.active, members);
    const broken = Object.entries(works).filter(([, w]) => w.broken).map(([id]) => id);
    if (broken.length) log(`작업 기록 파일이 깨져 건너뜀: ${broken.join(', ')}`);

    const file = autoPath(dir);
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const notes = diffForNotify(prev?.players, result.players);
    const changed = !prev || JSON.stringify(prev.players) !== JSON.stringify(result.players);

    let pushed = 'unchanged';
    if (changed || ai.changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ rulesVersion: RULES_VERSION, generatedAt: now, players: result.players }, null, 2) + '\n');
      if (useGit) pushed = pushWithRetry(`패시브 스킬 [자동 다운로드]: 투두 갱신 (${notes.length}명)`, log);
      else pushed = 'written';
    }

    // 알림(D1): 투두가 바뀌었거나 더 중요한 일이 생긴 사람에게만
    const delivered = [];
    if (notify) {
      for (const note of notes) {
        const member = members.find((m) => m.id === note.id);
        const text = formatNotify(member, note);
        const chatId = chatIdFor(member.id, env);
        let via = [];
        if (env.TELEGRAM_BOT_TOKEN && chatId) {
          try { await send(env.TELEGRAM_BOT_TOKEN, chatId, text); via.push('telegram'); } catch (e) { log(`텔레그램 실패(${member.id}): ${e.message}`); }
        }
        if (macNotifyOn) { try { macNotify('미믹노트', text); via.push('mac'); } catch { /* 맥이 아니면 무시 */ } }
        if (!via.length) via = ['미설정'];
        delivered.push({ id: member.id, via });
      }
    }

    // AI 하네스용 판단 기록(공개 저장소가 아니라 이 컴퓨터에만)
    const hdir = path.join(homeDir(env), 'harness');
    fs.mkdirSync(hdir, { recursive: true });
    fs.appendFileSync(path.join(hdir, 'decisions.jsonl'), JSON.stringify({
      at: now, rulesVersion: RULES_VERSION, fired: result.fired, escalations: result.escalations,
      notified: delivered, changed, aiCalled: ai.called > 0, aiCalls: ai.called,
    }) + '\n');
    // 규칙이 애매하다고 본 경우: 지금은 기록만 한다(AI 호출 기준은 AI 하네스가 정할 몫 — harness/README.md)
    if (result.escalations.length) log(`AI 검토 후보 ${result.escalations.length}건, 이번 회차 AI 호출 ${ai.called}회, 유효한 제안 ${ai.active.length}개`);

    log(`완료: 변경 ${changed ? '있음' : '없음'}, 알림 ${delivered.map((d) => `${d.id}(${d.via.join('+')})`).join(', ') || '없음'}, git ${pushed}`);
    return { changed, notes, delivered, pushed, result };
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  const dry = flags.has('--dry');
  if (dry) {
    const members = loadMembers();
    const r = computeAuto({ members, db: loadDb(), works: loadAllWorks(members) });
    for (const m of members) {
      const p = r.players[m.id];
      console.log(`■ ${m.name}(${m.id})`);
      p.important.forEach((x) => console.log(`  ⚡ ${x}`));
      p.todos.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
      if (!p.important.length && !p.todos.length) console.log('  (투두 없음)');
    }
    if (r.escalations.length) console.log(`\nAI 검토 후보 ${r.escalations.length}건`);
  } else {
    runOnce({ macNotifyOn: flags.has('--mac-notify') }).then(
      () => process.exit(0),
      (e) => { console.error(`[${new Date().toISOString()}] 실패: ${e.message}`); process.exit(1); },
    );
  }
}
