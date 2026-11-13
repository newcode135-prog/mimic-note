#!/usr/bin/env node
// 패시브 스킬 [1차 압축] — 10초마다 Claude Code 대화 기록(~/.claude/projects/**/*.jsonl)에서
// '새로 생긴 줄만' 읽어, 이 컴퓨터의 초안(~/.mimic-note/drafts/<아이디>/<세션>.jsonl)에 짧게 쌓는다.
// 저장소에는 아무것도 쓰지 않는다(공개 저장소 · 대전제 비밀 조항). 최종 정리·push 는 액티브 스킬 [로그아웃](logout.mjs).
//
//   node mimic-note/passive/compress.mjs              한 번 실행(launchd 가 10초마다 부름)
//   node mimic-note/passive/compress.mjs --show       지금 초안 보기
//
// 누가 접속했는지는 체크인이 남기는 ~/.mimic-note/session.json 으로 안다(없으면 아무것도 안 함).
// 쌓는 것: 사용자 요청(ask) · Claude 답 앞부분(answer) · git commit 제목(commit) · 대화에 나온 [ ] 라벨(label)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME_DIR = () => process.env.MIMIC_NOTE_HOME || path.join(os.homedir(), '.mimic-note');
const PROJECTS = () => process.env.MIMIC_NOTE_TRANSCRIPTS || path.join(os.homedir(), '.claude', 'projects');
const LIMIT = { ask: 300, answer: 400, commit: 160 };

// 공개 저장소로 갈 수 있는 글이라 1차 압축 단계에서 비밀처럼 보이는 것을 지운다.
export function scrub(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<이메일>')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<봇토큰>')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g, '<토큰>')
    .replace(/\b([A-Z][A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|CHAT_IDS?)[A-Z0-9_]*)\s*=\s*\S+/g, '$1=<비밀>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<IP>')
    .replace(/-?\b\d{9,}\b/g, '<번호>')
    .replace(/\/(Users|home)\/[^/\s]+/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// 대화 기록 한 줄 → 초안 항목들(0개 이상)
export function extract(line) {
  let d;
  try { d = JSON.parse(line); } catch { return []; }
  const at = d.timestamp || null;
  const c = d.message?.content;
  const out = [];
  if (d.type === 'user' && typeof c === 'string' && !d.isMeta && !c.startsWith('<')) {
    out.push({ at, kind: 'ask', text: cut(scrub(c), LIMIT.ask) });
  }
  if (d.type === 'assistant' && Array.isArray(c)) {
    for (const x of c) {
      // 작업 중 짧은 혼잣말("Now tests:")은 빼고 사용자에게 한 답만
      if (x.type === 'text' && x.text?.trim().length >= 60) out.push({ at, kind: 'answer', text: cut(scrub(x.text), LIMIT.answer) });
      if (x.type === 'tool_use' && typeof x.input?.command === 'string') {
        const m = x.input.command.match(/git commit[^\n]*?-m\s+["']([^"'\n]+)/);
        if (m) out.push({ at, kind: 'commit', text: cut(scrub(m[1]), LIMIT.commit) });
      }
    }
  }
  for (const e of [...out]) {
    if (e.kind === 'commit') continue;
    for (const m of e.text.matchAll(/\[[^\[\]\n]{1,20}(\s*\[[^\[\]\n]{0,20}\])*\s*\]/g)) out.push({ at, kind: 'label', text: m[0] });
  }
  return out;
}

export function latestTranscript(dir = PROJECTS()) {
  let best = null;
  for (const p of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const sub = path.join(dir, p);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(sub, f);
      const t = fs.statSync(full).mtimeMs;
      if (!best || t > best.t) best = { file: full, t };
    }
  }
  return best?.file || null;
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export const draftPath = (player, session, home = HOME_DIR()) => path.join(home, 'drafts', player, `${session}.jsonl`);

export function loadDraft(player, session, home = HOME_DIR()) {
  const f = draftPath(player, session, home);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// 한 번 실행: 지난번 읽은 자리(offset) 뒤의 '완성된 줄'만 읽는다 → 10초마다 돌아도 가볍다.
export function compressOnce({ home = HOME_DIR(), transcript = latestTranscript() } = {}) {
  const session = readJson(path.join(home, 'session.json'), null);
  if (!session?.player || !transcript) return { added: 0, reason: !session?.player ? '접속한 플레이어 없음' : '대화 기록 없음' };
  const sid = path.basename(transcript, '.jsonl');
  const stateFile = path.join(home, 'drafts', 'state.json');
  const state = readJson(stateFile, {});
  const st = state[transcript] || { offset: 0 };
  const size = fs.statSync(transcript).size;
  if (size < st.offset) st.offset = 0;
  if (size === st.offset) return { added: 0, session: sid };
  const fd = fs.openSync(transcript, 'r');
  const buf = Buffer.alloc(size - st.offset);
  fs.readSync(fd, buf, 0, buf.length, st.offset);
  fs.closeSync(fd);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { added: 0, session: sid };
  const chunk = buf.subarray(0, lastNl + 1).toString('utf8');
  const since = session.at || null;
  const prev = new Set(loadDraft(session.player, sid, home).map((e) => `${e.kind}|${e.text}`));
  const items = [];
  for (const line of chunk.split('\n')) {
    for (const e of extract(line)) {
      if (since && e.at && e.at < since) continue; // 체크인 전 대화는 다른 사람 것일 수 있다
      const k = `${e.kind}|${e.text}`;
      if (prev.has(k)) continue;
      prev.add(k);
      items.push(e);
    }
  }
  const df = draftPath(session.player, sid, home);
  fs.mkdirSync(path.dirname(df), { recursive: true });
  if (items.length) fs.appendFileSync(df, items.map((e) => JSON.stringify(e)).join('\n') + '\n');
  st.offset += lastNl + 1;
  state[transcript] = st;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return { added: items.length, session: sid, player: session.player };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--show')) {
      const s = readJson(path.join(HOME_DIR(), 'session.json'), null);
      const t = latestTranscript();
      if (!s || !t) { console.log('접속한 플레이어나 대화 기록이 없습니다.'); process.exit(0); }
      for (const e of loadDraft(s.player, path.basename(t, '.jsonl'))) console.log(`${e.kind}\t${e.text}`);
    } else {
      const r = compressOnce();
      if (r.added) console.log(`${new Date().toISOString()} 1차 압축 +${r.added} (${r.player}, ${r.session})`);
    }
  } catch (e) {
    console.error(`1차 압축 실패: ${e.message}`);
    process.exit(1);
  }
}
