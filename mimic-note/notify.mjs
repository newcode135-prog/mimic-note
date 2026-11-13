#!/usr/bin/env node
// 미믹노트 알림 — GitHub Actions(.github/workflows/mimic-checkin.yml)에서 실행한다.
//
// 1) 장부의 "마지막으로 확인된 커밋(verifiedSha)"부터 지금 main 까지를 push 단위로 나눈다(push 기록 = 저장소 활동 API,
//    [skip ci] push·force push 도 남는다). push 마다 그 push 를 한 GitHub 계정의 권한을 "확인된 상태"의 명부로 확인한다:
//    미션 만들기·수정·후순위 = 관리자, 본인 미션 완료 = 본인, 삭제·명부 변경 = 대표관리자(저장소 주인 계정은 모두 가능).
//    권한 없는 변경·깨진 데이터는 확인된 상태로 올리지 않는다 → 그 내용은 발송되지 않고, 실행은 실패, 대표관리자에게 경고.
//    그 뒤 push 는 계속 "확인된 상태"와 비교하므로, 관리자 이상이 다시 저장하거나 되돌릴 때까지 보류된다.
//    main 기록이 다시 쓰이면(force push) 저장소 관리자가 실행할 때만 다시 기준을 잡고, 그 전에는 아무것도 보내지 않는다.
// 2) 확인된 변경에서 텔레그램 메시지가 실제로 달라진 팀원만 고른다(안 바뀐 사람에게는 안 보냄).
// 3) 그 팀원의 "확인된 최신 상태" 기준 남은 미션을 그 사람 chat id 로만 보낸다. sendMessage 응답(ok·message_id·chat.id)까지 확인.
// 4) 장부(.mimic-note-ledger/ledger.json, Actions 캐시)에 사람별 마지막 발송 메시지 해시를 남겨 같은 내용은 다시 안 보낸다.
//    미연결·토큰 없음·실패는 '보류'로 남겨 다음 실행(10분 정기 검사 포함)에서 다시 시도한다.
// 한계: 쓰기 권한이 있는 사람은 이 파일이나 워크플로 자체를 고쳐 push 할 수 있다(그 push 의 코드가 실행됨).
//       이 확인은 실수·직접 수정을 잡는 감지 장치이고, 완전한 차단은 GitHub 쪽 권한(쓰기 권한 범위·규칙)으로만 된다.
// 로그에는 토큰·chat id 를 쓰지 않는다. 결과는 `MIMIC_RESULT {...}`·`MIMIC_PROBLEM {...}`·`MIMIC_COVERS [...]` 줄(Claude Code 가 읽음).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADMIN_ROLES, findMember, memberByGithub, openMissions, doneMissions, validateDb, validateMembers, chatIdFor, telegramApi } from './lib.mjs';

export const DATA = { db: 'mimic-note/data/missions.json', members: 'mimic-note/data/members.json' };
const WORKFLOW = 'mimic-checkin.yml';
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (i) => KEYCAPS[i] || `${i + 1}.`;

// 팀원 한 명의 텔레그램 메시지(HTML). 상위 3개는 크게, 설명과 4번부터는 눌러서 펼치기.
// 제목·순서·진행률은 모두 DB 에서 계산한다. justDone: 이번 변경에서 끝낸 미션 제목(맨 위에 "✅ 방금 완료").
export function renderTelegram(member, db, { justDone = [] } = {}) {
  const open = openMissions(db, member.id);
  const done = doneMissions(db, member.id).length;
  const lines = ['🎯 <b>MIMIC NOTE</b>', ''];
  if (justDone.length) lines.push(...justDone.slice(0, 5).map((t) => `✅ 방금 완료: ${esc(clip(t, 120))}`), '');
  lines.push(`👤 <b>${esc(member.name)}님의 미션</b>`, '');
  if (!open.length) lines.push('🎉 남은 미션이 없어요!', '');
  open.slice(0, 3).forEach((m, i) => {
    lines.push(`${num(i)} ${esc(clip(m.title, 200))}${m.priority === 'low' ? ' <i>(후순위)</i>' : ''}`);
    if (m.detail) lines.push(`<blockquote expandable>${esc(clip(m.detail, 600))}</blockquote>`);
    lines.push('');
  });
  const rest = open.slice(3);
  if (rest.length) {
    const shown = rest.slice(0, 30).map((m, i) => `${num(i + 3)} ${esc(clip(m.title, 120))}${m.priority === 'low' ? ' (후순위)' : ''}`);
    if (rest.length > 30) shown.push(`… 외 ${rest.length - 30}개`);
    lines.push(`➕ 추가 미션 ${rest.length}개 (눌러서 전체 보기)`, `<blockquote expandable>${shown.join('\n')}</blockquote>`, '');
  }
  lines.push('━━━━━━━━━━', '', `📊 진행률 ${done}/${open.length + done}`, `📌 남은 미션 ${open.length}개`);
  return lines.join('\n');
}

// 미션을 준 사람(createdBy)에게 가는 완료 알림. 진행률은 보내는 시점의 확인된 상태 기준.
export function renderDoneNotice(assignee, titles, db) {
  const open = openMissions(db, assignee.id).length;
  const done = doneMissions(db, assignee.id).length;
  return ['✅ <b>MIMIC NOTE 완료 알림</b>', '', `👤 ${esc(assignee.name)}님이 미션을 완료했어요`, ...titles.slice(0, 10).map((t) => `• ${esc(clip(t, 120))}`), '',
    `📊 ${esc(assignee.name)}님 진행률 ${done}/${open + done} · 남은 미션 ${open}개`].join('\n');
}

export const hashText = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

export function changedMembers(baseDb, headDb, members) {
  return members.filter((m) => renderTelegram(m, baseDb) !== renderTelegram(m, headDb)).map((m) => m.id);
}

// push 한 계정(actor)이 base → head 변경을 할 권한이 있었는지. 위반 문구 목록을 돌려준다(빈 배열이면 통과).
export function verifyChange({ base, head, actor, repoAdmin = false }) {
  if (repoAdmin) return [];
  const who = memberByGithub(actor, base.members);
  const label = who ? `${who.name}(${actor})` : `${actor}(명부에 없는 GitHub 아이디)`;
  const isOwner = who?.role === 'owner';
  const isAdmin = ADMIN_ROLES.has(who?.role);
  const v = [];
  if (JSON.stringify(base.members) !== JSON.stringify(head.members) && !isOwner) v.push(`${label}: 팀원 명부(members.json)는 대표관리자만 바꿀 수 있습니다`);
  if (head.db.nextId < base.db.nextId && !isOwner) v.push(`${label}: nextId 를 줄일 수 없습니다`);
  const before = new Map(base.db.missions.map((m) => [m.id, m]));
  const seen = new Set();
  for (const m of head.db.missions) {
    seen.add(m.id);
    const b = before.get(m.id);
    if (!b) {
      if (!isAdmin) v.push(`${label}: ${m.id} 추가(관리자만)`);
      continue;
    }
    if (isAdmin || JSON.stringify(b) === JSON.stringify(m)) continue;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(m)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(m[k]));
    const selfDone = who && b.assignee === who.id && m.assignee === who.id && b.status === 'todo' && m.status === 'done'
      && (m.doneBy == null || m.doneBy === who.id) && keys.every((k) => ['status', 'doneAt', 'doneBy'].includes(k));
    if (!selfDone) v.push(`${label}: ${m.id} 수정(${keys.join(', ')}) — 팀원은 본인 미션 완료만 가능`);
  }
  for (const id of before.keys()) if (!seen.has(id) && !isOwner) v.push(`${label}: ${id} 삭제(대표관리자만)`);
  return v;
}

// 한 커밋 시점의 데이터. 파일이 없으면 빈 DB, JSON 이 깨졌으면 error.
export function snapshot(git, sha) {
  try {
    return { db: git.json(sha, DATA.db) ?? { nextId: 1, missions: [] }, members: git.json(sha, DATA.members)?.members ?? [] };
  } catch (e) {
    return { db: { nextId: 1, missions: [] }, members: [], error: `JSON 깨짐: ${e.message}` };
  }
}
const schemaErrors = (s) => (s.error ? [s.error] : [...validateMembers(s.members), ...validateDb(s.db, s.members)]);

export function loadLedger(file) {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { verifiedSha: l.verifiedSha || null, owner: l.owner || null, members: l.members || {}, alerts: l.alerts || [], flagged: l.flagged || [], notices: l.notices || [] };
  } catch {
    return { verifiedSha: null, owner: null, members: {}, alerts: [], flagged: [], notices: [] };
  }
}

// deps: git(아래 makeGit 과 같은 모양), gh{pushes() → Map(push 후 커밋 → 계정), isRepoAdmin(login)},
//       send(token, chatId, text) → sendMessage 결과, ledger(loadLedger)
export async function runNotify({ env, git, gh, send, ledger, now = () => new Date().toISOString() }) {
  const results = [];
  const problems = [];
  const covered = [];
  const candidates = new Set();
  const completed = []; // 확인된 변경에서 todo → done 이 된 미션
  const head = git.head();
  const event = env.EVENT_NAME || 'workflow_dispatch';
  const owner = (env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
  const isRepoAdmin = async (login) => Boolean(login) && ((owner && String(login).toLowerCase() === owner) || Boolean(await gh.isRepoAdmin(login)));
  const valid = (s) => /^[0-9a-f]{40}$/.test(s || '') && !/^0+$/.test(s) && git.exists(s);
  const changed = (a, b) => git.blob(a, DATA.db) !== git.blob(b, DATA.db) || git.blob(a, DATA.members) !== git.blob(b, DATA.members);
  const flagged = new Set(ledger.flagged || []);
  // 같은 문제(커밋)는 처음 한 번만 실패·경고로 다루고, 그다음부터는 '아직 해결 안 됨' 경고로만 남긴다.
  const report = (p) => {
    p.known = Boolean(p.sha && flagged.has(p.sha));
    if (p.sha) flagged.add(p.sha);
    problems.push(p);
  };

  let verified = valid(ledger.verifiedSha) ? ledger.verifiedSha : null;
  let halted = false;
  // 기준(확인된 커밋)이 없거나 main 에 없으면(처음 실행·장부 유실·force push) 멈춘다(fail closed).
  // 다시 시작할 수 있는 건 저장소 관리자가 "지금 main 그대로"를 실행한 경우뿐: push 는 그 push 가 main 의 끝일 때, 또는 수동 실행.
  if (!verified || !git.isAncestor(verified, head)) {
    const ok = (event === 'push' ? env.AFTER_SHA === head : event === 'workflow_dispatch') && await isRepoAdmin(env.ACTOR);
    const before = event === 'push' && valid(env.BEFORE_SHA) && git.isAncestor(env.BEFORE_SHA, head) && !schemaErrors(snapshot(git, env.BEFORE_SHA)).length ? env.BEFORE_SHA : null;
    if (!ledger.verifiedSha && ok) verified = before || head; // 처음 실행·장부 없음: 관리자 실행이면 조용히 시작(그 push 자체는 확인)
    else {
      report({
        kind: ledger.verifiedSha ? 'history-rewrite' : 'no-ledger',
        sha: head,
        actor: env.ACTOR,
        detail: [ledger.verifiedSha ? `main 기록이 다시 쓰였습니다(확인된 커밋 ${String(ledger.verifiedSha).slice(0, 7)} 가 main 에 없음)` : '발송 장부(확인된 기준)가 없습니다',
          ok ? '저장소 관리자 실행이라 지금 main 을 새 기준으로 잡았습니다' : '저장소 주인 계정이 이 워크플로를 한 번 실행할 때까지 알림을 보내지 않습니다(gh workflow run mimic-checkin.yml -R newcode135-prog/mimic-note)'],
      });
      if (ok) verified = head;
      else halted = true;
    }
  }

  // 1) 확인된 커밋 이후를 push 단위로 확인
  if (!halted && verified !== head) {
    const pushes = await gh.pushes();
    if (event === 'push' && env.AFTER_SHA) pushes.set(env.AFTER_SHA, env.ACTOR);
    let base = snapshot(git, verified);
    let prev = verified;
    for (const c of git.firstParent(verified, head)) {
      if (!pushes.has(c)) continue;
      const actor = pushes.get(c);
      covered.push(c);
      const touched = changed(prev, c); // 이 push 자체가 데이터를 바꿨나
      prev = c;
      if (!changed(verified, c)) { verified = c; base = snapshot(git, c); continue; }
      if (!touched) continue; // 데이터를 안 건드린 push 는 앞의 미확인 변경을 이 사람 탓으로도, 승인으로도 치지 않는다
      const next = snapshot(git, c);
      const bad = schemaErrors(next);
      if (bad.length) { report({ kind: 'schema', sha: c, actor, detail: bad.slice(0, 10) }); continue; }
      const v = verifyChange({ base, head: next, actor, repoAdmin: await isRepoAdmin(actor) });
      if (v.length) { report({ kind: 'unauthorized', sha: c, actor, detail: v }); continue; }
      changedMembers(base.db, next.db, next.members).forEach((id) => candidates.add(id));
      const was = new Map(base.db.missions.map((m) => [m.id, m]));
      for (const m of next.db.missions) if (was.get(m.id)?.status === 'todo' && m.status === 'done') completed.push(m);
      verified = c;
      base = next;
    }
    // 남은 커밋에 데이터 변경이 없으면(기록 안 된 push 가 없거나, 문제 변경이 되돌려졌으면) 지금 main 까지 확인된 것
    if (!changed(verified, head)) verified = head;
  }

  // 2) 보낼 내용은 항상 "확인된 상태"에서 만든다(확인 안 된 변경은 보내지 않음)
  const cur = halted ? { db: { nextId: 1, missions: [] }, members: [] } : snapshot(git, verified);
  const curBad = halted ? [] : schemaErrors(cur);
  if (curBad.length) report({ kind: 'schema', sha: verified, detail: curBad.slice(0, 10) });
  for (const [id, s] of Object.entries(ledger.members)) if (s.pending) candidates.add(id);
  let forced = null;
  if (env.INPUT_MEMBER) {
    const m = findMember(env.INPUT_MEMBER, cur.members);
    if (!m) problems.push({ kind: 'unknown-member', known: false, detail: [`팀원을 찾지 못했습니다: ${env.INPUT_MEMBER}`] });
    else {
      candidates.add(m.id);
      if (env.INPUT_FORCE === 'true') forced = m.id;
    }
  }

  const justDone = new Map();
  for (const m of completed) justDone.set(m.assignee, [...(justDone.get(m.assignee) || []), m.title]);
  const fresh = new Map();
  for (const m of completed) {
    const to = cur.members.find((x) => x.id === m.createdBy);
    if (!to || to.id === (m.doneBy || m.assignee)) continue; // 스스로 만든·스스로 끝낸 미션은 알림 없음
    const k = `${to.id}:${m.assignee}`;
    const n = fresh.get(k) || { to: to.id, assignee: m.assignee, titles: [], keys: [] };
    n.titles.push(m.title);
    n.keys.push(`${m.id}@${m.doneAt}`);
    fresh.set(k, n);
  }
  const notices = [...(ledger.notices || []), ...fresh.values()];

  // 3) 발송
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!halted && !curBad.length) {
    for (const id of candidates) {
      const member = cur.members.find((m) => m.id === id);
      if (!member) { delete ledger.members[id]; continue; }
      const st = (ledger.members[id] ||= {});
      // 중복 판단은 "상태"만으로(방금 완료 줄은 빼고) — 나중 체크인이 같은 목록을 다시 보내지 않게
      const plain = renderTelegram(member, cur.db);
      const hash = hashText(plain);
      const jd = [...new Set([...(st.justDone || []), ...(justDone.get(id) || [])])].slice(-5);
      const text = jd.length ? renderTelegram(member, cur.db, { justDone: jd }) : plain;
      if (st.sentHash === hash && forced !== id) {
        st.pending = false;
        delete st.justDone;
        results.push({ member: id, status: 'already-sent' });
        continue;
      }
      const chatId = chatIdFor(id, env);
      if (!token || !chatId) {
        st.pending = true;
        if (jd.length) st.justDone = jd;
        results.push({ member: id, status: token ? 'unconnected' : 'unconfigured' });
        continue;
      }
      try {
        const r = await send(token, chatId, text);
        if (!r?.message_id || String(r.chat?.id) !== String(chatId)) throw new Error('sendMessage 응답이 올바르지 않음(message_id/chat 불일치)');
        Object.assign(st, { sentHash: hash, sentAt: now(), messageId: r.message_id, pending: false, lastError: null });
        delete st.justDone;
        results.push({ member: id, status: 'sent', messageId: r.message_id });
      } catch (e) {
        Object.assign(st, { pending: true, lastError: String(e.message).slice(0, 200) });
        if (jd.length) st.justDone = jd;
        results.push({ member: id, status: 'failed', error: String(e.message).slice(0, 200), code: e.code ?? null });
      }
    }
  }

  // 3-1) 미션을 준 사람에게 완료 알림. 미연결이면 버리고(전체미션으로 확인 가능), 발송 실패만 다음 실행에서 다시.
  const keep = [];
  if (halted || curBad.length) keep.push(...notices);
  else {
    for (const n of notices) {
      const to = cur.members.find((x) => x.id === n.to);
      const who = cur.members.find((x) => x.id === n.assignee);
      if (!to || !who) continue;
      const chatId = chatIdFor(to.id, env);
      const base = { member: to.id, kind: 'done-notice', about: who.id };
      if (!token || !chatId) { results.push({ ...base, status: token ? 'unconnected' : 'unconfigured' }); continue; }
      try {
        const r = await send(token, chatId, renderDoneNotice(who, n.titles, cur.db));
        if (!r?.message_id || String(r.chat?.id) !== String(chatId)) throw new Error('sendMessage 응답이 올바르지 않음(message_id/chat 불일치)');
        results.push({ ...base, status: 'sent', messageId: r.message_id });
      } catch (e) {
        keep.push({ ...n, tries: (n.tries || 0) + 1 });
        results.push({ ...base, status: 'failed', error: String(e.message).slice(0, 200), code: e.code ?? null });
      }
    }
  }
  ledger.notices = keep.filter((n) => n.tries === undefined || n.tries < 20).slice(-50);

  // 4) 새 문제(권한 없음·깨진 데이터·기록 다시 쓰기) → 대표관리자에게 경고(같은 커밋은 한 번만)
  // 경고 받을 대표관리자는 확인된 명부 기준(멈춘 실행은 지난번에 확인된 대표관리자) — 다시 쓰인 명부를 믿지 않는다
  const ownerMember = halted ? (ledger.owner ? { id: ledger.owner } : null) : cur.members.find((m) => m.role === 'owner');
  const ownerChat = ownerMember && chatIdFor(ownerMember.id, env);
  for (const p of problems.filter((x) => x.sha && !x.known && !ledger.alerts.includes(x.sha))) {
    if (!token || !ownerChat) continue;
    const what = { unauthorized: '권한 없는 미션 변경', schema: '깨진 미션 데이터', 'history-rewrite': 'main 기록 다시 쓰기(force push)' }[p.kind] || p.kind;
    const text = ['⚠️ <b>MIMIC NOTE 경고</b>', '', `${what}을(를) 감지해 그 내용은 팀원에게 보내지 않았어요.`, ...(p.detail || []).slice(0, 8).map((d) => `• ${esc(d)}`), '', `커밋 ${p.sha.slice(0, 7)}${p.actor ? ` · ${esc(p.actor)}` : ''}`].join('\n');
    try {
      await send(token, ownerChat, text);
      ledger.alerts = [...ledger.alerts, p.sha].slice(-50);
      results.push({ member: ownerMember.id, status: 'alert' });
    } catch (e) {
      results.push({ member: ownerMember.id, status: 'failed', error: `경고 발송 실패: ${String(e.message).slice(0, 150)}` });
    }
  }

  if (!halted && !curBad.length) { // 멈춘 실행·깨진 상태는 기준으로 저장하지 않는다
    ledger.verifiedSha = verified;
    if (ownerMember) ledger.owner = ownerMember.id;
  }
  ledger.flagged = [...flagged].slice(-100);
  return { results, problems, covered, ledger, head, verified, halted };
}

function makeGit(cwd) {
  const g = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
  const ok = (...a) => { try { g(...a); return true; } catch { return false; } };
  return {
    fetch: () => g('fetch', '-q', 'origin', 'main'),
    head: () => g('rev-parse', 'origin/main'),
    exists: (s) => ok('cat-file', '-e', `${s}^{commit}`),
    isAncestor: (a, b) => ok('merge-base', '--is-ancestor', a, b),
    firstParent: (a, b) => g('rev-list', '--first-parent', '--reverse', `${a}..${b}`).split('\n').filter(Boolean),
    blob: (s, f) => { try { return g('rev-parse', `${s}:${f}`); } catch { return null; } },
    json(s, f) {
      if (!this.blob(s, f)) return undefined;
      return JSON.parse(g('show', `${s}:${f}`));
    },
  };
}

function makeGh(env) {
  const base = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const get = async (p) => {
    const r = await fetch(base + p, { headers });
    if (!r.ok) throw new Error(`GitHub API ${p.split('?')[0]} → ${r.status}`);
    return r.json();
  };
  return {
    // push 후 커밋 → push 한 계정. 저장소 활동 기록([skip ci]·force push·PR 병합 포함)이 우선, 안 되면 이 워크플로의 push 실행 기록.
    async pushes() {
      try {
        const j = await get('/activity?ref=refs%2Fheads%2Fmain&per_page=100');
        return new Map(j.filter((a) => a.after && a.actor?.login && !/^branch_/.test(a.activity_type || '')).map((a) => [a.after, a.actor.login]));
      } catch (e) {
        console.log(`::warning title=미믹노트::저장소 활동 기록을 못 읽어 Actions 실행 기록으로 push 한 사람을 확인합니다(${e.message})`);
        const j = await get(`/actions/workflows/${WORKFLOW}/runs?event=push&branch=main&per_page=100`);
        return new Map(j.workflow_runs.map((r) => [r.head_sha, r.actor?.login]));
      }
    },
    async isRepoAdmin(login) {
      try { return (await get(`/collaborators/${encodeURIComponent(login)}/permission`)).permission === 'admin'; } catch { return false; }
    },
  };
}

const LABEL = { sent: '발송 성공', 'already-sent': '같은 내용 이미 보냄', unconnected: '미연결', unconfigured: '봇 토큰 미설정', failed: '실패', alert: '대표관리자 경고' };

async function main() {
  const env = process.env;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ledgerFile = path.join(root, '.mimic-note-ledger', 'ledger.json');
  const git = makeGit(root);
  git.fetch();
  const ledger = loadLedger(ledgerFile);
  const before = JSON.stringify(ledger);
  const r = await runNotify({ env, git, gh: makeGh(env), send: (token, chatId, text) => telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), ledger });

  console.log(`미믹노트 알림: 이벤트 ${env.EVENT_NAME} · main ${r.head.slice(0, 7)} · 확인된 상태 ${String(r.verified).slice(0, 7)}`);
  console.log(`MIMIC_COVERS ${JSON.stringify(r.covered)}`);
  for (const x of r.results) console.log(`MIMIC_RESULT ${JSON.stringify(x)}`);
  if (!r.results.length) console.log('보낼 대상 없음(바뀐 팀원·보류된 알림 없음)');
  for (const p of r.problems) {
    console.log(`MIMIC_PROBLEM ${JSON.stringify({ kind: p.kind, sha: p.sha, actor: p.actor, known: p.known, detail: p.detail })}`);
    console.log(`::${p.known ? 'warning' : 'error'} title=미믹노트 ${p.kind}${p.known ? '(아직 해결 안 됨)' : ''}::${[p.sha && `커밋 ${p.sha.slice(0, 7)}`, p.actor, ...(p.detail || [])].filter(Boolean).join(' / ')}`);
  }
  for (const x of r.results.filter((y) => y.status === 'unconfigured' || y.status === 'unconnected')) console.log(`::warning title=미믹노트::${x.member}: ${LABEL[x.status]} — 보류해 두었다가 연결되면 보냅니다`);

  if (env.GITHUB_STEP_SUMMARY) {
    const rows = r.results.map((x) => `| ${x.member} | ${LABEL[x.status] || x.status} | ${x.error ? String(x.error).replace(/\|/g, '/') : ''} |`);
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ['### 미믹노트 알림', '', '| 팀원 | 결과 | 비고 |', '| --- | --- | --- |', ...(rows.length ? rows : ['| - | 보낼 대상 없음 | |']), '',
      ...r.problems.map((p) => `- ❌ ${p.kind}: ${(p.detail || []).join(' / ')}`), ''].join('\n'));
  }
  const changedLedger = JSON.stringify(r.ledger) !== before;
  if (changedLedger) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(r.ledger, null, 2)}\n`);
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `ledger_changed=${changedLedger}\n`);
  const failed = r.problems.some((p) => !p.known) || r.results.some((x) => x.status === 'failed');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log(`::error title=미믹노트 알림 오류::${e.message}`);
    process.exitCode = 1;
  });
}
