// 패시브 스킬 [자동 다운로드]의 판단 규칙 (v1, 규칙 기반).
// 입력: 팀원 명부, 미션 DB, 모든 플레이어의 작업 기록 → 출력: 플레이어별 { important, todos } 와 AI 검토 후보.
// 순수 함수만 둔다(파일·네트워크 없음) → 테스트하기 쉽고, 나중에 AI 하네스가 같은 입력으로 비교할 수 있다.
import { openMissions } from '../lib.mjs';
import { STAGES, STAGE_NAME } from '../work.mjs';

export const RULES_VERSION = 'rules-v1';

// (단계, 대상)별로 누가 진행 중이고 누가 끝냈는지 모은다.
export function indexWorks(works) {
  const idx = new Map();
  for (const [player, work] of Object.entries(works)) {
    for (const it of work.items || []) {
      const key = `${it.stage}\u0000${it.target}`;
      if (!idx.has(key)) idx.set(key, { stage: it.stage, target: it.target, doing: [], done: [] });
      idx.get(key)[it.status === 'done' ? 'done' : 'doing'].push(player);
    }
  }
  for (const v of idx.values()) { v.doing.sort(); v.done.sort(); }
  return idx;
}

const nameOf = (members, id) => members.find((m) => m.id === id)?.name || id;
const names = (members, ids) => ids.map((id) => `${nameOf(members, id)}님`).join('·');

export function computeAuto({ members, db, works }) {
  const idx = indexWorks(works);
  const out = Object.fromEntries(members.map((m) => [m.id, { important: [], todos: [] }]));
  const escalations = [];
  const fired = [];

  // ---- 더 중요한 일 ----
  for (const v of idx.values()) {
    const label = `${STAGE_NAME[v.stage]} · ${v.target}`;
    // E1 같은 대상·같은 단계를 2명 이상 동시에 진행 → 겹침(대전제 7조)
    if (v.doing.length >= 2) {
      for (const p of v.doing) {
        const others = v.doing.filter((x) => x !== p);
        out[p]?.important.push(`${label} 를 ${names(members, others)}도 진행 중이에요. 한 명만 진행하도록 관리자에게 알려 주세요.`);
      }
      fired.push({ rule: 'E1', stage: v.stage, target: v.target, players: v.doing });
      escalations.push({ reason: '같은 일을 여러 명이 진행', stage: v.stage, target: v.target, players: v.doing });
    }
    // E2 이미 누가 끝낸 일을 다른 사람이 진행
    if (v.done.length && v.doing.length) {
      for (const p of v.doing) {
        out[p]?.important.push(`${label} 는 이미 ${names(members, v.done)}이 완료했어요. 계속할지 확인하세요.`);
      }
      fired.push({ rule: 'E2', stage: v.stage, target: v.target, players: v.doing, doneBy: v.done });
    }
  }

  // ---- 투두 ----
  for (const m of members) {
    // T1 관리자가 배정한 미션이 가장 먼저
    openMissions(db, m.id).forEach((x) => out[m.id].todos.push(`[미션 ${x.id}] ${x.title}`));
    // T2 내가 진행 중인 작업 이어서 하기
    for (const it of works[m.id]?.items || []) {
      if (it.status !== 'done') out[m.id].todos.push(`이어서 하기: ${STAGE_NAME[it.stage]} · ${it.target}`);
    }
  }
  // T3 한 단계가 끝났는데 다음 단계를 아무도 시작하지 않음 → 앞 단계를 끝낸 사람에게 제안
  for (const v of idx.values()) {
    const next = STAGES[STAGES.indexOf(v.stage) + 1];
    if (!next || !v.done.length) continue;
    const nv = idx.get(`${next}\u0000${v.target}`);
    if (nv && (nv.doing.length || nv.done.length)) continue;
    const who = v.done[0];
    out[who]?.todos.push(`다음 단계: ${STAGE_NAME[next]} · ${v.target} (아무도 시작하지 않음)`);
    fired.push({ rule: 'T3', stage: next, target: v.target, players: [who] });
    if (v.done.length >= 2) escalations.push({ reason: '다음 단계를 누구에게 줄지 애매함(앞 단계 완료자 여러 명)', stage: next, target: v.target, players: v.done });
  }

  for (const id of Object.keys(out)) {
    out[id].important = [...new Set(out[id].important)];
    out[id].todos = [...new Set(out[id].todos)];
  }
  return { players: out, escalations, fired };
}

// 알림 대상: 투두가 바뀌었거나, 새로운 '더 중요한 일'이 생긴 사람만(D1).
export function diffForNotify(prevPlayers = {}, nextPlayers) {
  const notes = [];
  for (const [id, cur] of Object.entries(nextPlayers)) {
    const prev = prevPlayers[id] || { important: [], todos: [] };
    const newImportant = cur.important.filter((x) => !prev.important.includes(x));
    const todosChanged = JSON.stringify(prev.todos) !== JSON.stringify(cur.todos);
    if (newImportant.length || todosChanged) notes.push({ id, newImportant, todosChanged, todos: cur.todos });
  }
  return notes;
}

export function formatNotify(member, note) {
  const lines = [`[미믹노트] ${member.name}님`];
  if (note.newImportant.length) {
    lines.push('', '⚡ 더 중요한 일이 생겼어요');
    note.newImportant.forEach((x) => lines.push(`• ${x}`));
  }
  if (note.todosChanged) {
    lines.push('', '📝 투두가 바뀌었어요');
    if (note.todos.length) note.todos.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    else lines.push('지금 남은 투두가 없어요.');
  }
  return lines.join('\n');
}
