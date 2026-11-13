// 미믹노트 핵심 로직 — Node 파일·프로세스 기능을 쓰지 않아 로컬(CLI·Actions)과 클라우드플레어 워커(봇 서버)가 함께 쓴다.

// 팀원 명부·미션 규칙·검사, 텔레그램 API, 메시지 문구, 봇 판단(decide), GitHub 저장(mutate: 어댑터를 받아 동작).

export const ADMIN_ROLES = new Set(['owner', 'admin']);

export const REPO = 'newcode135-prog/mimic-note';

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
// 번호 붙은 줄이 하나도 없으면 글 전체가 미션 하나(줄바꿈은 띄어쓰기로 이어 붙임 — 휴대폰에서 문장을 여러 줄로 보내도 한 미션).
// 이어 붙여 200자가 넘으면 첫 줄이 제목, 나머지가 설명. 첫 줄의 "민호 미션설정" 같은 머리줄만 버린다.
const ITEM_RE = /^(\s*)(?:\d{1,3}\s*[.)．](?!\d)|\d{1,3}\s*번[.:]?|\d️?⃣|🔟|[-*•·])\s*(\S.*)$/u;
export function parseMissionList(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length && !ITEM_RE.test(lines[0]) && /^(\S+\s+)?미션\s*(설정|추가)$/.test(lines[0].trim())) lines.shift();
  const numbered = lines.some((l) => ITEM_RE.test(l));
  const items = [];
  if (!numbered && lines.length) {
    const all = lines.map((l) => l.trim()).join(' ');
    items.push(all.length <= 200 ? { title: all, detail: '' } : { title: lines[0].trim(), detail: lines.slice(1).map((l) => l.trim()).join('\n') });
  }
  let level = null;
  for (const line of numbered ? lines : []) {
    const m = line.match(ITEM_RE);
    if (m && (level === null || m[1].length <= level)) {
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

// ---- 미션 요청(팀원 → 관리자) ----
// 대전제 2·3번(미션을 만들고 배정하는 것은 관리자만): 팀원은 관리자에게 '요청'만 보내고, 관리자가 수락해야 미션(todo)이 된다.
// status: requested(대기) → todo(수락) 또는 declined(거절). 대기 요청은 목록·진행률에 들어가지 않는다.
export const REQUEST_LIMIT = 10; // 한 사람이 동시에 걸어 둘 수 있는 대기 요청 수(실수·도배 방지)

const adminNames = (members) => members.filter((m) => ADMIN_ROLES.has(m.role)).map((m) => m.name).join('·');

export function pendingRequests(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status === 'requested').sort((a, b) => a.id.localeCompare(b.id));
}

// from 이 to 에게 미션을 보낼 때: 관리자 → 'add'(바로 미션), 팀원 → 다른 관리자에게만 'request', 그 밖은 null(못 보냄)
export function sendMode(from, to) {
  if (!from || !to) return null;
  if (ADMIN_ROLES.has(from.role)) return 'add';
  return to.id !== from.id && ADMIN_ROLES.has(to.role) ? 'request' : null;
}

export function sendDeniedText(from, to, members) {
  if (from.id === to.id) return `팀원은 본인 미션을 직접 만들 수 없어요(대전제: 배정은 관리자만). 관리자(${esc(adminNames(members))})에게 요청하세요.`;
  return `팀원끼리는 미션을 주고받을 수 없어요(대전제: 배정은 관리자만). ${esc(to.name)}님에게 맡길 일이면 관리자(${esc(adminNames(members))})에게 요청하세요.`;
}

export function requestMissions(db, assignee, items, by, members, now = new Date().toISOString()) {
  const target = requireMember(assignee, members);
  const author = requireMember(by, members);
  if (sendMode(author, target) !== 'request') throw new Error(sendDeniedText(author, target, members).replace(/<[^>]+>/g, ''));
  const have = new Set([...openMissions(db, target.id), ...pendingRequests(db, target.id)].map((m) => normTitle(m.title)));
  const skipped = [];
  const fresh = [];
  for (const it of items) {
    const k = normTitle(it.title);
    if (!k) continue;
    if (have.has(k)) skipped.push(it.title);
    else { have.add(k); fresh.push(it); }
  }
  const waiting = db.missions.filter((m) => m.status === 'requested' && m.createdBy === author.id).length;
  if (waiting + fresh.length > REQUEST_LIMIT) throw new Error(`대기 중인 요청은 한 사람당 ${REQUEST_LIMIT}개까지예요(지금 ${waiting}개). 받은 사람이 수락·거절한 뒤 다시 보내 주세요.`);
  const added = fresh.map((it) => {
    const m = { id: `M-${String(db.nextId).padStart(4, '0')}`, assignee: target.id, order: 0, title: String(it.title).trim(), detail: String(it.detail || '').trim(), status: 'requested', createdBy: author.id, createdAt: now, doneAt: null };
    db.nextId += 1;
    db.missions.push(m);
    return m;
  });
  return { added, skipped, changed: added.length > 0 };
}

// 수락은 관리자(받은 관리자 또는 다른 관리자)만 — 배정 결정이므로. 거절은 받은 사람 또는 관리자.
export function respondRequest(db, missionId, accept, by, members, now = new Date().toISOString()) {
  const m = db.missions.find((x) => x.id === missionId);
  if (!m || m.status !== 'requested') throw new Error('이미 처리했거나 없는 요청이에요.');
  const actor = requireMember(by, members);
  if (accept ? !ADMIN_ROLES.has(actor.role) : actor.id !== m.assignee && !ADMIN_ROLES.has(actor.role)) {
    throw new Error(accept ? '요청 수락(미션 배정)은 관리자만 할 수 있어요.' : '요청은 받은 사람이나 관리자만 거절할 수 있어요.');
  }
  if (accept) {
    if (openMissions(db, m.assignee).some((x) => normTitle(x.title) === normTitle(m.title))) throw new Error('이미 같은 제목의 미션이 있어요 — 이 요청은 거절해 주세요.');
    m.order = db.missions.filter((x) => x.assignee === m.assignee && x.id !== m.id).reduce((a, x) => Math.max(a, x.order ?? 0), 0) + 1;
    Object.assign(m, { status: 'todo', acceptedAt: now, acceptedBy: actor.id });
  } else Object.assign(m, { status: 'declined', declinedAt: now, declinedBy: actor.id });
  return { mission: m, changed: true };
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
const STATUSES = new Set(['todo', 'done', 'replaced', 'requested', 'declined']);
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
    if (!STATUSES.has(m?.status)) errs.push(`${at}: status 는 todo·done·replaced·requested·declined`);
    if (typeof m?.order !== 'number' || !Number.isFinite(m.order)) errs.push(`${at}: order 숫자`);
    if (m?.priority != null && m.priority !== 'low') errs.push(`${at}: priority 는 low 만`);
    if (m?.status === 'done' && !m.doneAt) errs.push(`${at}: 완료인데 doneAt 없음`);
  });
  return errs;
}

export const DB_FILE = 'mimic-note/data/missions.json';

export const MEMBERS_FILE = 'mimic-note/data/members.json';

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const num = (i) => KEYCAPS[i] || `${i + 1}.`;

// 팀원 한 명의 텔레그램 메시지(HTML). 상위 3개는 크게, 설명과 4번부터는 눌러서 펼치기.
// 제목·순서·진행률은 모두 DB 에서 계산한다. justDone: 이번 변경에서 끝낸 미션 제목(맨 위에 "✅ 방금 완료").
// justAdded: 다른 사람이 새로 준 미션 [{ title, by }] (맨 위에 "🆕 새 미션: … (창민님이 줌)").
export function renderTelegram(member, db, { justDone = [], justAdded = [] } = {}) {
  const open = openMissions(db, member.id);
  const done = doneMissions(db, member.id).length;
  const lines = ['🎯 <b>MIMIC NOTE</b>', ''];
  if (justAdded.length) {
    lines.push(...justAdded.slice(0, 3).map((x) => `🆕 새 미션: ${esc(clip(x.title, 120))}${x.by ? ` (${esc(x.by)}님이 줌)` : ''}`));
    if (justAdded.length > 3) lines.push(`🆕 … 외 ${justAdded.length - 3}개`);
    lines.push('');
  }
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
// items: [{ title, doneBy }] (문자열도 됨). 담당자가 아닌 사람이 완료 처리했으면 그 사람을 적는다.
export function renderDoneNotice(assignee, items, db, members = []) {
  const open = openMissions(db, assignee.id).length;
  const done = doneMissions(db, assignee.id).length;
  const line = (it) => {
    const { title, doneBy } = typeof it === 'string' ? { title: it } : it;
    const by = doneBy && doneBy !== assignee.id ? members.find((x) => x.id === doneBy)?.name || doneBy : null;
    return `• ${esc(clip(title, 120))}${by ? ` (${esc(by)}님이 완료 처리)` : ''}`;
  };
  return ['✅ <b>MIMIC NOTE 완료 알림</b>', '', `👤 ${esc(assignee.name)}님이 미션을 완료했어요`, ...items.slice(0, 10).map(line), '',
    `📊 ${esc(assignee.name)}님 진행률 ${done}/${open + done} · 남은 미션 ${open}개`].join('\n');
}

export const BOT_NAME = '코어 오브 미믹노트';


export const TEAM_BUTTON = '📋 팀 현황';
export const SENT_BUTTON = '📤 보낸 미션';

// 늘 떠 있는 버튼판: 팀원 이름 + "봇"(한 줄에 3개) + 맨 아래 [팀 현황][보낸 미션]
export function menuKeyboard(members) {
  const buttons = members.map((m) => ({ text: `${m.name}봇` }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));
  keyboard.push([{ text: TEAM_BUTTON }, { text: SENT_BUTTON }]);
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

// app: false 는 버튼(✅·📨·수락/거절)이 없는 봇 서버(워커)용 — 글 명령만 안내한다
export function menuText(owner, members = [], { app = true } = {}) {
  if (!owner) return ['🎯 <b>코어 오브 미믹노트</b>', '', '아래에서 본인 이름 버튼을 누르세요. 처음이면 관리자에게 받은 <b>본인 연결 링크</b>로 [시작]을 먼저 눌러 주세요.'].join('\n');
  const n = esc(owner.name);
  const admin = ADMIN_ROLES.has(owner.role);
  if (!app) {
    return ['🎯 <b>코어 오브 미믹노트</b>', '', `${n}님, 아래 <b>${n}봇</b>을 누르면 지금 보고할 미션이 와요(다른 이름봇은 그 사람 미션).`, `끝내면 <code>${n} 미션완료 1</code> 처럼 보내세요.`,
      ...(admin ? ['', '미션 주기: <code>창민 이거 결제해줘</code> · 바꾸기: <code>창민 미션설정</code> + 줄마다 <code>1. …</code>'] : [])].join('\n');
  }
  return ['🎯 <b>코어 오브 미믹노트</b>', '', `${n}님, 이렇게 써요`,
    `• <b>${n}봇</b> → 내 미션 · <b>✅</b> 버튼으로 완료${admin ? ' · 받은 요청 수락/거절' : ''}`,
    admin ? '• 다른 사람 이름봇 → 그 사람 미션 보기 · <b>📨 미션 주기</b>' : `• 다른 사람 이름봇 → 그 사람 미션 보기 · 관리자(${esc(adminNames(members))})에게는 <b>📨 미션 요청</b>(수락하면 미션이 돼요)`,
    `• <b>${TEAM_BUTTON}</b> · <b>${SENT_BUTTON}</b>(내가 준·요청한 미션이 어떻게 됐는지)`,
    '', '글로도 돼요', admin ? '<code>창민 이거 결제해줘</code> → 미션 주기 · <code>창민 미션설정</code> + 줄마다 <code>1. …</code> → 바꾸기' : `<code>${esc(members.find((m) => ADMIN_ROLES.has(m.role) && m.id !== owner.id)?.name || '민호')} 이거 봐줘</code> → 미션 요청`,
    `<code>${n} 미션완료 1</code> → 완료`, '', '미션이 생기거나 바뀌면 이 대화로 알림이 와요. 미션을 준 사람에게는 완료 알림이 가요.'].join('\n');
}

export function missionsText(member, db) {
  return boardText(member, member, db, []);
}

// 이름봇을 눌렀을 때: 본인이면 내 미션 + 받은 요청, 남이면 그 사람 미션(보기만) + 보낼 수 있는지 안내
export function boardText(viewer, member, db, members) {
  const lines = [renderTelegram(member, db)];
  if (viewer.id === member.id) {
    const reqs = pendingRequests(db, member.id);
    if (reqs.length) {
      const who = (id) => members.find((x) => x.id === id)?.name || id;
      lines.push('', `📨 <b>받은 요청 ${reqs.length}개</b> (수락하면 내 미션이 돼요)`, ...reqs.slice(0, 5).map((m, i) => `요청 ${i + 1}. ${esc(clip(m.title, 120))} — ${esc(who(m.createdBy))}님`));
      if (reqs.length > 5) lines.push(`… 외 ${reqs.length - 5}개(먼저 온 것부터 처리하면 이어서 보여요)`);
    }
    lines.push('', openMissions(db, member.id).length ? '끝낸 미션은 아래 <b>✅ 번호</b>를 누르세요.' : '새 미션이 오면 여기로 알려 드려요.');
  } else {
    const mode = sendMode(viewer, member);
    lines.push('', mode === 'add' ? `📨 아래 버튼으로 ${esc(member.name)}님에게 미션을 줄 수 있어요.`
      : mode === 'request' ? `📨 아래 버튼으로 ${esc(member.name)}님에게 미션을 요청할 수 있어요(수락하면 미션이 돼요).`
        : `👀 보기만 할 수 있어요. ${sendDeniedText(viewer, member, members)}`);
  }
  return lines.join('\n');
}

// 미션 완료 버튼(✅ 1 … ✅ 10, 한 줄에 5개). 버튼에는 미션 ID 를 넣어, 목록이 바뀐 뒤 눌러도 그 미션만 처리한다.
export function doneButtons(db, memberId) {
  const open = openMissions(db, memberId).slice(0, 10);
  const rows = [];
  for (let i = 0; i < open.length; i += 5) rows.push(open.slice(i, i + 5).map((m, j) => ({ text: `✅ ${i + j + 1}`, callback_data: `c:${m.id}` })));
  return rows;
}

// GitHub Actions 가 보내는 목록 메시지에 붙는 버튼(봇이 켜져 있을 때 동작)
export function listKeyboard(db, memberId) {
  return { inline_keyboard: [...doneButtons(db, memberId), [{ text: '🔄 새로고침', callback_data: `v:${memberId}` }]] };
}

export function boardKeyboard(viewer, member, db) {
  const rows = [];
  if (viewer.id === member.id) {
    rows.push(...doneButtons(db, member.id));
    if (ADMIN_ROLES.has(viewer.role)) {
      pendingRequests(db, member.id).slice(0, 5).forEach((m, i) => rows.push([{ text: `✅ 요청 ${i + 1} 수락`, callback_data: `a:${m.id}` }, { text: `❌ 요청 ${i + 1} 거절`, callback_data: `n:${m.id}` }]));
    }
  } else {
    const mode = sendMode(viewer, member);
    if (mode) rows.push([{ text: `📨 ${member.name}님에게 미션 ${mode === 'add' ? '주기' : '요청'}`, callback_data: `s:${member.id}` }]);
  }
  rows.push([{ text: '🔄 새로고침', callback_data: `v:${member.id}` }]);
  return { inline_keyboard: rows };
}

// 팀 현황: 사람마다 남은·완료(+관리자는 받은 요청), 텔레그램 연결 여부(linked: 연결된 팀원 아이디 Set)
export function teamText(members, db, linked = null) {
  const lines = ['📋 <b>팀 현황</b>', ''];
  for (const m of members) {
    const open = openMissions(db, m.id).length;
    const done = doneMissions(db, m.id).length;
    const req = pendingRequests(db, m.id).length;
    lines.push(`• <b>${esc(m.name)}</b> — 남은 ${open} · 완료 ${done}${req ? ` · 📨 요청 ${req}` : ''}${linked && !linked.has(m.id) ? ' · <i>텔레그램 미연결</i>' : ''}`);
  }
  lines.push('', '이름봇을 누르면 그 사람 미션을 볼 수 있어요.');
  return lines.join('\n');
}

// 보낸 미션: 내가 다른 사람에게 준·요청한 미션이 어떻게 됐는지(최근 것부터)
export function sentText(viewer, members, db) {
  const who = (id) => esc(members.find((x) => x.id === id)?.name || id);
  const mine = db.missions.filter((m) => m.createdBy === viewer.id && m.assignee !== viewer.id).sort((a, b) => b.id.localeCompare(a.id));
  const group = (status) => mine.filter((m) => m.status === status);
  const lines = ['📤 <b>보낸 미션</b>', ''];
  if (!mine.length) return [...lines, '아직 다른 사람에게 준·요청한 미션이 없어요. 이름봇 → 📨 버튼으로 보내 보세요.'].join('\n');
  const block = (title, list, max = 10) => {
    if (!list.length) return;
    lines.push(`<b>${title} ${list.length}</b>`, ...list.slice(0, max).map((m) => `• ${who(m.assignee)} — ${esc(clip(m.title, 80))}`));
    if (list.length > max) lines.push(`… 외 ${list.length - max}개`);
    lines.push('');
  };
  block('⏳ 수락 기다리는 요청', group('requested'));
  block('🔨 진행 중', group('todo'));
  block('✅ 완료', group('done'), 5);
  block('❌ 거절됨', group('declined'), 5);
  return lines.join('\n').trimEnd();
}

// 요청 알림(받는 관리자에게, 수락/거절 버튼과 함께)
export function requestNotice(requester, added) {
  return {
    text: ['📨 <b>미션 요청이 왔어요</b>', '', `${esc(requester.name)}님이 보냈어요:`, ...added.slice(0, 5).map((m, i) => `${i + 1}. ${esc(clip(m.title, 150))}${m.detail ? `\n<blockquote expandable>${esc(clip(m.detail, 400))}</blockquote>` : ''}`),
      ...(added.length > 5 ? [`… 외 ${added.length - 5}개(내 이름봇에서 보여요)`] : []), '', `수락하면 내 미션에 들어가고, ${esc(requester.name)}님에게 결과를 알려 드려요.`].join('\n'),
    reply_markup: { inline_keyboard: added.slice(0, 5).map((m, i) => [{ text: `✅ ${i + 1} 수락`, callback_data: `a:${m.id}` }, { text: `❌ ${i + 1} 거절`, callback_data: `n:${m.id}` }]) },
  };
}

// 요청 결과 알림(요청한 사람에게)
export function respondNotice(mission, accept, actor, assignee) {
  const n = esc(assignee.name);
  const by = actor.id !== assignee.id ? ` (${esc(actor.name)}님이 처리)` : '';
  return accept ? `✅ <b>${n}님이 미션 요청을 수락했어요</b>${by}\n• ${esc(clip(mission.title, 150))}\n\n이제 ${n}님의 미션이에요. 끝나면 완료 알림이 와요.`
    : `❌ <b>${n}님이 미션 요청을 거절했어요</b>${by}\n• ${esc(clip(mission.title, 150))}`;
}

// 인라인 버튼(callback_data) 하나를 어떻게 처리할지(순수 함수). viewer: 누른 사람(연결된 팀원, 없으면 null)
//   v:<팀원> 보기·새로고침 · s:<팀원> 미션 주기/요청 시작 · c:<미션> 완료(확인 받음) · a:/n:<미션> 요청 수락/거절 · g:/x:<키> 확인/취소
export function decideCallback(data, { viewer, members, db }) {
  const m = String(data || '').match(/^([a-z]):([\w-]{1,40})$/);
  if (!m) return { kind: 'stale', text: '알 수 없는 버튼이에요.' };
  const [, act, arg] = m;
  if (act === 'g' || act === 'x') return { kind: 'pending', confirm: act === 'g', key: arg };
  if (!viewer) return { kind: 'stale', text: '먼저 관리자에게 받은 본인 연결 링크로 연결해 주세요.' };
  if (act === 'v' || act === 's') {
    const member = members.find((x) => x.id === arg);
    if (!member) return { kind: 'stale', text: '명부에 없는 팀원이에요.' };
    if (act === 'v') return { kind: 'board', member };
    const mode = sendMode(viewer, member);
    return mode ? { kind: 'compose', target: member, mode } : { kind: 'stale', text: sendDeniedText(viewer, member, members).replace(/<[^>]+>/g, '') };
  }
  const mission = db.missions.find((x) => x.id === arg);
  const target = mission && members.find((x) => x.id === mission.assignee);
  if (!mission || !target) return { kind: 'stale', text: '없는 미션이에요.' };
  if (act === 'c') {
    if (mission.status !== 'todo') return { kind: 'stale', text: '이미 완료됐거나 바뀐 미션이에요. 🔄 새로고침해 보세요.' };
    if (mission.assignee !== viewer.id && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: '본인 미션만 완료할 수 있어요.' };
    return { kind: 'confirm-done', target, picked: [{ id: mission.id, title: mission.title }] };
  }
  if (act === 'a' || act === 'n') {
    if (mission.status !== 'requested') return { kind: 'stale', text: '이미 처리한 요청이에요.' };
    if (act === 'a' && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: '요청 수락은 관리자만 할 수 있어요.' };
    if (act === 'n' && viewer.id !== mission.assignee && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: '받은 사람이나 관리자만 거절할 수 있어요.' };
    return { kind: 'respond', accept: act === 'a', mission, target, requester: members.find((x) => x.id === mission.createdBy) || null };
  }
  return { kind: 'stale', text: '알 수 없는 버튼이에요.' };
}

// 미션 주기/요청 버튼을 누른 뒤 보내는 안내. 답장 강제(force_reply)는 쓰지 않는다 — 늘 떠 있는 이름 버튼판이 사라지므로.
export function composePrompt(target, mode) {
  return [`📨 <b>${esc(target.name)}</b>님에게 ${mode === 'add' ? '줄 미션' : '요청할 미션'}을 이 대화에 적어 보내 주세요(10분 안).`, '',
    '보낸 글 전체가 미션 하나예요(여러 줄로 써도 하나).', '여러 개를 한 번에 보내려면 <code>1. 첫째</code> <code>2. 둘째</code> 처럼 번호를 붙여 주세요.', '그만두려면 <code>취소</code>'].join('\n');
}

// .env 의 TELEGRAM_CHAT_ID_<아이디> / TELEGRAM_CHAT_IDS 로 chat id → 팀원 아이디(GitHub 를 부르기 전에 알 수 있게)
export function ownersFromEnv(env) {
  const map = new Map();
  try { for (const [id, chat] of Object.entries(JSON.parse(env.TELEGRAM_CHAT_IDS || '{}'))) if (chat) map.set(String(chat), id); } catch { /* 형식이 틀리면 무시 */ }
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^TELEGRAM_CHAT_ID_([A-Z0-9_]+)$/);
    if (m && v) map.set(String(v), m[1].toLowerCase());
  }
  return map;
}

const MAX_ITEMS = 20; // 텔레그램에서 한 번에 주거나 요청할 수 있는 미션 수

function parseItems(chatId, text) {
  let items;
  try { items = parseMissionList(text); } catch (e) { return { kind: 'act-error', chatId, error: e.message }; }
  if (!items.length) return { kind: 'act-error', chatId, error: '미션 내용이 비어 있어요.' };
  if (items.length > MAX_ITEMS) return { kind: 'act-error', chatId, error: `한 번에 ${MAX_ITEMS}개까지 보낼 수 있어요(지금 ${items.length}개).` };
  return { items };
}

// 받은 메시지 하나를 어떻게 처리할지(순수 함수 — 테스트 대상). chatOwners: Map(chatId → 팀원 아이디)
// compose: 📨 버튼을 눌러 미션 내용을 기다리는 중이면 { target, mode } — 버튼·명령이 아닌 글은 그 사람에게 보낼 미션으로 본다.
export function decide(msg, { members, chatOwners, compose = null }) {
  if (!msg?.chat || typeof msg.text !== 'string') return { kind: 'ignore' };
  if (msg.chat.type !== 'private') return { kind: 'ignore' }; // 단체방에서는 답하지 않는다(미션 공개 방지)
  const chatId = String(msg.chat.id);
  const owner = members.find((m) => m.id === chatOwners.get(chatId)) || null;
  const text = msg.text.trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (start?.[1]) return { kind: 'link', chatId };
  if (start || /^\/(menu|help)(@\w+)?$/.test(text) || text === '메뉴') return { kind: 'menu', chatId, owner };
  if (compose && /^(취소|\/cancel(@\w+)?)$/.test(text)) return { kind: 'cancel', chatId };
  const byName = (n) => members.find((m) => m.name === n || m.id === String(n).toLowerCase()) || null;
  const team = text === TEAM_BUTTON || /^(팀\s*현황|\/team(@\w+)?)$/.test(text);
  const sent = text === SENT_BUTTON || /^(보낸\s*미션|\/sent(@\w+)?)$/.test(text);
  const me = /^\/me(@\w+)?$/.test(text) || /^내\s*미션$/.test(text);
  const btnTarget = byName(text.match(/^(\S+?)\s*봇$/)?.[1]);
  if (team || sent || me || btnTarget) {
    if (!owner) return { kind: 'unlinked', chatId };
    if (team || sent) return { kind: team ? 'team' : 'sent', chatId, owner };
    return { kind: 'board', chatId, owner, member: me ? owner : btnTarget };
  }
  if (compose && owner && !text.startsWith('/')) {
    const mode = sendMode(owner, compose.target);
    if (!mode) return { kind: 'act-denied', chatId, owner, action: 'add', text: sendDeniedText(owner, compose.target, members) };
    const p = parseItems(chatId, text);
    return p.items ? { kind: 'act', action: mode, chatId, owner, target: compose.target, items: p.items } : p;
  }
  // 미션 명령: "<이름>[님][에게|한테|께][,:] <내용>" — 내용이 "미션설정/미션추가/미션완료 …" 면 그 명령, 아니면 미션 주기(팀원은 관리자에게 요청)
  const m = text.match(/^(\S+?)(?:님)?(?:에게|한테|께)?(?:[ \t]*[:,]?[ \t]+|[ \t]*[:,]?[ \t]*\n)([\s\S]+)$/);
  const target = m && byName(m[1]);
  if (!target) return { kind: 'menu', chatId, owner };
  if (!owner) return { kind: 'unlinked', chatId };
  const kw = m[2].match(/^미션\s*(설정|추가|완료)\s*([\s\S]*)$/);
  const action = kw ? { 설정: 'set', 추가: 'add', 완료: 'done' }[kw[1]] : 'add';
  const rest = kw ? kw[2] : m[2];
  const admin = ADMIN_ROLES.has(owner.role);
  if (action === 'done') {
    const refs = rest.split(/[\s,]+/).filter(Boolean);
    if (!refs.length) return { kind: 'act-error', chatId, error: `완료할 번호를 적어 주세요. 예: ${target.name} 미션완료 2` };
    if (target.id !== owner.id && !admin) return { kind: 'act-denied', chatId, owner, action, text: '다른 사람의 미션 완료는 관리자만 할 수 있어요. 본인 미션만 완료하세요.' };
    return { kind: 'act', action, chatId, owner, target, refs };
  }
  if (action === 'set' && !admin) return { kind: 'act-denied', chatId, owner, action, text: `미션 바꾸기(미션설정)는 관리자(${esc(adminNames(members))})만 할 수 있어요.` };
  const mode = action === 'set' ? 'set' : sendMode(owner, target);
  if (!mode) return { kind: 'act-denied', chatId, owner, action, text: sendDeniedText(owner, target, members) };
  const p = parseItems(chatId, rest);
  return p.items ? { kind: 'act', action: mode, chatId, owner, target, items: p.items } : p;
}

// 확인 메시지(완료는 번호를 지금 목록의 미션으로 바꿔 보여 주고, 확인 때는 그 ID 로 처리)
export function confirmText(d, picked = []) {
  const n = `<b>${esc(d.target.name)}</b>님`;
  if (d.action === 'done') return [`☑️ ${n}의 미션을 완료할까요?`, ...picked.map((x) => `• [${x.id}] ${esc(x.title)}`)].join('\n');
  const head = d.action === 'set' ? `♻️ ${n}의 남은 미션을 이 목록으로 바꿀까요? (지금 남은 미션은 지우지 않고 보관)`
    : d.action === 'request' ? `📨 ${n}에게 이 미션을 요청할까요? (${esc(d.target.name)}님이 수락하면 미션이 돼요)` : `📝 ${n}에게 이 미션을 줄까요?`;
  return [head, ...d.items.slice(0, 10).map((it) => `• ${esc(it.title)}`), ...(d.items.length > 10 ? [`… 외 ${d.items.length - 10}개`] : [])].join('\n');
}

// 확인(✅)을 누른 뒤 저장할 내용 — 봇(bot.mjs)과 봇 서버(worker)가 같이 쓴다
export const ACTIONS = {
  add: { label: '미션추가', apply: (p) => (db, ms, actor) => addMissions(db, p.targetId, p.items, actor.id, ms) },
  request: { label: '미션요청', apply: (p) => (db, ms, actor) => requestMissions(db, p.targetId, p.items, actor.id, ms) },
  set: { label: '미션설정', apply: (p) => (db, ms, actor) => setMissions(db, p.targetId, p.items, actor.id, ms) },
  done: { label: '미션완료', apply: (p) => (db, ms, actor) => ({ done: completeMissions(db, p.targetId, p.ids, { by: actor.id, members: ms }), changed: true }) },
};

// 저장 결과 문구(확인 메시지를 이 문구로 바꾼다)
export function resultText(action, targetName, w) {
  const n = esc(targetName);
  const r = w.result;
  if (w.unchanged) return `변경 없음 — ${n}님에게 이미 그대로 있어요.`;
  const out = action === 'done' ? [`☑️ ${n}님의 미션을 완료했어요`, ...r.done.map((m) => `• [${m.id}] ${esc(m.title)}`)]
    : action === 'set' ? [`♻️ ${n}님의 미션을 바꿨어요 — 새 ${r.added.length} · 유지 ${r.kept.length} · 보관 ${r.replaced.length}`]
      : [action === 'request' ? `📨 ${n}님에게 미션을 요청했어요` : `✅ ${n}님에게 미션을 줬어요`, ...r.added.map((m) => `• [${m.id}] ${esc(m.title)}`), ...(r.skipped.length ? [`(이미 있어서 건너뜀: ${r.skipped.map(esc).join(', ')})`] : [])];
  out.push('', action === 'request' ? `${n}님이 수락하거나 거절하면 알려 드려요.` : action === 'done' ? '곧 텔레그램 알림이 가요(미션을 준 사람에게는 완료 알림).' : `${n}님에게 곧 텔레그램 알림이 가요.`);
  return out.join('\n');
}

export function resolveRefs(db, memberId, refs) {
  const open = openMissions(db, memberId);
  return refs.map((r) => {
    const key = String(r).trim().toUpperCase();
    const m = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((x) => x.id === key);
    if (!m) throw new Error(`미션을 찾지 못했어요: ${r} (남은 미션 번호: ${open.map((x, i) => i + 1).join(', ') || '없음'})`);
    return { id: m.id, title: m.title };
  });
}

// 봇이 head 위에 저장(또는 head 를 보여 줌)해도 되는지: head 가 Actions 가 확인한 커밋이거나, 확인된 커밋에서 head 까지의
// main 첫 부모 사슬이 ① 봇이 직접 만든 커밋(trusted: Map 커밋 → 부모) ② 미션 데이터를 안 바꾼 커밋(코드·문서)으로만 이어질 때.
// 내용이 아니라 커밋으로 판단한다 — 확인 전의 변경을 누가 되돌려(revert) 예전과 같은 내용이 돼도, 그 push 는 데이터를 바꾼
// 남의 커밋이라 믿지 않는다. head 가 확인된 커밋의 후손이 아니면(force push) 믿지 않는다.
export async function safeHead(github, head, verified, trusted = null) {
  if (head === verified) return true;
  const chain = await github.chain(verified, head);
  if (!chain) return false;
  for (const c of chain) if (!trusted?.has(c) && await github.touchesData(c)) return false;
  return true;
}

// GitHub main 의 최신 미션 DB 에 apply 를 적용해 저장한다. 충돌(그사이 누가 바꿈)이면 최신본으로 다시(최대 3번).
// as: 코어 오브 미믹노트 봇이 텔레그램 연결(일회용 코드)로 확인한 팀원 아이디 — 이때는 gh 계정은 저장만 하고, 권한은 그 팀원 역할로 본다.
// trusted: 봇이 직접 만든 커밋(Map 커밋 → 부모) — 그 커밋들은 Actions 확인 전이라도 이어서 저장한다(safeHead).
export async function mutate(github, apply, describe, { as = null, via = null, trusted = null } = {}) {
  const login = await github.whoami();
  const access = await github.access();
  if (!access.push) {
    throw new Error(`GitHub 계정 ${login} 은 ${REPO} 쓰기 권한이 없어 미션을 바꿀 수 없습니다. 초대를 수락했는지 확인하거나, 권한 있는 계정으로 gh auth switch 하세요.`);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 어댑터가 지원하면 main 의 지금 커밋(head)을 정해 두고 그 커밋에서 읽고, 그 커밋 위에만 저장한다(사이에 끼어든 변경을 끌어안지 않게)
    const head = github.headSha ? await github.headSha() : 'main';
    const mf = await github.readFile(MEMBERS_FILE, head);
    const members = JSON.parse(mf.text).members;
    const merr = validateMembers(members);
    if (merr.length) throw new Error(`팀원 명부(members.json)가 올바르지 않아 멈췄습니다: ${merr.join(' · ')}`);
    const { text, sha } = await github.readFile(DB_FILE, head);
    if (as) {
      // 봇 저장: 저장하는 gh 계정이 GitHub Actions 확인을 통과할 수 있어야 하고(저장소 관리자 또는 관리자 팀원),
      // main 에 확인 안 된 변경이 있으면 저장하지 않는다 — 그 변경을 이 계정의 저장으로 "승인"해 버리지 않게.
      const saver = memberByGithub(login, members);
      if (!access.admin && !ADMIN_ROLES.has(saver?.role)) throw new Error(`봇이 저장에 쓰는 GitHub 계정(${login})은 저장소 관리자이거나 관리자 팀원이어야 합니다.`);
      const v = await github.verifiedSha();
      if (!v) throw new Error('GitHub Actions 의 확인 상태를 알 수 없어 저장을 멈췄어요. 잠시 뒤 다시 해 주세요.');
      // 커밋 사슬을 볼 수 있는 어댑터(gh)는 safeHead, 못 보는 어댑터(워커)는 예전처럼 "확인된 상태와 같은 내용"
      const ok = github.chain ? await safeHead(github, head, v, trusted)
        : (await github.readFile(MEMBERS_FILE, v)).sha === mf.sha && (await github.readFile(DB_FILE, v)).sha === sha;
      if (!ok) throw new Error('main 에 아직 확인되지 않은 변경이 있어 저장을 멈췄어요(다른 곳에서 방금 저장한 내용을 처리 중이거나 관리자 확인이 필요). 1분쯤 뒤 다시 해 주세요.');
    }
    const actor = as ? members.find((m) => m.id === as) || null : memberByGithub(login, members);
    if (!actor) throw new Error(as ? `명부에 없는 팀원입니다: ${as}` : `GitHub 계정 ${login} 이 팀원 명부(members.json 의 github)에 없습니다. 대표관리자에게 등록을 요청하세요.`);
    const db = JSON.parse(text);
    const before = validateDb(db, members);
    if (before.length) throw new Error(`GitHub 의 미션 DB 가 올바르지 않아 멈췄습니다: ${before.join(' · ')}`);
    const result = apply(db, members, actor);
    if (!result.changed) return { unchanged: true, result, db, members, actor };
    const errs = validateDb(db, members);
    if (errs.length) throw new Error(`저장하지 않았습니다(검사 실패): ${errs.join(' · ')}`);
    const save = github.commitFile ? (body, msg) => github.commitFile(head, DB_FILE, body, msg) : (body, msg) => github.writeFile(DB_FILE, body, sha, msg);
    const w = await save(`${JSON.stringify(db, null, 2)}\n`, `미믹노트: ${describe(result, actor)} (by ${actor.name}·${via ? `${via}, ${login} 계정으로 저장` : login})`);
    if (w.conflict) continue;
    return { ...w, result, db, members, actor, attempt, parent: head };
  }
  throw new Error('다른 사람이 동시에 미션을 바꾸고 있어 3번 모두 충돌했습니다. 잠시 뒤 다시 시도하세요(강제로 덮어쓰지 않았습니다).');
}
