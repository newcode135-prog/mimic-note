// 미믹노트 AI 하네스 v1: 호출 기준, 실패 시 규칙으로 계속, 제안 재사용, 관리자 판정과 eval, 패시브 스킬 연결
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_DIR, loadMembers } from '../mimic-note/lib.mjs';
import { run as workRun } from '../mimic-note/work.mjs';
import { escKey, shouldCall, buildPrompt, consult, applySuggestions, recordVerdict, evaluate, loadSuggestions, run, MAX_ATTEMPTS } from '../mimic-note/harness/harness.mjs';
import { runOnce, autoPath } from '../mimic-note/passive/auto-download.mjs';

const members = loadMembers();
const db = { nextId: 1, missions: [] };
const T = '2026-11-13T00:00:00.000Z';
const esc = { reason: '같은 일을 여러 명이 진행', stage: 'labeling', target: '강의-001', players: ['yuri', 'lucas'] };
const works = {
  lucas: { items: [{ stage: 'labeling', target: '강의-001', status: 'doing' }] },
  yuri: { items: [{ stage: 'labeling', target: '강의-001', status: 'doing' }] },
};

function tempNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-harness-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(NOTE_DIR, 'data', 'members.json'), path.join(dir, 'data', 'members.json'));
  return dir;
}

test('열쇠·호출 기준: 플레이어 순서와 무관, 처음 보는 후보만, 실패는 3번까지', () => {
  assert.equal(escKey(esc), escKey({ ...esc, players: ['lucas', 'yuri'] }));
  assert.equal(shouldCall(esc, []), true);
  assert.equal(shouldCall(esc, [{ key: escKey(esc), status: 'ok' }]), false);
  assert.equal(shouldCall(esc, [{ key: escKey(esc), status: 'failed', attempts: 1 }]), true);
  assert.equal(shouldCall(esc, [{ key: escKey(esc), status: 'failed', attempts: MAX_ATTEMPTS }]), false);
});

test('입력: 대전제·상황·작업 기록·세 번째 제안 지시가 들어간다', () => {
  const p = buildPrompt({ esc, members, db, works, premise: '대전제 본문' });
  assert.match(p, /대전제 본문/);
  assert.match(p, /대상: 강의-001/);
  assert.match(p, /루카스\(lucas\): 데이터 라벨링 진행 중/);
  assert.match(p, /세 번째 제안/);
});

test('키가 없으면 AI 를 부르지 않는다(비용 0, 규칙만)', async () => {
  const dir = tempNote();
  const r = await consult({ escalations: [esc], members, db, works, dir, env: {} });
  assert.equal(r.called, 0);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'harness', 'suggestions.json')), false);
});

test('한 번 묻고 저장 → 다음 회차는 재사용, 실패해도 멈추지 않음, 거절된 제안은 숨김', async () => {
  const dir = tempNote();
  let calls = 0;
  const ask = async () => { calls += 1; return { suggestion: '유리님은 앞 절반, 루카스님은 뒤 절반을 라벨링', assignTo: 'nobody', reason: '둘 다 이미 시작함' }; };
  const r1 = await consult({ escalations: [esc], members, db, works, dir, ask, now: T });
  assert.equal(r1.called, 1);
  assert.equal(r1.active.length, 1);
  assert.equal(r1.active[0].assignTo, null, '명부에 없는 담당자는 버린다');
  const r2 = await consult({ escalations: [esc], members, db, works, dir, ask, now: T });
  assert.equal(r2.called, 0);
  assert.equal(calls, 1, '같은 후보는 다시 부르지 않는다');

  const players = { yuri: { important: [], todos: [] }, lucas: { important: [], todos: [] } };
  applySuggestions(players, r2.active, members);
  assert.match(players.lucas.important[0], /💡 AI 제안 H-001\(관리자 결정 필요\): 유리님은 앞 절반/);

  const other = { ...esc, target: '강의-002' };
  const r3 = await consult({ escalations: [other], members, db, works, dir, ask: async () => { throw new Error('API 다운'); }, log: () => {} });
  assert.equal(r3.called, 1);
  assert.equal(r3.active.length, 0, '실패해도 예외 없이 규칙 결과로 계속');
  assert.equal(loadSuggestions(dir).items[1].status, 'failed');

  assert.throws(() => recordVerdict(dir, 'H-001', '수락', 'lucas'), /관리자/);
  recordVerdict(dir, 'H-001', '거절', 'changmin', '둘이 정하게 두자');
  const r4 = await consult({ escalations: [esc], members, db, works, dir, ask });
  assert.equal(r4.active.length, 0, '거절된 제안은 더 이상 보이지 않는다');
  assert.deepEqual({ ...evaluate(dir), version: undefined, model: undefined }, { version: undefined, model: undefined, calls: 2, suggestions: 1, failed: 1, judged: 1, accepted: 0, acceptRate: 0 });
  assert.match(run(['eval'], dir), /수락률 0%/);
  assert.match(run(['verdict', 'H-001', '수락', '--by', '민호'], dir), /H-001 수락/);
  assert.match(run(['list'], dir), /H-001 \[ok · 수락\]/);
});

test('패시브 스킬 연결: 겹침이 생기면 AI 제안이 두 사람의 더 중요한 일에 붙고, 판단 기록에 aiCalled', async () => {
  const dir = tempNote();
  workRun(['루카스', '라벨링', '강의-001', '시작'], dir);
  workRun(['유리', '라벨링', '강의-001', '시작'], dir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-home-'));
  const ask = async () => ({ suggestion: '먼저 시작한 사람이 계속하고, 다른 사람은 압축을 준비', assignTo: 'lucas', reason: 'r' });
  const r = await runOnce({ dir, useGit: false, notify: false, env: { MIMIC_NOTE_HOME: home }, log: () => {}, ask, now: T });
  assert.equal(r.changed, true);
  const auto = JSON.parse(fs.readFileSync(autoPath(dir), 'utf8'));
  for (const p of ['lucas', 'yuri']) assert.ok(auto.players[p].important.some((x) => /💡 AI 제안 H-001.*담당 제안: 루카스님/.test(x)), p);
  const log = JSON.parse(fs.readFileSync(path.join(home, 'harness', 'decisions.jsonl'), 'utf8').trim());
  assert.equal(log.aiCalled, true);
});
