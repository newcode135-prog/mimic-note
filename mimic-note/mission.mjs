#!/usr/bin/env node
// 미믹노트 미션 관리 (data/missions.json)
//
// 보기 (이 폴더의 파일 — 먼저 git pull)
//   node mimic-note/mission.mjs list [이름]          남은 미션 보기(이름 없으면 전체)
//   node mimic-note/mission.mjs all                  전체 현황: 5명의 남은·완료 수와 상위 3개
//
// 바꾸기 (GitHub main 에 바로 저장 → GitHub Actions 가 바뀐 팀원에게만 텔레그램 발송 → 결과까지 확인)
//   node mimic-note/mission.mjs set <이름> <<'EOF'      미션설정: 남은 미션을 이 목록으로 교체(기존은 보관)
//   1. 업무 A
//   2. 업무 B
//   EOF
//   node mimic-note/mission.mjs add <이름> <<'EOF'      미션추가: 기존 유지 + 뒤에 추가(--top 이면 맨 앞)
//   4. 업무 D
//   EOF
//   node mimic-note/mission.mjs add <이름> "제목" ["설명"] [--top]   한 개만 추가
//   node mimic-note/mission.mjs done <이름> <번호|M-0001> [번호 …]  미션완료(번호는 완료 전 목록 기준)
//   node mimic-note/mission.mjs low <이름> <번호|M-0004>             후순위(맨 뒤 + 다른 관리자 체크인에 표시)
//   --no-wait  텔레그램 발송 결과를 기다리지 않음
//
// 누가 바꾸는지는 이 컴퓨터의 gh 로그인 계정(GitHub 인증) ↔ members.json 의 github 로 정한다.
// 미션 만들기·정하기·후순위는 관리자(owner·admin)만, 완료는 본인 또는 관리자만.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTE_DIR, REPO, ADMIN_ROLES, mutate, loadMembers, requireMember, loadDb, openMissions, doneMissions, setLowPriority,
  parseMissionList, setMissions, addMissions, completeMissions, memberByGithub, validateDb, validateMembers,
} from './lib.mjs';
import { createGithub, DB_FILE, MEMBERS_FILE, waitForNotify, formatNotify } from './github.mjs';

export { mutate };

const ROLE = { owner: '대표관리자', admin: '관리자', member: '팀원' };

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function listOf(member, db) {
  const open = openMissions(db, member.id);
  if (!open.length) return `${member.name}님, 지금 남은 미션이 없습니다.`;
  return [`${member.name}님의 남은 미션 (${open.length}개)`, ...open.map((m, i) => `  ${i + 1}. [${m.id}] ${m.title}${m.priority === 'low' ? ' (후순위)' : ''}`)].join('\n');
}

// 보기 명령은 GitHub main 의 최신 데이터(가능하면), 안 되면 이 폴더의 파일.
function readLatest(github, dir) {
  if (github) {
    try {
      return { members: JSON.parse(github.readFile(MEMBERS_FILE).text).members, db: JSON.parse(github.readFile(DB_FILE).text), source: 'GitHub main 최신' };
    } catch { /* 아래 로컬로 */ }
  }
  return { members: loadMembers(dir), db: loadDb(dir), source: github ? '이 폴더(GitHub 를 못 읽어 최신이 아닐 수 있음 — git pull)' : '이 폴더' };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

export async function run(argv, { dir = NOTE_DIR, github, stdin = readStdin, wait = true, sleep } = {}) {
  const args = [...argv];
  const out = [];
  const byAt = args.indexOf('--by');
  if (byAt !== -1) {
    args.splice(byAt, 2);
    out.push('(참고: --by 는 더 이상 쓰지 않습니다. 누가 바꾸는지는 gh 로그인 계정으로 확인합니다.)');
  }
  const top = takeFlag(args, '--top');
  if (takeFlag(args, '--no-wait')) wait = false;
  const [cmd, ...rest] = args;

  if (cmd === 'list' || !cmd) {
    const { members, db, source } = readLatest(github, dir);
    const targets = rest[0] ? [requireMember(rest[0], members)] : members;
    for (const m of targets) {
      const open = openMissions(db, m.id);
      const done = doneMissions(db, m.id).length;
      if (!rest[0] && !open.length && !done) continue;
      out.push(`■ ${m.name}(${m.id}) — 남은 ${open.length} · 완료 ${done}`);
      open.forEach((x, i) => out.push(`  ${i + 1}. [${x.id}] ${x.title}`));
    }
    if (!out.length) out.push('등록된 미션이 없습니다.');
    if (github) out.push(`(기준: ${source})`);
    return out.join('\n');
  }

  if (cmd === 'all') {
    const { members, db, source } = readLatest(github, dir);
    let open = 0;
    let done = 0;
    out.push('📋 미믹노트 전체 미션 현황', '');
    for (const m of members) {
      const o = openMissions(db, m.id);
      const d = doneMissions(db, m.id).length;
      open += o.length;
      done += d;
      out.push(`■ ${m.name} (${ROLE[m.role] || m.role}) — 남은 ${o.length} · 완료 ${d} · 진행률 ${d}/${o.length + d}`);
      o.slice(0, 3).forEach((x, i) => out.push(`   ${i + 1}. [${x.id}] ${x.title}${x.priority === 'low' ? ' (후순위)' : ''}`));
      if (o.length > 3) out.push(`   … 외 ${o.length - 3}개`);
    }
    out.push('', `합계: 남은 ${open} · 완료 ${done} (기준: ${source})`);
    return out.join('\n');
  }

  if (!['set', 'add', 'done', 'low'].includes(cmd)) throw new Error(`모르는 명령: ${cmd}. list | all | set | add | done | low 중 하나를 쓰세요.`);
  const [who, ...more] = rest;
  if (!who) throw new Error('팀원 이름을 주세요. 예: node mimic-note/mission.mjs set 민호');
  requireMember(who, loadMembers(dir)); // 없는 이름은 GitHub 에 가기 전에 거절
  github ??= createGithub();

  let items = [];
  if (cmd === 'set' || cmd === 'add') {
    if (cmd === 'add' && more.length) items = [{ title: more[0], detail: more[1] || '' }];
    else if (more.length) items = more.map((t) => ({ title: t, detail: '' }));
    else items = parseMissionList(await stdin());
    if (!items.length) throw new Error('미션 목록이 비어 있습니다. "1. 제목" 형식으로 한 줄에 하나씩 넣어 주세요.');
  }
  if ((cmd === 'done' || cmd === 'low') && !more.length) throw new Error('미션 번호(1, 2 …) 또는 ID(M-0001)를 주세요.');

  // 번호(2번)는 처음 읽은 목록 기준으로 ID 를 정해 두고, 충돌로 다시 시도할 때는 그 ID 로만 처리한다
  // (그사이 누가 1번을 끝내 번호가 당겨져도 엉뚱한 미션을 완료하지 않음 — 이미 끝났으면 오류)
  let ids = null;
  const apply = {
    set: (db, members, actor) => setMissions(db, who, items, actor.id, members),
    add: (db, members, actor) => addMissions(db, who, items, actor.id, members, { top }),
    done: (db, members, actor) => {
      const target = requireMember(who, members);
      const done = completeMissions(db, target.id, ids ?? more, { by: actor.id, members });
      ids ??= done.map((m) => m.id);
      return { done, changed: true };
    },
    low: (db, members, actor) => {
      const target = requireMember(who, members);
      const m = setLowPriority(db, target.id, ids?.[0] ?? more[0], actor.id, members);
      ids ??= [m.id];
      return { low: m, changed: true };
    },
  }[cmd];
  const describe = {
    set: (r) => `${who} 미션설정 — 새 ${r.added.length} · 유지 ${r.kept.length} · 보관 ${r.replaced.length}`,
    add: (r) => `${who} 미션추가 ${r.added.length}개${top ? '(최우선)' : ''}`,
    done: (r) => `${who} 미션완료 ${r.done.map((m) => m.id).join(', ')}`,
    low: (r) => `${who} 후순위 ${r.low.id}`,
  }[cmd];

  const w = await mutate(github, apply, describe);
  const member = requireMember(who, w.members);
  const r = w.result;
  if (cmd === 'set') out.push(`${w.unchanged ? '변경 없음 —' : '✅ GitHub 저장 완료 —'} ${member.name} 미션설정: 새 ${r.added.length} · 유지 ${r.kept.length} · 보관(교체) ${r.replaced.length}${r.skipped ? ` · 중복 ${r.skipped}개 제외` : ''}`);
  if (cmd === 'add') {
    out.push(`${w.unchanged ? '변경 없음 —' : '✅ GitHub 저장 완료 —'} ${member.name} 미션추가 ${r.added.length}개${r.added.length ? `: ${r.added.map((m) => `[${m.id}] ${m.title}`).join(', ')}` : ''}`);
    if (r.skipped.length) out.push(`   이미 있는 미션이라 건너뜀: ${r.skipped.join(', ')}`);
  }
  if (cmd === 'done') out.push(`✅ GitHub 저장 완료 — 완료: ${r.done.map((m) => `[${m.id}] ${m.title}`).join(', ')}`);
  if (cmd === 'low') out.push(`✅ GitHub 저장 완료 — 후순위: [${r.low.id}] ${r.low.title} (${member.name}님 목록 맨 뒤 + 다른 관리자 체크인에 표시)`);
  if (w.unchanged) {
    out.push('   커밋·텔레그램 발송 없음(이미 같은 상태).', '', listOf(member, w.db));
    return out.join('\n');
  }
  out.push(`   커밋 ${w.commit.slice(0, 7)} ${w.url}`, '', listOf(member, w.db), '');
  github.syncLocal?.();
  if (!wait) out.push('📨 텔레그램: GitHub Actions 가 바뀐 팀원에게 보냅니다(결과 확인 생략: --no-wait).');
  else {
    try {
      out.push(formatNotify(await waitForNotify(github, { commit: w.commit, sleep }), w.members));
    } catch (e) {
      out.push(`📨 텔레그램 결과 확인 실패: ${e.message}`);
    }
  }
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), { github: createGithub() }).then((s) => console.log(s), (e) => {
    console.error(e.message);
    process.exit(1);
  });
}
