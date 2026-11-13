// 미믹노트 패시브 스킬 [자동 다운로드]: 작업 기록, 규칙, 알림 대상, 한 회차 실행
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_DIR, loadMembers } from '../mimic-note/lib.mjs';
import { emptyWork, recordWork, loadWork, run as workRun } from '../mimic-note/work.mjs';
import { computeAuto, diffForNotify, formatNotify } from '../mimic-note/passive/rules.mjs';
import { runOnce, acquireLock, autoPath } from '../mimic-note/passive/auto-download.mjs';

const members = loadMembers();
const db0 = { nextId: 1, missions: [] };
const T = '2026-11-13T00:00:00.000Z';

function tempNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-note-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(NOTE_DIR, 'data', 'members.json'), path.join(dir, 'data', 'members.json'));
  return dir;
}
function works(map) {
  const out = Object.fromEntries(members.map((m) => [m.id, emptyWork(m.id)]));
  for (const [id, items] of Object.entries(map)) for (const it of items) recordWork(out[id], it, T);
  return out;
}

test('작업 기록: 한글·영문 단계와 상태, 같은 대상은 하나로 덮어쓰기, 취소', () => {
  const w = emptyWork('lucas');
  recordWork(w, { stage: '라벨링', target: '강의-001', status: '시작' }, T);
  recordWork(w, { stage: 'labeling', target: '강의-001', status: 'done' }, T);
  recordWork(w, { stage: '데이터 압축', target: '강의-001', status: '진행' }, T);
  assert.deepEqual(w.items.map((x) => [x.stage, x.status]), [['labeling', 'done'], ['compression', 'doing']]);
  recordWork(w, { stage: '압축', target: '강의-001', status: '취소' }, T);
  assert.equal(w.items.length, 1);
  assert.throws(() => recordWork(w, { stage: '요리', target: 'x', status: '시작' }), /단계를 모르겠습니다/);
  assert.throws(() => recordWork(w, { stage: '압축', target: 'x', status: '잠깐' }), /상태를 모르겠습니다/);
  assert.throws(() => recordWork(w, { stage: '압축', target: ' ', status: '시작' }), /비어 있습니다/);
});

test('작업 기록 CLI 는 자기 폴더에만 쓴다', () => {
  const dir = tempNote();
  assert.match(workRun(['루카스', '라벨링', '강의-001', '시작'], dir), /루카스님 데이터 라벨링 · 강의-001 → 진행 중/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data', 'players')), ['lucas']);
  assert.equal(loadWork('lucas', dir).items.length, 1);
  assert.match(workRun(['lucas'], dir), /강의-001 · 진행 중/);
});

test('깨진 작업 기록 파일은 그 사람만 비우고 전체는 계속 돈다', () => {
  const dir = tempNote();
  fs.mkdirSync(path.join(dir, 'data', 'players', 'yuri'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'players', 'yuri', 'work.json'), '{깨짐');
  const w = loadWork('yuri', dir);
  assert.equal(w.broken, true);
  assert.deepEqual(w.items, []);
});

test('규칙 E1: 같은 일을 두 명이 진행하면 둘 다 "더 중요한 일" + AI 검토 후보', () => {
  const r = computeAuto({ members, db: db0, works: works({
    yuri: [{ stage: '라벨링', target: '강의-001', status: '시작' }],
    lucas: [{ stage: '라벨링', target: '강의-001', status: '시작' }],
  }) });
  assert.match(r.players.yuri.important[0], /루카스님도 진행 중/);
  assert.match(r.players.lucas.important[0], /유리님도 진행 중/);
  assert.equal(r.escalations.length, 1);
  assert.equal(r.players.minho.important.length, 0);
});

test('규칙 E2: 이미 끝난 일을 다른 사람이 하고 있으면 알림', () => {
  const r = computeAuto({ members, db: db0, works: works({
    yuri: [{ stage: '압축', target: 'A', status: '완료' }],
    nathan: [{ stage: '압축', target: 'A', status: '시작' }],
  }) });
  assert.match(r.players.nathan.important[0], /이미 유리님이 완료/);
});

test('규칙 T1·T2·T3: 미션 → 이어서 하기 → 다음 단계 제안 순서', () => {
  const db = { nextId: 2, missions: [{ id: 'M-0001', assignee: 'lucas', order: 1, title: '첫 미션', status: 'todo' }] };
  const r = computeAuto({ members, db, works: works({
    lucas: [{ stage: '라벨링', target: 'A', status: '완료' }, { stage: '라벨링', target: 'B', status: '시작' }],
  }) });
  assert.deepEqual(r.players.lucas.todos, [
    '[미션 M-0001] 첫 미션',
    '이어서 하기: 데이터 라벨링 · B',
    '다음 단계: 데이터 압축 · A (아무도 시작하지 않음)',
  ]);
  // 누가 압축을 시작하면 제안이 사라진다
  const r2 = computeAuto({ members, db, works: works({
    lucas: [{ stage: '라벨링', target: 'A', status: '완료' }],
    yuri: [{ stage: '압축', target: 'A', status: '시작' }],
  }) });
  assert.ok(!r2.players.lucas.todos.some((x) => x.startsWith('다음 단계')));
});

test('알림(D1): 투두가 바뀌었거나 새 "더 중요한 일"이 있는 사람만', () => {
  const prev = { yuri: { important: [], todos: ['a'] }, lucas: { important: ['x'], todos: [] } };
  const next = { yuri: { important: [], todos: ['a'] }, lucas: { important: ['x'], todos: [] }, nathan: { important: ['급함'], todos: [] } };
  const notes = diffForNotify(prev, next);
  assert.deepEqual(notes.map((n) => n.id), ['nathan']);
  const text = formatNotify(members.find((m) => m.id === 'nathan'), notes[0]);
  assert.match(text, /더 중요한 일이 생겼어요/);
  assert.match(text, /• 급함/);
});

test('한 회차 실행: 처음엔 결과를 쓰고 알림, 같은 상태로 다시 돌면 아무것도 안 함', async () => {
  const dir = tempNote();
  workRun(['루카스', '라벨링', '강의-001', '완료'], dir);
  const sent = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-home-'));
  const env = { MIMIC_NOTE_HOME: home, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_IDS: '{"lucas":"42"}' };
  const opts = { dir, useGit: false, env, log: () => {}, send: async (tok, chat, text) => sent.push({ chat, text }) };

  const r1 = await runOnce(opts);
  assert.equal(r1.changed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, '42');
  assert.match(sent[0].text, /다음 단계: 데이터 압축 · 강의-001/);
  assert.deepEqual(r1.delivered.find((d) => d.id === 'lucas').via, ['telegram']);
  assert.ok(fs.existsSync(autoPath(dir)));

  const r2 = await runOnce(opts);
  assert.equal(r2.changed, false);
  assert.equal(sent.length, 1, '바뀐 게 없으면 다시 알리지 않는다');

  const log = fs.readFileSync(path.join(home, 'harness', 'decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(log[0]).aiCalled, false);
});

test('중복 실행 방지: 잠금이 있으면 두 번째는 건너뜀', () => {
  const lock = path.join(os.tmpdir(), `mimic-lock-test-${process.pid}`);
  const release = acquireLock(lock);
  assert.ok(release);
  assert.equal(acquireLock(lock), null);
  release();
  const again = acquireLock(lock);
  assert.ok(again);
  again();
});
