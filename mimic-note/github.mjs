// 미믹노트 ↔ GitHub: 이 컴퓨터의 gh(GitHub CLI) 로그인 계정으로 main 의 미션 데이터를 읽고 쓰고,
// GitHub Actions 알림(.github/workflows/mimic-checkin.yml)의 실제 발송 결과를 확인한다.
//
// - 누가 바꾸는지는 `--by 이름` 이 아니라 gh 로그인 계정(GitHub 인증)으로 정한다.
// - 쓰기는 Contents API 에 파일 sha 를 붙여 보낸다: 그사이 다른 사람이 바꿨으면 GitHub 가 거절(409)하고,
//   우리는 최신본을 다시 읽어 같은 작업을 다시 적용한다. 강제로 덮어쓰지 않는다.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOTE_DIR, REPO, DB_FILE, MEMBERS_FILE } from './lib.mjs';

export { DB_FILE, MEMBERS_FILE };

export const WORKFLOW = 'mimic-checkin.yml';
const ROOT = path.resolve(NOTE_DIR, '..');

function gh(args, input) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('gh(GitHub CLI)가 없습니다. https://cli.github.com 에서 설치한 뒤 gh auth login 하세요.');
    const stderr = String(e.stderr || e.message || '').trim();
    throw Object.assign(new Error(stderr.split('\n').filter(Boolean).at(-1) || 'gh 실행 실패'), { stderr });
  }
}
const api = (p) => JSON.parse(gh(['api', p]) || 'null');

// `gh run view --log` 의 한 줄은 "<작업>\t<단계>\t<시각> <내용>". 내용 전체가 "MIMIC_VERIFIED <sha>" 인 줄만(notify.mjs 가 찍은 줄).
// 커밋의 바뀐 파일 목록(commits API files)에 미션 데이터가 있는지. 목록이 없거나 300개 이상(잘림)이면 있다고 본다.
export const changesData = (files) => !Array.isArray(files) || files.length >= 300
  || files.some((f) => [DB_FILE, MEMBERS_FILE].includes(f.filename) || [DB_FILE, MEMBERS_FILE].includes(f.previous_filename));

export const parseVerified = (log) => String(log).match(/^[^\t\n]*\t[^\t\n]*\t\S+ MIMIC_VERIFIED ([0-9a-f]{40})\r?$/m)?.[1] || null;

export function createGithub(repo = REPO) {
  const touched = new Map();
  const onMain = (sha) => /^[0-9a-f]{40}$/.test(sha || '') && ['ahead', 'identical'].includes(api(`repos/${repo}/compare/${sha}...main`).status);
  return {
    repo,
    whoami: () => gh(['api', 'user', '--jq', '.login']),
    access: () => api(`repos/${repo}`).permissions || {},
    readFile(file, ref = 'main') {
      const r = api(`repos/${repo}/contents/${file}?ref=${ref}`);
      return { text: Buffer.from(r.content, 'base64').toString('utf8'), sha: r.sha };
    },
    writeFile(file, text, sha, message) {
      const body = JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), sha, branch: 'main' });
      try {
        const r = JSON.parse(gh(['api', '-X', 'PUT', `repos/${repo}/contents/${file}`, '--input', '-'], body));
        return { commit: r.commit.sha, url: r.commit.html_url };
      } catch (e) {
        // sha 불일치(그사이 누가 바꿈)만 충돌. 규칙·보호 위반 같은 다른 409 는 그대로 오류로 보여 준다.
        if (/does not match|but expected/i.test(e.stderr || e.message)) return { conflict: true };
        throw e;
      }
    },
    // GitHub Actions(notify.mjs)가 마지막으로 "확인한 상태" 커밋(로그의 MIMIC_VERIFIED). 모르면 null.
    // 이 저장소 main 에서 push·정기·수동으로 돈 실행만(PR·다른 저장소·태그 실행은 워크플로를 바꿔 아무 줄이나 찍을 수 있음),
    // 취소·건너뛴 실행(로그 없음)은 넘기고, 로그 줄 전체가 "<시각> MIMIC_VERIFIED <sha>" 인 줄만 믿는다.
    verifiedSha() {
      for (const r of api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=100`).workflow_runs) {
        if (r.head_branch !== 'main' || !['push', 'schedule', 'workflow_dispatch'].includes(r.event) || r.head_repository?.full_name !== repo
          || ['cancelled', 'skipped'].includes(r.conclusion)) continue;
        try {
          if (!onMain(r.head_sha)) continue; // 실행한 커밋(그 워크플로 파일)이 main 에 있어야
          const sha = parseVerified(gh(['run', 'view', String(r.id), '-R', repo, '--log']));
          if (sha) return sha;
        } catch { /* 로그 없음 → 다음 실행 */ }
      }
      return null;
    },
    // base 에서 head 까지 main 의 첫 부모 사슬(head → base 쪽 순서, base 는 빼고). head 가 base 의 후손이 아니면 null.
    chain(base, head) {
      const r = api(`repos/${repo}/compare/${base}...${head}`);
      if (!['ahead', 'identical'].includes(r.status)) return null;
      const parent = new Map(r.commits.map((c) => [c.sha, c.parents[0]?.sha]));
      const out = [];
      for (let c = head; c !== base; c = parent.get(c)) {
        if (!parent.has(c) || out.length > 250) return null;
        out.push(c);
      }
      return out;
    },
    // 그 커밋이 미션 데이터(missions.json·members.json)를 바꿨는지(첫 부모 기준). 커밋 내용은 안 바뀌므로 기억해 둔다.
    // GitHub 는 바뀐 파일을 300개까지만 주므로, 목록이 없거나 300개 이상이면 "바꿨다"로 본다(모르면 믿지 않음).
    touchesData(sha) {
      if (!touched.has(sha)) {
        const files = api(`repos/${repo}/commits/${sha}`).files;
        touched.set(sha, changesData(files));
      }
      return touched.get(sha);
    },
    headSha: () => api(`repos/${repo}/git/ref/heads/main`).object.sha,
    // head 커밋 위에만 새 커밋을 만들고 main 을 빨리감기로만 옮긴다(그사이 main 이 바뀌면 422 → 충돌로 다시)
    commitFile(parent, file, text, message) {
      const post = (p, body) => JSON.parse(gh(['api', '-X', 'POST', p, '--input', '-'], JSON.stringify(body)));
      const blob = post(`repos/${repo}/git/blobs`, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });
      const base = api(`repos/${repo}/git/commits/${parent}`);
      const tree = post(`repos/${repo}/git/trees`, { base_tree: base.tree.sha, tree: [{ path: file, mode: '100644', type: 'blob', sha: blob.sha }] });
      const commit = post(`repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] });
      try {
        gh(['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/main`, '--input', '-'], JSON.stringify({ sha: commit.sha, force: false }));
      } catch (e) {
        if (/HTTP 422/.test(e.stderr || e.message)) return { conflict: true };
        throw e;
      }
      return { commit: commit.sha, url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha}` };
    },
    latestRunId: () => api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`).workflow_runs[0]?.id || 0,
    runs: (query) => api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=20&${query}`).workflow_runs,
    run: (id) => api(`repos/${repo}/actions/runs/${id}`),
    dispatch: (member, force = false) => gh(['workflow', 'run', WORKFLOW, '-R', repo, '--ref', 'main', '-f', `member=${member}`, '-f', `force=${force}`]),
    log: (id) => gh(['run', 'view', String(id), '-R', repo, '--log']),
    // 이 폴더가 main 이면 방금 GitHub 에 올린 내용을 받아 둔다(실패해도 무시 — 원본은 GitHub main).
    syncLocal() {
      try {
        if (execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim() === 'main') {
          execFileSync('git', ['-C', ROOT, 'pull', '-q', '--ff-only'], { stdio: 'pipe' });
        }
      } catch { /* 로컬 동기화 실패는 무시 */ }
    },
  };
}

// Actions 로그의 `MIMIC_RESULT {...}`(팀원별 실제 발송 결과), `MIMIC_PROBLEM {...}`(권한·데이터 문제),
// `MIMIC_COVERS [...]`(이 실행이 확인한 push 커밋들) 줄을 읽는다(notify.mjs 가 남김).
export function parseLog(log) {
  const out = { results: [], problems: [], covers: [] };
  for (const l of String(log || '').split('\n')) {
    const m = l.match(/MIMIC_(RESULT|PROBLEM|COVERS) (.*?)\s*$/);
    if (!m) continue;
    try {
      const v = JSON.parse(m[2]);
      if (m[1] === 'RESULT') out.results.push(v);
      else if (m[1] === 'PROBLEM') out.problems.push(v);
      else out.covers.push(...v);
    } catch { /* 형식이 다른 줄은 무시 */ }
  }
  return out;
}
export const parseResults = (log) => parseLog(log).results;

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

// 알림 실행을 찾아 끝날 때까지 기다린 뒤 결과를 돌려준다.
//   commit: 그 커밋이 들어간 push 의 실행. 실행이 다음 실행에 합쳐져 취소됐거나 앞선 실행이 먼저 처리했으면
//           MIMIC_COVERS 로 "그 커밋을 실제로 처리한 실행"을 찾아 그 결과를 보여 준다.
//   afterRunId+actor: 방금 내가 요청한 수동 실행. 취소되면 status 'cancelled'(부른 쪽이 한 번 다시 요청).
export async function waitForNotify(github, { commit, afterRunId = 0, actor, timeoutMs = 240000, sleep = sleeper, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  const settle = async (run) => {
    while (run.status !== 'completed' && now() < deadline) { await sleep(4000); run = github.run(run.id); }
    return run;
  };
  const read = (run) => {
    try { return { ...parseLog(github.log(run.id)), logError: null }; } catch (e) { return { results: [], problems: [], covers: [], logError: e.message }; }
  };
  const find = () => (commit ? github.runs(`event=push&head_sha=${commit}`) : github.runs(`event=workflow_dispatch&actor=${encodeURIComponent(actor)}`).filter((r) => r.id > afterRunId))
    .sort((a, b) => a.id - b.id)[0];
  let run = find();
  while (!run && now() < deadline) { await sleep(4000); run = find(); }
  if (!run) return { status: 'not-found' };
  run = await settle(run);
  if (run.status !== 'completed') return { status: 'timeout', run };
  if (!commit) return run.conclusion === 'cancelled' ? { status: 'cancelled', run } : { status: 'done', run, ...read(run) };

  const own = run.conclusion === 'cancelled' ? null : { run, ...read(run) };
  if (own && (own.logError || own.covers.includes(commit))) return { status: 'done', ...own };
  // 이 커밋을 처리한 다른 실행: 뒤 실행(기다림) → 앞 실행 순서로 최대 5개
  const all = github.runs('');
  const newer = all.filter((r) => r.id > run.id).sort((a, b) => a.id - b.id);
  const older = all.filter((r) => r.id < run.id).sort((a, b) => b.id - a.id);
  const others = [...newer, ...older].slice(0, 5);
  for (let o of others) {
    o = await settle(o);
    if (o.status !== 'completed' || o.conclusion === 'cancelled') continue;
    const r = read(o);
    if (r.covers.includes(commit)) return { status: 'done', run: o, ...r, coveredElsewhere: true };
  }
  return own ? { status: 'done', ...own } : { status: 'cancelled', run };
}

const LABEL = {
  sent: '✅ 발송 성공(텔레그램이 받았다고 응답)',
  'already-sent': '같은 내용을 이미 보냈음 — 중복 발송 안 함',
  unconnected: '⚠️ 텔레그램 미연결(node mimic-note/telegram.mjs connect)',
  unconfigured: '⚠️ 봇 토큰 미설정(GitHub 비밀값 TELEGRAM_BOT_TOKEN 없음)',
  failed: '❌ 발송 실패',
  alert: '⚠️ 대표관리자에게 경고 발송',
};
const KIND = { unauthorized: '권한 없는 변경 — 발송 보류', schema: '깨진 데이터 — 발송 보류', 'history-rewrite': 'main 기록 다시 쓰기 — 발송 중지', 'unknown-member': '없는 팀원' };

export function formatNotify(r, members = []) {
  const name = (id) => members.find((m) => m.id === id)?.name || id;
  if (r.status === 'not-found') return '📨 텔레그램: 알림 실행을 아직 찾지 못했습니다(GitHub Actions 지연). 나중에 확인: gh run list -R ' + REPO + ' -w mimic-checkin.yml';
  if (r.status === 'timeout') return `📨 텔레그램: 알림 실행이 아직 끝나지 않았습니다 — ${r.run.html_url}`;
  if (r.status === 'cancelled') return `📨 텔레그램: 알림 실행이 취소됐습니다(다른 실행과 겹침) — ${r.run.html_url}`;
  const lines = [`📨 텔레그램 알림 (GitHub Actions: ${r.run.conclusion === 'success' ? '성공' : r.run.conclusion})${r.coveredElsewhere ? ' — 이 변경을 처리한 실행' : ''}`];
  if (r.logError) lines.push(`  • 결과 로그를 읽지 못했습니다(${r.logError}) — 아래 실행 기록에서 확인하세요`);
  else if (!r.results.length && !r.problems.length) lines.push('  • 보낼 대상 없음(바뀐 팀원·보류된 알림 없음)');
  for (const x of r.results) lines.push(`  • ${name(x.member)}${x.kind === 'done-notice' ? `(완료 알림 — ${name(x.about)}님)` : ''}: ${LABEL[x.status] || x.status}${x.error ? ` — ${x.error}` : ''}`);
  for (const p of r.problems) lines.push(`  • ${KIND[p.kind] || p.kind}${p.known ? '(아직 해결 안 됨)' : ''}: ${(p.detail || []).join(' / ')}`);
  lines.push(`  실행 기록: ${r.run.html_url}`);
  return lines.join('\n');
}
