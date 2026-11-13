#!/usr/bin/env node
// 플레이어 작업 기록: [데이터 라벨링] · [데이터 압축] · [데이터 업로드]
// 각자 자기 폴더(data/players/<아이디>/work.json)에만 쓴다 → 여러 명이 동시에 올려도 서로 덮어쓰지 않는다.
//
//   node mimic-note/work.mjs <이름> <단계> <대상> <상태> ["메모"]
//     단계: 라벨링|labeling · 압축|compression · 업로드|upload
//     상태: 시작|doing · 완료|done · 취소|cancel(기록 삭제)
//   node mimic-note/work.mjs <이름>            내 작업 기록 보기
//
// 예) node mimic-note/work.mjs 루카스 라벨링 강의-001 시작
// 바꾼 뒤 git commit·push 하면, 패시브 스킬 [자동 다운로드]가 10분 안에 모두의 기록을 모아 투두를 다시 계산한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, requireMember } from './lib.mjs';

export const STAGES = ['labeling', 'compression', 'upload'];
export const STAGE_NAME = { labeling: '데이터 라벨링', compression: '데이터 압축', upload: '데이터 업로드' };
const STAGE_ALIAS = { 라벨링: 'labeling', 데이터라벨링: 'labeling', labeling: 'labeling', 압축: 'compression', 데이터압축: 'compression', compression: 'compression', 업로드: 'upload', 데이터업로드: 'upload', upload: 'upload' };
const STATUS_ALIAS = { 시작: 'doing', 진행: 'doing', doing: 'doing', 완료: 'done', done: 'done', 취소: 'cancel', cancel: 'cancel' };

export function workPath(memberId, dir = NOTE_DIR) {
  return path.join(dir, 'data', 'players', memberId, 'work.json');
}

export function emptyWork(memberId) {
  return { player: memberId, items: [] };
}

export function loadWork(memberId, dir = NOTE_DIR) {
  const file = workPath(memberId, dir);
  if (!fs.existsSync(file)) return emptyWork(memberId);
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { player: memberId, items: Array.isArray(w.items) ? w.items : [] };
  } catch {
    return { ...emptyWork(memberId), broken: true }; // 깨진 파일은 그 사람만 영향받고 전체는 계속 돈다
  }
}

export function saveWork(work, dir = NOTE_DIR) {
  const file = workPath(work.player, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ player: work.player, items: work.items }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadAllWorks(members, dir = NOTE_DIR) {
  return Object.fromEntries(members.map((m) => [m.id, loadWork(m.id, dir)]));
}

// 같은 (단계, 대상) 기록은 하나만 둔다. 상태가 바뀌면 덮어쓴다.
export function recordWork(work, { stage, target, status, note = '' }, now = new Date().toISOString()) {
  const s = STAGE_ALIAS[String(stage || '').replace(/\s/g, '').toLowerCase()] || STAGE_ALIAS[String(stage || '').replace(/\s/g, '')];
  if (!s) throw new Error(`단계를 모르겠습니다: "${stage}". 라벨링 · 압축 · 업로드 중 하나`);
  const st = STATUS_ALIAS[String(status || '').toLowerCase()] || STATUS_ALIAS[status];
  if (!st) throw new Error(`상태를 모르겠습니다: "${status}". 시작 · 완료 · 취소 중 하나`);
  const t = String(target || '').trim();
  if (!t) throw new Error('대상(무엇을 작업했는지)이 비어 있습니다.');
  const i = work.items.findIndex((x) => x.stage === s && x.target === t);
  if (st === 'cancel') {
    if (i === -1) throw new Error(`취소할 기록이 없습니다: ${STAGE_NAME[s]} ${t}`);
    work.items.splice(i, 1);
    return null;
  }
  const item = { stage: s, target: t, status: st, note: String(note || ''), updatedAt: now };
  if (i === -1) work.items.push(item);
  else work.items[i] = item;
  return item;
}

export function formatWork(member, work) {
  if (!work.items.length) return `${member.name}님의 작업 기록이 없습니다.`;
  return work.items
    .map((x) => `- ${STAGE_NAME[x.stage]} · ${x.target} · ${x.status === 'done' ? '완료' : '진행 중'}${x.note ? ` (${x.note})` : ''}`)
    .join('\n');
}

export function run(argv, dir) {
  const [who, stage, target, status, note] = argv;
  const members = loadMembers(dir);
  const member = requireMember(who, members);
  const work = loadWork(member.id, dir);
  if (!stage) return formatWork(member, work);
  const item = recordWork(work, { stage, target, status, note });
  saveWork(work, dir);
  const what = item ? `${STAGE_NAME[item.stage]} · ${item.target} → ${item.status === 'done' ? '완료' : '진행 중'}` : '기록 취소';
  return `기록했습니다: ${member.name}님 ${what}\n→ git commit·push 하면 [자동 다운로드]가 10분 안에 반영합니다.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
