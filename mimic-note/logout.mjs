#!/usr/bin/env node
// 액티브 스킬 [로그아웃] — 패시브 스킬 [1차 압축]이 쌓아 둔 초안을 최종 형식으로 확정하고, 자기 칸에 [업로드](commit·push)한다.
//
//   node mimic-note/logout.mjs <이름>                    ① 1차 압축 마무리 → 미리 채운 최종본 경로·초안·형식 규칙 출력
//   node mimic-note/logout.mjs <이름> --upload [파일]     ② 형식·분량 검사 → uploads/ 저장 → 작업 기록 3단계 → commit·push(한 번에)
//        --stay                 중간 업로드: 접속을 유지해 패시브 1차 압축이 계속 쌓인다
//        --replace <업로드이름>  덮어쓰기(예: 2026-11-13-대화-5.md). 이전 내용은 git 기록 + uploads/.history/ 에 남는다
// 데이터 유실 방지: 새 업로드는 기존 파일을 절대 덮지 않고, ①을 다시 해도 고치던 최종본은 .bak 으로 남긴다.
//
// ①과 ② 사이에 Claude Code 가 최종본(라벨·결정·다음)을 고친다. 규칙(형식·상한·하한)은 FORMAT 한 곳에서 정한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, requireMember } from './lib.mjs';
import { loadWork, saveWork, recordWork } from './work.mjs';
import { HOME_DIR, compressOnce, latestTranscript, loadDraft, draftPath, scrub } from './passive/compress.mjs';

// 형식 고정 + 분량 상한·하한 (업로드 규칙 v1)
export const FORMAT = {
  version: 'upload-v1',
  sections: ['## 1. [데이터 라벨링]', '## 2. [데이터 압축]', '## 3. 다음'],
  labels: [1, 6], // 라벨 표의 줄 수
  decisions: [3, 10], // 번호 붙은 결정 줄 수
  next: [1, 3], // '- ' 줄 수
  chars: [400, 3000], // 전체 글자 수
};

const between = (n, [lo, hi]) => n >= lo && n <= hi;

export function validate(text, f = FORMAT) {
  const errors = [];
  if (!/^# \[업로드\] /.test(text)) errors.push('첫 줄은 "# [업로드] 날짜 대화 N — 이름 × Claude Code"');
  const idx = f.sections.map((s) => text.indexOf(s));
  f.sections.forEach((s, i) => { if (idx[i] === -1) errors.push(`"${s}" 칸이 없습니다`); });
  if (idx.some((x, i) => x === -1 || (i && x < idx[i - 1]))) return { ok: false, errors: errors.length ? errors : ['칸 순서는 1 라벨링 → 2 압축 → 3 다음'] };
  const part = (i) => text.slice(idx[i], idx[i + 1] ?? text.length).split('\n').slice(1);
  const labels = part(0).filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).length - 1; // 머리줄 제외
  const decisions = part(1).filter((l) => /^\d+\.\s/.test(l)).length;
  const next = part(2).filter((l) => /^-\s/.test(l)).length;
  const chars = [...text].length;
  const check = (name, n, range) => { if (!between(n, range)) errors.push(`${name} ${n}개 — ${range[0]}~${range[1]}개여야 합니다`); };
  check('라벨', Math.max(labels, 0), f.labels);
  check('결정', decisions, f.decisions);
  check('다음 할 일', next, f.next);
  if (!between(chars, f.chars)) errors.push(`전체 ${chars}자 — ${f.chars[0]}~${f.chars[1]}자여야 합니다`);
  if (scrub(text).includes('<이메일>') || scrub(text).includes('<토큰>') || scrub(text).includes('<봇토큰>') || scrub(text).includes('=<비밀>')) errors.push('비밀처럼 보이는 것(이메일·토큰)이 있습니다 — 공개 저장소(대전제 비밀 조항)');
  return { ok: !errors.length, errors, counts: { labels, decisions, next, chars } };
}

const uploadsDir = (id, dir = NOTE_DIR) => path.join(dir, 'data', 'players', id, 'uploads');

export function nextUploadName(id, date, dir = NOTE_DIR) {
  const d = uploadsDir(id, dir);
  const nums = (fs.existsSync(d) ? fs.readdirSync(d) : []).map((f) => f.match(new RegExp(`^${date}-대화-(\\d+)\\.md$`))?.[1]).filter(Boolean).map(Number);
  return `${date}-대화-${(nums.length ? Math.max(...nums) : 0) + 1}.md`;
}

const top = (arr, n) => [...arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);

// 초안 → 미리 채운 최종본(규칙 형식). Claude 는 이걸 고치기만 하면 된다.
export function skeleton(member, draft, name) {
  const asks = draft.filter((e) => e.kind === 'ask').map((e) => e.text);
  const commits = draft.filter((e) => e.kind === 'commit').map((e) => e.text);
  const labels = top(draft.filter((e) => e.kind === 'label').map((e) => e.text), FORMAT.labels[1]);
  const decisions = (commits.length ? commits : asks).slice(-FORMAT.decisions[1]);
  return [
    `# [업로드] ${name.replace(/\.md$/, '').replace(/-대화-/, ' 대화 ')} — ${member.name} × Claude Code`,
    '',
    `> 위치: ${member.name}의 자기 칸 · 비밀 정보 제외 · 형식 ${FORMAT.version}`,
    '',
    FORMAT.sections[0],
    '',
    '| 라벨 | 묶은 것들 | 공통점 |',
    '| --- | --- | --- |',
    ...(labels.length ? labels : ['[ ]']).map((l) => `| ${l} | (채우기) | (채우기) |`),
    '',
    FORMAT.sections[1],
    '',
    ...decisions.map((d, i) => `${i + 1}. ${d}`),
    '',
    FORMAT.sections[2],
    '',
    `- ${asks.at(-1) || '(채우기)'}`,
    '',
  ].join('\n');
}

const sessionFile = (home = HOME_DIR()) => path.join(home, 'session.json');

export function prepare(member, { home = HOME_DIR(), transcript = latestTranscript(), dir = NOTE_DIR, date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) } = {}) {
  compressOnce({ home, transcript });
  const sid = transcript ? path.basename(transcript, '.jsonl') : 'none';
  const draft = loadDraft(member.id, sid, home);
  const name = nextUploadName(member.id, date, dir);
  const finalFile = draftPath(member.id, sid, home).replace(/\.jsonl$/, '.final.md');
  fs.mkdirSync(path.dirname(finalFile), { recursive: true });
  if (fs.existsSync(finalFile)) fs.copyFileSync(finalFile, finalFile.replace(/\.md$/, `.${Date.now()}.bak.md`)); // 고치던 것 보존
  fs.writeFileSync(finalFile, skeleton(member, draft, name));
  return { finalFile, name, draft };
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

export function upload(member, file, { dir = NOTE_DIR, home = HOME_DIR(), push = true, stay = false, replace = null, date = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const v = validate(text);
  if (!v.ok) throw new Error(`형식 검사 실패(${FORMAT.version}):\n- ${v.errors.join('\n- ')}`);
  const up = uploadsDir(member.id, dir);
  fs.mkdirSync(up, { recursive: true });
  let name = nextUploadName(member.id, date, dir);
  let replaced = null;
  if (replace) {
    name = path.basename(replace);
    const old = path.join(up, name);
    if (!fs.existsSync(old)) throw new Error(`덮어쓸 업로드가 없습니다: ${name}`);
    const hist = path.join(up, '.history');
    fs.mkdirSync(hist, { recursive: true });
    replaced = path.join(hist, `${name.replace(/\.md$/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.copyFileSync(old, replaced); // 이전 판 보존
  } else if (fs.existsSync(path.join(up, name))) {
    throw new Error(`이미 있는 업로드라 덮지 않습니다: ${name}`);
  }
  fs.writeFileSync(path.join(up, name), text);
  const target = `대화-${name.replace(/\.md$/, '').replace(/-대화-/, '-')}`;
  const work = loadWork(member.id, dir);
  recordWork(work, { stage: 'labeling', target, status: 'done', note: `[ ] 라벨 ${v.counts.labels}개` });
  recordWork(work, { stage: 'compression', target, status: 'done', note: `결정 ${v.counts.decisions}개, ${v.counts.chars}자` });
  recordWork(work, { stage: 'upload', target, status: 'done', note: `uploads/${name}${replaced ? ` (덮어씀, 이전 판 ${path.relative(up, replaced)})` : ''}` });
  saveWork(work, dir);
  let pushed = 'skipped';
  if (push) {
    const root = path.resolve(dir, '..');
    // 자기 칸 + 공용 게시판(투두리스트.md)을 함께 보낸다
    const rels = [path.relative(root, path.join(dir, 'data', 'players', member.id)), path.relative(root, path.join(dir, '투두리스트.md'))].filter((r) => fs.existsSync(path.join(root, r)));
    git(root, ['add', ...rels]);
    git(root, ['commit', '-q', '-m', `[업로드] ${member.name}: ${name.replace(/\.md$/, '')} (${replaced ? '덮어쓰기' : stay ? '중간 업로드' : '[로그아웃]'})`, '--', ...rels]);
    pushed = 'failed';
    for (let i = 0; i < 3 && pushed !== 'pushed'; i++) {
      try { git(root, ['push', '-q', 'origin', 'HEAD']); pushed = 'pushed'; } catch { git(root, ['pull', '-q', '--rebase', '--autostash']); }
    }
  }
  if (!stay) fs.rmSync(sessionFile(home), { force: true }); // 로그아웃: 패시브 1차 압축이 멈춘다
  return { name, pushed, counts: v.counts, replaced };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const member = requireMember(args[0], loadMembers());
    const t0 = Date.now();
    if (args.includes('--upload')) {
      const f = args[args.indexOf('--upload') + 1] || prepare(member).finalFile;
      const r = upload(member, f, { stay: args.includes('--stay'), replace: args.includes('--replace') ? args[args.indexOf('--replace') + 1] : null });
      console.log(`[로그아웃] ${member.name}님 업로드 완료: uploads/${r.name} · 라벨 ${r.counts.labels} · 결정 ${r.counts.decisions} · ${r.counts.chars}자 · push ${r.pushed}${r.replaced ? ' · 덮어씀(이전 판 보존)' : ''}${args.includes('--stay') ? ' · 접속 유지' : ' · 로그아웃'} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
    } else {
      const r = prepare(member);
      const asks = r.draft.filter((e) => e.kind === 'ask').length;
      const commits = r.draft.filter((e) => e.kind === 'commit').length;
      console.log([
        `[로그아웃] ${member.name}님 — 1차 압축 ${r.draft.length}개(요청 ${asks} · 커밋 ${commits})`,
        `미리 채운 최종본: ${r.finalFile}  (→ uploads/${r.name})`,
        `형식 ${FORMAT.version}: 라벨 ${FORMAT.labels.join('~')}줄 · 결정 ${FORMAT.decisions.join('~')}줄 · 다음 ${FORMAT.next.join('~')}줄 · ${FORMAT.chars.join('~')}자`,
        `고친 뒤: node mimic-note/logout.mjs ${member.id} --upload "${r.finalFile}"`,
        '',
        fs.readFileSync(r.finalFile, 'utf8'),
      ].join('\n'));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
