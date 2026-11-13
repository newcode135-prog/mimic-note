// 미믹노트 핵심 로직 — Node 파일·프로세스 기능을 쓰지 않아 로컬(CLI·Actions)과 클라우드플레어 워커(봇 서버)가 함께 쓴다.

// 팀원 명부·미션 규칙·검사, 텔레그램 API, 메시지 문구, 봇 판단(decide), GitHub 저장(mutate: 어댑터를 받아 동작).

import { tr, dn, isLang, allLabels, LANGS, LANG_NAMES } from './i18n.mjs';

export { tr, dn, isLang, guessLang, LANGS, LANG_NAMES } from './i18n.mjs';

export const ADMIN_ROLES = new Set(['owner', 'admin']);

// 팀원이 고른 텔레그램 언어(미션 DB 의 langs, 기본 한국어)
export const langOf = (db, memberId) => (isLang(db?.langs?.[memberId]) ? db.langs[memberId] : 'ko');

// 언어 고르기 — 본인 것만(텔레그램 봇이 연결로 확인한 사람). 한국어로 돌아가면 기록을 지운다.
export function setLang(db, memberId, lang, by) {
  if (by !== memberId) throw new Error('언어는 본인 것만 바꿀 수 있어요.');
  if (!isLang(lang)) throw new Error(`지원하지 않는 언어: ${lang}`);
  if (langOf(db, memberId) === lang) return { changed: false };
  db.langs = { ...(db.langs || {}) };
  if (lang === 'ko') delete db.langs[memberId];
  else db.langs[memberId] = lang;
  if (!Object.keys(db.langs).length) delete db.langs;
  return { changed: true };
}

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

const adminNames = (members, lang = 'ko') => members.filter((m) => ADMIN_ROLES.has(m.role)).map((m) => dn(m, lang)).join({ en: ', ', zh: '、' }[lang] || '·');

export function pendingRequests(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status === 'requested').sort((a, b) => a.id.localeCompare(b.id));
}

// from 이 to 에게 미션을 보낼 때: 관리자 → 'add'(바로 미션), 팀원 → 다른 관리자에게만 'request', 그 밖은 null(못 보냄)
export function sendMode(from, to) {
  if (!from || !to) return null;
  if (ADMIN_ROLES.has(from.role)) return 'add';
  return to.id !== from.id && ADMIN_ROLES.has(to.role) ? 'request' : null;
}

export function sendDeniedText(from, to, members, lang = 'ko') {
  const t = tr(lang);
  const admins = esc(adminNames(members, lang));
  return from.id === to.id ? t.deniedSelf(admins) : t.deniedPeer(esc(dn(to, lang)), admins);
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
  if (db.langs != null) {
    if (typeof db.langs !== 'object' || Array.isArray(db.langs)) errs.push('langs 는 { 팀원 아이디: 언어 } 객체');
    else {
      for (const [id, l] of Object.entries(db.langs)) {
        if (memberIds && !memberIds.has(id)) errs.push(`langs: 명부에 없는 팀원 ${id}`);
        if (!isLang(l)) errs.push(`langs.${id}: 언어는 ${LANGS.join('·')}`);
      }
    }
  }
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
// justAdded: 다른 사람이 새로 준 미션 [{ title, by }] (맨 위에 "🆕 새 미션: … (창민님이 줌)", by 는 표시할 이름).
// lang: 문구 언어 — 없으면 그 팀원이 고른 언어(db.langs), 기본 한국어. 미션 제목·설명은 적은 그대로.
export function renderTelegram(member, db, { justDone = [], justAdded = [], lang = langOf(db, member.id) } = {}) {
  const t = tr(lang);
  const open = openMissions(db, member.id);
  const done = doneMissions(db, member.id).length;
  const lines = ['🎯 <b>MIMIC NOTE</b>', ''];
  if (justAdded.length) {
    lines.push(...justAdded.slice(0, 3).map((x) => t.newMission(esc(clip(x.title, 120)), x.by ? esc(x.by) : '')));
    if (justAdded.length > 3) lines.push(t.moreNew(justAdded.length - 3));
    lines.push('');
  }
  if (justDone.length) lines.push(...justDone.slice(0, 5).map((x) => t.justDone(esc(clip(x, 120)))), '');
  lines.push(t.missionsOf(esc(dn(member, lang))), '');
  if (!open.length) lines.push(t.noneLeft, '');
  open.slice(0, 3).forEach((m, i) => {
    lines.push(`${num(i)} ${esc(clip(m.title, 200))}${m.priority === 'low' ? ` <i>(${t.low})</i>` : ''}`);
    if (m.detail) lines.push(`<blockquote expandable>${esc(clip(m.detail, 600))}</blockquote>`);
    lines.push('');
  });
  const rest = open.slice(3);
  if (rest.length) {
    const shown = rest.slice(0, 30).map((m, i) => `${num(i + 3)} ${esc(clip(m.title, 120))}${m.priority === 'low' ? ` (${t.low})` : ''}`);
    if (rest.length > 30) shown.push(t.andMore(rest.length - 30));
    lines.push(t.moreMissions(rest.length), `<blockquote expandable>${shown.join('\n')}</blockquote>`, '');
  }
  lines.push('━━━━━━━━━━', '', t.progress(done, open.length + done), t.remaining(open.length));
  return lines.join('\n');
}

// 미션을 준 사람(createdBy)에게 가는 완료 알림(그 사람의 언어로). 진행률은 보내는 시점의 확인된 상태 기준.
// items: [{ title, doneBy }] (문자열도 됨). 담당자가 아닌 사람이 완료 처리했으면 그 사람을 적는다.
export function renderDoneNotice(assignee, items, db, members = [], lang = 'ko') {
  const t = tr(lang);
  const open = openMissions(db, assignee.id).length;
  const done = doneMissions(db, assignee.id).length;
  const line = (it) => {
    const { title, doneBy } = typeof it === 'string' ? { title: it } : it;
    const bm = members.find((x) => x.id === doneBy);
    const by = doneBy && doneBy !== assignee.id ? (bm ? dn(bm, lang) : doneBy) : null;
    return `• ${esc(clip(title, 120))}${by ? t.markedBy(esc(by)) : ''}`;
  };
  const n = esc(dn(assignee, lang));
  return [t.doneTitle, '', t.completedBy(n), ...items.slice(0, 10).map(line), '', t.doneProgress(n, done, open + done, open)].join('\n');
}

export const BOT_NAME = '코어 오브 미믹노트';

export const TEAM_BUTTON = tr('ko').teamBtn;
export const SENT_BUTTON = tr('ko').sentBtn;

// 늘 떠 있는 버튼판: 팀원 이름 + "봇"(한 줄에 3개) + 맨 아래 [팀 현황][보낸 미션][🌐 언어] — 보는 사람의 언어로
export function menuKeyboard(members, lang = 'ko') {
  const t = tr(lang);
  const buttons = members.map((m) => ({ text: t.botBtn(dn(m, lang)) }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) keyboard.push(buttons.slice(i, i + 3));
  keyboard.push([{ text: t.teamBtn }, { text: t.sentBtn }, { text: t.langBtn }]);
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

// 언어 고르기 버튼(l:ko · l:en · l:zh)
export function langKeyboard() {
  return { inline_keyboard: [LANGS.map((l) => ({ text: LANG_NAMES[l], callback_data: `l:${l}` }))] };
}

// app: false 는 버튼(✅·📨·수락/거절)이 없는 봇 서버(워커)용 — 글 명령만 안내한다(한국어)
export function menuText(owner, members = [], { app = true, lang = 'ko' } = {}) {
  const t = tr(lang);
  if (!owner) return [t.title, '', t.menuUnlinked].join('\n');
  const admin = ADMIN_ROLES.has(owner.role);
  if (!app) {
    const k = esc(owner.name);
    return ['🎯 <b>코어 오브 미믹노트</b>', '', `${k}님, 아래 <b>${k}봇</b>을 누르면 지금 보고할 미션이 와요(다른 이름봇은 그 사람 미션).`, `끝내면 <code>${k} 미션완료 1</code> 처럼 보내세요.`,
      ...(admin ? ['', '미션 주기: <code>창민 이거 결제해줘</code> · 바꾸기: <code>창민 미션설정</code> + 줄마다 <code>1. …</code>'] : [])].join('\n');
  }
  const ex = members.find((m) => ADMIN_ROLES.has(m.role) && m.id !== owner.id);
  return [t.title, '', ...t.menu({
    n: esc(dn(owner, lang)), admin, admins: esc(adminNames(members, lang)), adminEx: esc(ex ? dn(ex, lang) : dn({ id: 'minho', name: '민호' }, lang)),
    team: t.teamBtn, sent: t.sentBtn, lang: t.langBtn,
  })].join('\n');
}

export function missionsText(member, db) {
  return boardText(member, member, db, []);
}

// 이름봇을 눌렀을 때(보는 사람의 언어로): 본인이면 내 미션 + 받은 요청, 남이면 그 사람 미션(보기만) + 보낼 수 있는지 안내
export function boardText(viewer, member, db, members, lang = langOf(db, viewer.id)) {
  const t = tr(lang);
  const lines = [renderTelegram(member, db, { lang })];
  if (viewer.id === member.id) {
    const reqs = pendingRequests(db, member.id);
    if (reqs.length) {
      const who = (id) => { const x = members.find((y) => y.id === id); return x ? dn(x, lang) : id; };
      lines.push('', t.reqHeader(reqs.length), ...reqs.slice(0, 5).map((m, i) => t.reqLine(i + 1, esc(clip(m.title, 120)), esc(who(m.createdBy)))));
      if (reqs.length > 5) lines.push(t.reqMore(reqs.length - 5));
    }
    lines.push('', openMissions(db, member.id).length ? t.pressDone : t.willNotify);
  } else {
    const mode = sendMode(viewer, member);
    const n = esc(dn(member, lang));
    lines.push('', mode === 'add' ? t.canGive(n) : mode === 'request' ? t.canRequest(n) : t.viewOnly(sendDeniedText(viewer, member, members, lang)));
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
export function listKeyboard(db, memberId, lang = langOf(db, memberId)) {
  return { inline_keyboard: [...doneButtons(db, memberId), [{ text: tr(lang).refresh, callback_data: `v:${memberId}` }]] };
}

export function boardKeyboard(viewer, member, db, lang = langOf(db, viewer.id)) {
  const t = tr(lang);
  const rows = [];
  if (viewer.id === member.id) {
    rows.push(...doneButtons(db, member.id));
    if (ADMIN_ROLES.has(viewer.role)) {
      pendingRequests(db, member.id).slice(0, 5).forEach((m, i) => rows.push([{ text: t.reqAcceptBtn(i + 1), callback_data: `a:${m.id}` }, { text: t.reqDeclineBtn(i + 1), callback_data: `n:${m.id}` }]));
    }
  } else {
    const mode = sendMode(viewer, member);
    if (mode) rows.push([{ text: t.giveBtn(dn(member, lang), mode), callback_data: `s:${member.id}` }]);
  }
  rows.push([{ text: t.refresh, callback_data: `v:${member.id}` }]);
  return { inline_keyboard: rows };
}

// 팀 현황: 사람마다 남은·완료(+관리자는 받은 요청), 텔레그램 연결 여부(linked: 연결된 팀원 아이디 Set)
export function teamText(members, db, linked = null, lang = 'ko') {
  const t = tr(lang);
  const lines = [t.teamTitle, ''];
  for (const m of members) {
    lines.push(t.teamLine(esc(dn(m, lang)), openMissions(db, m.id).length, doneMissions(db, m.id).length, pendingRequests(db, m.id).length, Boolean(linked && !linked.has(m.id))));
  }
  lines.push('', t.teamHint);
  return lines.join('\n');
}

// 보낸 미션: 내가 다른 사람에게 준·요청한 미션이 어떻게 됐는지(최근 것부터)
export function sentText(viewer, members, db, lang = langOf(db, viewer.id)) {
  const t = tr(lang);
  const who = (id) => { const x = members.find((y) => y.id === id); return esc(x ? dn(x, lang) : id); };
  const mine = db.missions.filter((m) => m.createdBy === viewer.id && m.assignee !== viewer.id).sort((a, b) => b.id.localeCompare(a.id));
  const group = (status) => mine.filter((m) => m.status === status);
  const lines = [t.sentTitle, ''];
  if (!mine.length) return [...lines, t.sentNone].join('\n');
  const block = (title, list, max = 10) => {
    if (!list.length) return;
    lines.push(`<b>${title} ${list.length}</b>`, ...list.slice(0, max).map((m) => `• ${who(m.assignee)} — ${esc(clip(m.title, 80))}`));
    if (list.length > max) lines.push(t.andMore(list.length - max));
    lines.push('');
  };
  block(t.sentWaiting, group('requested'));
  block(t.sentProgress, group('todo'));
  block(t.sentDone, group('done'), 5);
  block(t.sentDeclined, group('declined'), 5);
  return lines.join('\n').trimEnd();
}

// 요청 알림(받는 관리자에게, 그 사람의 언어로, 수락/거절 버튼과 함께)
export function requestNotice(requester, added, lang = 'ko') {
  const t = tr(lang);
  const r = esc(dn(requester, lang));
  return {
    text: [t.reqTitle, '', t.reqFrom(r), ...added.slice(0, 5).map((m, i) => `${i + 1}. ${esc(clip(m.title, 150))}${m.detail ? `\n<blockquote expandable>${esc(clip(m.detail, 400))}</blockquote>` : ''}`),
      ...(added.length > 5 ? [t.reqMoreBoard(added.length - 5)] : []), '', t.reqFooter(r)].join('\n'),
    reply_markup: { inline_keyboard: added.slice(0, 5).map((m, i) => [{ text: t.acceptBtn(i + 1), callback_data: `a:${m.id}` }, { text: t.declineBtn(i + 1), callback_data: `n:${m.id}` }]) },
  };
}

// 요청 결과 알림(요청한 사람에게, 그 사람의 언어로)
export function respondNotice(mission, accept, actor, assignee, lang = 'ko') {
  const t = tr(lang);
  const n = esc(dn(assignee, lang));
  const by = actor.id !== assignee.id ? t.handledBy(esc(dn(actor, lang))) : '';
  return accept ? `${t.accepted(n)}${by}\n• ${esc(clip(mission.title, 150))}\n\n${t.nowYours(n)}` : `${t.declined(n)}${by}\n• ${esc(clip(mission.title, 150))}`;
}

// 인라인 버튼(callback_data) 하나를 어떻게 처리할지(순수 함수). viewer: 누른 사람(연결된 팀원, 없으면 null)
//   v:<팀원> 보기·새로고침 · s:<팀원> 미션 주기/요청 시작 · c:<미션> 완료(확인 받음) · a:/n:<미션> 요청 수락/거절
//   l:<ko|en|zh> 언어 고르기 · g:/x:<키> 확인/취소. 안내 문구는 누른 사람의 언어로.
export function decideCallback(data, { viewer, members, db, lang = viewer ? langOf(db, viewer.id) : 'ko' }) {
  const t = tr(lang);
  const m = String(data || '').match(/^([a-z]):([\w-]{1,40})$/);
  if (!m) return { kind: 'stale', text: t.unknownBtn };
  const [, act, arg] = m;
  if (act === 'g' || act === 'x') return { kind: 'pending', confirm: act === 'g', key: arg };
  if (!viewer) return { kind: 'stale', text: t.linkFirst };
  if (act === 'l') return isLang(arg) ? { kind: 'lang', lang: arg } : { kind: 'stale', text: t.unknownBtn };
  if (act === 'v' || act === 's') {
    const member = members.find((x) => x.id === arg);
    if (!member) return { kind: 'stale', text: t.notInRoster };
    if (act === 'v') return { kind: 'board', member };
    const mode = sendMode(viewer, member);
    return mode ? { kind: 'compose', target: member, mode } : { kind: 'stale', text: sendDeniedText(viewer, member, members, lang).replace(/<[^>]+>/g, '') };
  }
  const mission = db.missions.find((x) => x.id === arg);
  const target = mission && members.find((x) => x.id === mission.assignee);
  if (!mission || !target) return { kind: 'stale', text: t.noMission };
  if (act === 'c') {
    if (mission.status !== 'todo') return { kind: 'stale', text: t.changed };
    if (mission.assignee !== viewer.id && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: t.onlyOwn };
    return { kind: 'confirm-done', target, picked: [{ id: mission.id, title: mission.title }] };
  }
  if (act === 'a' || act === 'n') {
    if (mission.status !== 'requested') return { kind: 'stale', text: t.handled };
    if (act === 'a' && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: t.acceptAdmin };
    if (act === 'n' && viewer.id !== mission.assignee && !ADMIN_ROLES.has(viewer.role)) return { kind: 'stale', text: t.declineWho };
    return { kind: 'respond', accept: act === 'a', mission, target, requester: members.find((x) => x.id === mission.createdBy) || null };
  }
  return { kind: 'stale', text: t.unknownBtn };
}

// 미션 주기/요청 버튼을 누른 뒤 보내는 안내. 답장 강제(force_reply)는 쓰지 않는다 — 늘 떠 있는 이름 버튼판이 사라지므로.
export function composePrompt(target, mode, lang = 'ko') {
  return tr(lang).compose(esc(dn(target, lang)), mode).join('\n');
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

function parseItems(chatId, text, t) {
  let items;
  try { items = parseMissionList(text); } catch (e) { return { kind: 'act-error', chatId, error: e.message }; }
  if (!items.length) return { kind: 'act-error', chatId, error: t.empty };
  if (items.length > MAX_ITEMS) return { kind: 'act-error', chatId, error: t.tooMany(MAX_ITEMS, items.length) };
  return { items };
}

// 버튼 이름·명령 낱말은 세 언어 모두 알아듣는다(언어를 바꾼 직후 예전 버튼판을 눌러도 되게)
const BOT_BTN = [/^(\S+?)\s*봇$/, /^(\S+?)\s+bot$/i, /^(\S+?)\s*机器人$/];
// 중국어는 띄어쓰기가 없어 "任务设置页面有问题"(설정 화면 문제) 같은 보통 문장과 겹친다 → 설정·추가는 뒤에 띄어쓰기·줄바꿈이 있을 때만,
// 완료는 뒤가 번호(·미션 ID)뿐일 때만 명령으로 본다.
const KEYWORDS = [/^미션\s*(설정|추가|완료)\s*([\s\S]*)$/, /^mission\s+(set|add|done)(?=\s|$)\s*([\s\S]*)$/i,
  /^任务\s*(设置|添加)(?=\s|$)\s*([\s\S]*)$/, /^任务\s*(完成)\s*((?:M-\d{4,}|\d{1,3})(?:[\s,，、]+(?:M-\d{4,}|\d{1,3}))*)\s*$/i];
const KW_ACTION = { 설정: 'set', 추가: 'add', 완료: 'done', set: 'set', add: 'add', done: 'done', 设置: 'set', 添加: 'add', 完成: 'done' };

// 받은 메시지 하나를 어떻게 처리할지(순수 함수 — 테스트 대상). chatOwners: Map(chatId → 팀원 아이디)
// compose: 📨 버튼을 눌러 미션 내용을 기다리는 중이면 { target, mode } — 버튼·명령이 아닌 글은 그 사람에게 보낼 미션으로 본다.
// lang: 답할 문구의 언어(보낸 사람이 고른 언어)
export function decide(msg, { members, chatOwners, compose = null, lang = 'ko' }) {
  const t = tr(lang);
  if (!msg?.chat || typeof msg.text !== 'string') return { kind: 'ignore' };
  if (msg.chat.type !== 'private') return { kind: 'ignore' }; // 단체방에서는 답하지 않는다(미션 공개 방지)
  const chatId = String(msg.chat.id);
  const owner = members.find((m) => m.id === chatOwners.get(chatId)) || null;
  const text = msg.text.trim();
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (start?.[1]) return { kind: 'link', chatId };
  if (start || /^\/(menu|help)(@\w+)?$/.test(text) || /^(메뉴|menu|菜单)$/i.test(text)) return { kind: 'menu', chatId, owner };
  if (compose && /^(취소|cancel|取消|\/cancel(@\w+)?)$/i.test(text)) return { kind: 'cancel', chatId };
  const byName = (n) => members.find((m) => m.name === n || m.id === String(n).toLowerCase()) || null;
  const team = allLabels('teamBtn').includes(text) || /^(팀\s*현황|team|团队概况|\/team(@\w+)?)$/i.test(text);
  const sent = allLabels('sentBtn').includes(text) || /^(보낸\s*미션|sent|我发出的|\/sent(@\w+)?)$/i.test(text);
  const langMenu = allLabels('langBtn').includes(text) || /^(언어|language|语言|\/lang(@\w+)?)$/i.test(text);
  const me = /^\/me(@\w+)?$/.test(text) || /^(내\s*미션|my\s+missions|我的任务)$/i.test(text);
  let btnTarget = null;
  for (const re of BOT_BTN) { const b = text.match(re); if (b && (btnTarget = byName(b[1]))) break; }
  if (team || sent || langMenu || me || btnTarget) {
    if (!owner) return { kind: 'unlinked', chatId };
    if (team || sent) return { kind: team ? 'team' : 'sent', chatId, owner };
    if (langMenu) return { kind: 'lang-menu', chatId, owner };
    return { kind: 'board', chatId, owner, member: me ? owner : btnTarget };
  }
  if (compose && owner && !text.startsWith('/')) {
    const mode = sendMode(owner, compose.target);
    if (!mode) return { kind: 'act-denied', chatId, owner, action: 'add', text: sendDeniedText(owner, compose.target, members, lang) };
    const p = parseItems(chatId, text, t);
    return p.items ? { kind: 'act', action: mode, chatId, owner, target: compose.target, items: p.items } : p;
  }
  // 미션 명령: "<이름>[님][에게|한테|께][,:] <내용>" — 내용이 "미션설정/미션추가/미션완료 …"(mission set/add/done, 任务设置/添加/完成)이면
  // 그 명령, 아니면 미션 주기(팀원은 관리자에게 요청)
  const m = text.match(/^(\S+?)(?:님)?(?:에게|한테|께)?(?:[ \t]*[:,]?[ \t]+|[ \t]*[:,]?[ \t]*\n)([\s\S]+)$/);
  const target = m && byName(m[1]);
  if (!target) return { kind: 'menu', chatId, owner };
  if (!owner) return { kind: 'unlinked', chatId };
  let kw = null;
  for (const re of KEYWORDS) if ((kw = m[2].match(re))) break;
  const action = kw ? KW_ACTION[kw[1].toLowerCase()] : 'add';
  const rest = kw ? kw[2] : m[2];
  const admin = ADMIN_ROLES.has(owner.role);
  if (action === 'done') {
    const refs = rest.split(/[\s,，、]+/).filter(Boolean);
    if (!refs.length) return { kind: 'act-error', chatId, error: t.needNumber(dn(target, lang)) };
    if (target.id !== owner.id && !admin) return { kind: 'act-denied', chatId, owner, action, text: t.deniedDoneOthers };
    return { kind: 'act', action, chatId, owner, target, refs };
  }
  if (action === 'set' && !admin) return { kind: 'act-denied', chatId, owner, action, text: t.deniedSet(esc(adminNames(members, lang))) };
  const mode = action === 'set' ? 'set' : sendMode(owner, target);
  if (!mode) return { kind: 'act-denied', chatId, owner, action, text: sendDeniedText(owner, target, members, lang) };
  const p = parseItems(chatId, rest, t);
  return p.items ? { kind: 'act', action: mode, chatId, owner, target, items: p.items } : p;
}

// 확인 메시지(완료는 번호를 지금 목록의 미션으로 바꿔 보여 주고, 확인 때는 그 ID 로 처리)
export function confirmText(d, picked = [], lang = 'ko') {
  const t = tr(lang);
  const n = esc(dn(d.target, lang));
  if (d.action === 'done') return [t.confirmDone(n), ...picked.map((x) => `• [${x.id}] ${esc(x.title)}`)].join('\n');
  const head = d.action === 'set' ? t.confirmSet(n) : d.action === 'request' ? t.confirmRequest(n) : t.confirmGive(n);
  return [head, ...d.items.slice(0, 10).map((it) => `• ${esc(it.title)}`), ...(d.items.length > 10 ? [t.andMore(d.items.length - 10)] : [])].join('\n');
}

// 확인(✅)을 누른 뒤 저장할 내용 — 봇(bot.mjs)과 봇 서버(worker)가 같이 쓴다
export const ACTIONS = {
  add: { label: '미션추가', apply: (p) => (db, ms, actor) => addMissions(db, p.targetId, p.items, actor.id, ms) },
  request: { label: '미션요청', apply: (p) => (db, ms, actor) => requestMissions(db, p.targetId, p.items, actor.id, ms) },
  set: { label: '미션설정', apply: (p) => (db, ms, actor) => setMissions(db, p.targetId, p.items, actor.id, ms) },
  done: { label: '미션완료', apply: (p) => (db, ms, actor) => ({ done: completeMissions(db, p.targetId, p.ids, { by: actor.id, members: ms }), changed: true }) },
};

// 저장 결과 문구(확인 메시지를 이 문구로 바꾼다). targetName: 보는 사람의 언어로 표시할 이름(이스케이프 전).
export function resultText(action, targetName, w, lang = 'ko') {
  const t = tr(lang);
  const n = esc(targetName);
  const r = w.result;
  if (w.unchanged) return t.unchanged(n);
  const out = action === 'done' ? [t.didDone(n), ...r.done.map((m) => `• [${m.id}] ${esc(m.title)}`)]
    : action === 'set' ? [t.didSet(n, r.added.length, r.kept.length, r.replaced.length)]
      : [action === 'request' ? t.didRequest(n) : t.didGive(n), ...r.added.map((m) => `• [${m.id}] ${esc(m.title)}`), ...(r.skipped.length ? [t.skipped(r.skipped.map(esc).join(', '))] : [])];
  out.push('', action === 'request' ? t.afterRequest(n) : action === 'done' ? t.afterDone : t.afterGive(n));
  return out.join('\n');
}

export function resolveRefs(db, memberId, refs) {
  const open = openMissions(db, memberId);
  return refs.map((r) => {
    const key = String(r).trim().toUpperCase();
    const m = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((x) => x.id === key);
    const left = open.map((x, i) => i + 1).join(', ');
    if (!m) throw Object.assign(new Error(`미션을 찾지 못했어요: ${r} (남은 미션 번호: ${left || '없음'})`), { ref: String(r), left });
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
