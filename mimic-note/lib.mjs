// 미믹노트 공통: 팀원 명부와 미션 데이터베이스(data/missions.json).
// Node 18 이상, 외부 패키지 없음. 데이터는 git 으로 공유되므로 바꾼 뒤 commit·push 해야 다른 사람에게 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_ROLES = new Set(['owner', 'admin']);
export const REPO = 'newcode135-prog/mimic-note';

export function loadMembers(dir = NOTE_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'members.json'), 'utf8')).members;
}

// '민호', 'minho', 'Minho', '민호님', '[민호' 모두 같은 사람으로 찾는다.
export function findMember(input, members) {
  const key = String(input || '').trim().replace(/^\[+|\]+$/g, '').trim().replace(/님$/, '').toLowerCase();
  if (!key) return null;
  return members.find((m) => m.id === key || m.name === key || (m.github && m.github.toLowerCase() === key)) || null;
}

export function requireMember(input, members) {
  const m = findMember(input, members);
  if (!m) throw new Error(`팀원을 찾지 못했습니다: "${input || ''}". 가능한 이름: ${members.map((x) => `${x.name}(${x.id})`).join(', ')}`);
  return m;
}

// ---- 환경변수(.env)와 텔레그램 ----

// 저장소 루트의 .env(git 에 안 올라감) + 실제 환경변수. 환경변수가 우선.
export function readEnv(rootDir = path.resolve(NOTE_DIR, '..'), env = process.env) {
  const out = {};
  const file = path.join(rootDir, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...out, ...env };
}

export function chatIdFor(memberId, env) {
  const direct = env[`TELEGRAM_CHAT_ID_${memberId.toUpperCase()}`];
  if (direct) return direct;
  if (env.TELEGRAM_CHAT_IDS) {
    try { return JSON.parse(env.TELEGRAM_CHAT_IDS)[memberId] || null; } catch { return null; }
  }
  return null;
}

// 429(요청 제한)는 retry_after 만큼, 5xx·네트워크 오류는 잠깐 쉬고 다시 보낸다(최대 tries 번).
// 오류 문구에 토큰이 들어간 URL 을 넣지 않는다. err.code = 텔레그램 error_code 또는 'network'.
export async function telegramApi(token, method, body, { tries = 3, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    let res;
    let json;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      last = Object.assign(new Error(`텔레그램 ${method} 실패: 네트워크 오류`), { code: 'network' });
      if (i < tries) await sleep(1000 * i);
      continue;
    }
    if (json.ok) return json.result;
    const code = json.error_code || res.status;
    last = Object.assign(new Error(`텔레그램 ${method} 실패: ${json.description || res.status}`), { code });
    if (code === 429 && i < tries) await sleep(Math.min(60, Number(json.parameters?.retry_after) || 1) * 1000);
    else if (code >= 500 && i < tries) await sleep(1000 * i);
    else break;
  }
  throw last;
}

// ---- 대전제: 모든 체크인에서 가장 먼저 보여 주는 규칙 ----

export function loadPremise(dir = NOTE_DIR) {
  return fs.readFileSync(path.join(dir, 'premise.md'), 'utf8').trim();
}

// ---- 미션 데이터베이스 ----

export function dbPath(dir = NOTE_DIR) {
  return path.join(dir, 'data', 'missions.json');
}

export function loadDb(dir = NOTE_DIR) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return { nextId: 1, missions: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 임시 파일에 쓴 뒤 바꿔치기해서, 쓰다가 끊겨도 파일이 깨지지 않게 한다.
export function saveDb(db, dir = NOTE_DIR) {
  const file = dbPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// 후순위(priority: 'low')는 맨 뒤로. 그다음 order 순.
const byOrder = (a, b) => (a.priority === 'low') - (b.priority === 'low') || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

// 그 팀원의 아직 끝나지 않은 미션(번호 순). 화면의 1번·2번·3번이 이 순서다.
// status: todo(진행) · done(완료) · replaced(미션설정으로 교체되어 보관 — 지우지 않고 기록으로 남김)
export function openMissions(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status === 'todo').sort(byOrder);
}

export function doneMissions(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status === 'done').sort(byOrder);
}

// 미션은 관리자(owner·admin)만 만든다.
export function addMission(db, { assignee, title, detail = '', by, top = false }, members, now = new Date().toISOString()) {
  const target = requireMember(assignee, members);
  const author = requireMember(by, members);
  if (!ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 미션을 만들 수 없습니다.`);
  if (!String(title || '').trim()) throw new Error('미션 제목이 비어 있습니다.');
  const mine = db.missions.filter((m) => m.assignee === target.id);
  const mission = {
    id: `M-${String(db.nextId).padStart(4, '0')}`,
    assignee: target.id,
    // top: 최우선 — 그 사람의 1번으로 들어간다
    order: top ? mine.reduce((min, m) => Math.min(min, m.order ?? 0), 1) - 1 : mine.reduce((max, m) => Math.max(max, m.order ?? 0), 0) + 1,
    title: String(title).trim(),
    detail: String(detail || '').trim(),
    status: 'todo',
    createdBy: author.id,
    createdAt: now,
    doneAt: null,
  };
  db.nextId += 1;
  db.missions.push(mission);
  return mission;
}

// ref: 화면 번호(1, 2, 3 …) 또는 미션 ID(M-0001).
// by(누가)를 주면 본인 미션이거나 관리자일 때만 완료할 수 있다(CLI 는 GitHub 로그인으로 by 를 정한다).
export function completeMission(db, memberId, ref, now = new Date().toISOString(), { by, members } = {}) {
  const open = openMissions(db, memberId);
  const key = String(ref || '').trim().toUpperCase();
  const mission = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((m) => m.id === key);
  if (!mission) throw new Error(`완료할 미션을 찾지 못했습니다: "${ref}". 남은 미션 번호: ${open.map((m, i) => `${i + 1}(${m.id})`).join(', ') || '없음'}`);
  if (by) {
    const author = requireMember(by, members);
    if (author.id !== memberId && !ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 다른 사람의 미션을 완료할 수 없습니다.`);
    mission.doneBy = author.id;
  }
  mission.status = 'done';
  mission.doneAt = now;
  return mission;
}

// 여러 번호를 한 번에: 번호는 모두 완료 전 목록 기준(2 3 이면 지금의 2번·3번).
export function completeMissions(db, memberId, refs, opts = {}, now = new Date().toISOString()) {
  const open = openMissions(db, memberId);
  const ids = [...new Set(refs.map((r) => {
    const key = String(r || '').trim().toUpperCase();
    const m = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((x) => x.id === key);
    if (!m) throw new Error(`완료할 미션을 찾지 못했습니다: "${r}". 남은 미션 번호: ${open.map((x, i) => `${i + 1}(${x.id})`).join(', ') || '없음'}`);
    return m.id;
  }))];
  return ids.map((id) => completeMission(db, memberId, id, now, opts));
}

// 후순위로 내리기(관리자만). 후순위 미션은 그 사람 목록 맨 뒤로 가고, 다른 관리자 체크인에도 뜬다.
export function setLowPriority(db, memberId, ref, by, members) {
  const author = requireMember(by, members);
  if (!ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 우선순위를 바꿀 수 없습니다.`);
  const open = openMissions(db, memberId);
  const key = String(ref || '').trim().toUpperCase();
  const mission = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((m) => m.id === key);
  if (!mission) throw new Error(`미션을 찾지 못했습니다: "${ref}"`);
  mission.priority = 'low';
  return mission;
}

// 관리자에게 보여 줄 '다른 관리자의 후순위 미션'.
export function othersLowMissions(db, member, members) {
  if (!ADMIN_ROLES.has(member.role)) return [];
  const admins = new Set(members.filter((m) => ADMIN_ROLES.has(m.role) && m.id !== member.id).map((m) => m.id));
  return db.missions.filter((m) => m.priority === 'low' && m.status === 'todo' && admins.has(m.assignee));
}

// Claude Code 가 그대로 전달하는 문구.
export function formatMissions(member, missions) {
  if (!missions.length) return `${member.name}님, 지금 남은 미션이 없습니다.`;
  return missions
    .map((m, i) => {
      const head = `${member.name}님의 미션 ${i + 1}번은 ${m.title}${m.priority === 'low' ? ' (후순위)' : ''}`;
      return m.detail ? `${head}\n${m.detail.split('\n').map((l) => `   ${l}`).join('\n')}` : head;
    })
    .join('\n\n');
}

// ---- 미션설정·미션추가(여러 개), 검사 ----
// Claude Code 가 대표의 자연어 입력("민호 미션설정\n1. A\n2. B")을 그대로 넘기면 여기서 미션 목록으로 바꾼다.

// 같은 미션인지 비교할 때: 앞뒤·중복 공백 무시, 영문 대소문자 무시
export const normTitle = (s) => String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

// "1. 제목" "2) 제목" "- 제목" "3번 제목" "1️⃣ 제목" 이 한 미션. 첫 미션보다 더 들여쓴 줄(하위 항목 포함)과
// 번호 없는 줄은 바로 위 미션의 설명. "1.5배" 처럼 숫자가 이어지면 번호가 아니다.
// 번호 붙은 줄이 하나도 없으면 줄마다 미션 하나. 첫 줄의 "민호 미션설정" 같은 머리줄만 버린다.
const ITEM_RE = /^(\s*)(?:\d{1,3}\s*[.)．](?!\d)|\d{1,3}\s*번[.:]?|\d️?⃣|🔟|[-*•·])\s*(\S.*)$/u;
export function parseMissionList(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length && !ITEM_RE.test(lines[0]) && /^(\S+\s+)?미션\s*(설정|추가)$/.test(lines[0].trim())) lines.shift();
  const numbered = lines.some((l) => ITEM_RE.test(l));
  const items = [];
  let level = null;
  for (const line of lines) {
    const m = line.match(ITEM_RE);
    if (!numbered) items.push({ title: line.trim(), detail: '' });
    else if (m && (level === null || m[1].length <= level)) {
      level ??= m[1].length;
      items.push({ title: m[2].trim(), detail: '' });
    } else if (items.length) items.at(-1).detail = [items.at(-1).detail, line.trim()].filter(Boolean).join('\n');
  }
  for (const it of items) if (it.title.length > 200) throw new Error(`미션 제목이 너무 깁니다(200자 이하): "${it.title.slice(0, 30)}…"`);
  return items;
}

function requireAdmin(by, members, what) {
  const author = requireMember(by, members);
  if (!ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 ${what} 수 없습니다.`);
  return author;
}

// 화면에 보이는 그 사람의 목록(순서·제목·설명·후순위). 같으면 '변경 없음'.
const visible = (db, id) => JSON.stringify(openMissions(db, id).map((m) => [m.id, m.title, m.detail || '', m.priority || '']));

// 미션설정: 그 사람의 남은 미션을 새 목록으로 바꾼다.
// - 제목이 같은 기존 미션은 ID 를 그대로 두고 순서·설명만 고친다(입력한 순서가 우선이라 후순위 표시는 지운다).
// - 새 목록에 없는 기존 미션은 지우지 않고 status 'replaced' 로 보관한다(완료 기록은 손대지 않음).
// - 같은 목록을 다시 넣으면 changed=false(커밋·알림 없음). 빈 목록은 거부(전체 삭제·초기화 금지).
export function setMissions(db, assignee, items, by, members, now = new Date().toISOString()) {
  const target = requireMember(assignee, members);
  const author = requireAdmin(by, members, '미션을 정할');
  const seen = new Set();
  const list = items.filter((it) => String(it.title || '').trim() && !seen.has(normTitle(it.title)) && seen.add(normTitle(it.title)));
  if (!list.length) throw new Error('미션설정에는 미션이 1개 이상 필요합니다(전체 삭제·초기화는 하지 않습니다).');
  const before = visible(db, target.id);
  const pool = new Map();
  for (const m of openMissions(db, target.id)) if (!pool.has(normTitle(m.title))) pool.set(normTitle(m.title), m);
  const kept = [];
  const added = [];
  list.forEach((it, i) => {
    const m = pool.get(normTitle(it.title));
    if (m) {
      pool.delete(normTitle(it.title));
      m.order = i + 1;
      delete m.priority;
      if (it.detail) m.detail = String(it.detail).trim();
      kept.push(m);
    } else {
      const n = addMission(db, { assignee: target.id, title: it.title, detail: it.detail, by: author.id }, members, now);
      n.order = i + 1;
      added.push(n);
    }
  });
  const replaced = [...pool.values()];
  for (const m of replaced) Object.assign(m, { status: 'replaced', replacedAt: now, replacedBy: author.id });
  return { kept, added, replaced, skipped: items.length - list.length, changed: before !== visible(db, target.id) };
}

// 미션추가: 기존 미션은 그대로 두고 뒤에(top 이면 맨 앞에, 넣은 순서대로) 붙인다. 이미 있는 제목은 건너뛴다.
export function addMissions(db, assignee, items, by, members, { top = false } = {}, now = new Date().toISOString()) {
  const target = requireMember(assignee, members);
  const author = requireAdmin(by, members, '미션을 만들');
  const have = new Set(openMissions(db, target.id).map((m) => normTitle(m.title)));
  const skipped = [];
  const fresh = [];
  for (const it of items) {
    const k = normTitle(it.title);
    if (!k) continue;
    if (have.has(k)) skipped.push(it.title);
    else { have.add(k); fresh.push(it); }
  }
  const min = db.missions.filter((m) => m.assignee === target.id).reduce((a, m) => Math.min(a, m.order ?? 0), 1);
  const added = fresh.map((it) => addMission(db, { assignee: target.id, title: it.title, detail: it.detail, by: author.id }, members, now));
  if (top) added.forEach((m, i) => { m.order = min - added.length + i; });
  return { added, skipped, changed: added.length > 0 };
}

export function memberByGithub(login, members) {
  const key = String(login || '').toLowerCase();
  return (key && members.find((m) => m.github && m.github.toLowerCase() === key)) || null;
}

// 명부 검사: 아이디·이름·GitHub 아이디 중복 금지, 대표관리자 정확히 1명.
export function validateMembers(members) {
  const errs = [];
  if (!Array.isArray(members) || !members.length) return ['members 배열이 비어 있습니다'];
  const ids = new Set();
  const names = new Set();
  const gh = new Set();
  for (const m of members) {
    if (!/^[a-z][a-z0-9_]*$/.test(m?.id || '')) errs.push(`아이디 형식: ${m?.id}`);
    else if (ids.has(m.id)) errs.push(`아이디 중복: ${m.id}`);
    ids.add(m?.id);
    if (!String(m?.name || '').trim() || names.has(m.name)) errs.push(`이름 없음/중복: ${m?.id}`);
    names.add(m?.name);
    if (!['owner', 'admin', 'member'].includes(m?.role)) errs.push(`권한 형식: ${m?.id}`);
    if (m?.github != null) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(m.github)) errs.push(`GitHub 아이디 형식: ${m.id}`);
      else if (gh.has(m.github.toLowerCase())) errs.push(`GitHub 아이디 중복: ${m.github}`);
      else gh.add(m.github.toLowerCase());
    }
  }
  if (members.filter((m) => m?.role === 'owner').length !== 1) errs.push('대표관리자(owner)는 정확히 1명이어야 합니다');
  return errs;
}

// 미션 DB 검사(JSON 스키마 대신 직접): 저장 전·발송 전에 깨진 데이터를 막는다.
const STATUSES = new Set(['todo', 'done', 'replaced']);
export function validateDb(db, members) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) return ['미션 DB 가 객체가 아닙니다'];
  const errs = [];
  if (!Number.isInteger(db.nextId) || db.nextId < 1) errs.push('nextId 는 1 이상의 정수');
  if (!Array.isArray(db.missions)) return [...errs, 'missions 배열이 없습니다'];
  const memberIds = members ? new Set(members.map((m) => m.id)) : null;
  const ids = new Set();
  db.missions.forEach((m, i) => {
    const at = m?.id || `#${i + 1}`;
    if (!/^M-\d{4,}$/.test(m?.id || '')) errs.push(`${at}: id 형식(M-0001)`);
    else {
      if (ids.has(m.id)) errs.push(`${at}: id 중복`);
      ids.add(m.id);
      if (Number(m.id.slice(2)) >= db.nextId) errs.push(`${at}: nextId(${db.nextId}) 보다 크거나 같은 id`);
    }
    if (memberIds && !memberIds.has(m?.assignee)) errs.push(`${at}: 명부에 없는 담당자 ${m?.assignee}`);
    if (typeof m?.title !== 'string' || !m.title.trim() || m.title.length > 200 || /[\r\n]/.test(m.title)) errs.push(`${at}: 제목(1~200자 한 줄)`);
    if (m?.detail != null && (typeof m.detail !== 'string' || m.detail.length > 4000)) errs.push(`${at}: 설명(4000자 이하)`);
    if (!STATUSES.has(m?.status)) errs.push(`${at}: status 는 todo·done·replaced`);
    if (typeof m?.order !== 'number' || !Number.isFinite(m.order)) errs.push(`${at}: order 숫자`);
    if (m?.priority != null && m.priority !== 'low') errs.push(`${at}: priority 는 low 만`);
    if (m?.status === 'done' && !m.doneAt) errs.push(`${at}: 완료인데 doneAt 없음`);
  });
  return errs;
}
