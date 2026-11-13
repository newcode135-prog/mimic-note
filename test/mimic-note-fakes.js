// 미믹노트 테스트용 가짜 GitHub·git·텔레그램 — 테스트는 실제 네트워크(gh, api.telegram.org)를 절대 부르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
export const DB_FILE = 'mimic-note/data/missions.json';
export const MEMBERS_FILE = 'mimic-note/data/members.json';

// mission.mjs·checkin.mjs 가 쓰는 github 어댑터와 같은 모양.
// dir: 임시 미믹노트 폴더(syncLocal 이 여기에 main 내용을 받아 둔다 = git pull 흉내)
// beforeWrite(store): 쓰기 직전에 다른 사람이 끼어드는 상황을 흉내 낼 때
export function fakeGithub({ dir, login = 'newcode135-prog', push = true, db = { nextId: 1, missions: [] }, members, beforeWrite, results = [] } = {}) {
  const store = new Map();
  // sha = git blob id(실제 GitHub Contents API 와 같게)
  const put = (p, text) => store.set(p, { text, sha: sha1(`blob ${Buffer.byteLength(text)}\0${text}`) });
  put(MEMBERS_FILE, members ? JSON.stringify({ members }, null, 2) : fs.readFileSync(path.join(dir, 'data', 'members.json'), 'utf8'));
  put(DB_FILE, `${JSON.stringify(db, null, 2)}\n`);
  const commits = [];
  const runs = [];
  let runId = 1000;
  const gh = {
    store, commits, runs, put, writes: 0, dispatched: [],
    whoami: () => login,
    access: () => ({ push }),
    readFile: (p, ref = 'main') => (ref === 'main' ? { ...store.get(p) } : { ...(gh.atVerified?.[p] || store.get(p)) }),
    verifiedSha: () => (gh.noVerified ? null : 'v'.repeat(40)),
    writeFile(p, text, sha, message) {
      gh.writes += 1;
      beforeWrite?.(gh);
      if (store.get(p).sha !== sha) return { conflict: true };
      put(p, text);
      const commit = sha1(`${text}#${commits.length}`);
      commits.push({ sha: commit, message });
      runs.push({ id: ++runId, event: 'push', head_sha: commit, status: 'completed', conclusion: 'success', html_url: `https://github.com/x/actions/runs/${runId}` });
      return { commit, url: `https://github.com/newcode135-prog/mimic-note/commit/${commit}` };
    },
    latestRunId: () => runs.at(-1)?.id || 0,
    runs(q) {
      return runs.filter((r) => (!q.includes('event=push') || r.event === 'push') && (!q.includes('event=workflow_dispatch') || r.event === 'workflow_dispatch')
        && (!q.includes('head_sha=') || q.includes(`head_sha=${r.head_sha}`)));
    },
    run: (id) => runs.find((r) => r.id === id),
    dispatch(member, force) {
      gh.dispatched.push({ member, force });
      runs.push({ id: ++runId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: `https://github.com/x/actions/runs/${runId}` });
    },
    log: () => results.map((r) => `notify\t바뀐 팀원에게 텔레그램 발송\t2026-11-13T00:00:00.0000000Z MIMIC_RESULT ${JSON.stringify(r)}`).join('\n'),
    syncLocal() {
      if (dir) fs.writeFileSync(path.join(dir, 'data', 'missions.json'), store.get(DB_FILE).text);
    },
  };
  return gh;
}

// notify.mjs 의 git 어댑터와 같은 모양. 일직선 커밋 기록: [{ files: { 경로: 내용 } }]
export function fakeGit(history) {
  const commits = [];
  const g = {
    commits,
    add(files) {
      const prev = commits.at(-1)?.files || {};
      const c = { sha: sha1(`commit-${commits.length}-${JSON.stringify(files)}`), files: { ...prev, ...files } };
      commits.push(c);
      return c.sha;
    },
    head: () => commits.at(-1).sha,
    exists: (s) => commits.some((c) => c.sha === s),
    isAncestor: (a, b) => commits.findIndex((c) => c.sha === a) <= commits.findIndex((c) => c.sha === b),
    firstParent: (a, b) => commits.slice(commits.findIndex((c) => c.sha === a) + 1, commits.findIndex((c) => c.sha === b) + 1).map((c) => c.sha),
    blob: (s, f) => {
      const v = commits.find((c) => c.sha === s)?.files[f];
      return v == null ? null : sha1(v);
    },
    json: (s, f) => {
      const v = commits.find((c) => c.sha === s)?.files[f];
      return v == null ? undefined : JSON.parse(v);
    },
  };
  for (const files of history || []) g.add(files);
  return g;
}

// sendMessage 흉내: chat id 별로 받은 메시지를 모은다. fail: { chatId: Error } 이면 그 사람만 실패.
export function fakeTelegram({ fail = {} } = {}) {
  const sent = [];
  let mid = 500;
  const send = async (token, chatId, text, extra = {}) => {
    if (fail[chatId]) throw fail[chatId];
    sent.push({ token, chatId, text, extra });
    return { message_id: ++mid, chat: { id: Number(chatId) } };
  };
  return { sent, send };
}
