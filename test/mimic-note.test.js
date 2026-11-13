// 미믹노트: 팀원 명부, 미션 데이터베이스, 체크인 문구
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_DIR, loadMembers, findMember, loadDb, saveDb, openMissions, addMission, completeMission, formatMissions } from '../mimic-note/lib.mjs';
import { buildMessage, chatIdFor, checkinText } from '../mimic-note/checkin.mjs';
import { loadPremise } from '../mimic-note/lib.mjs';
import { run } from '../mimic-note/mission.mjs';
import { fakeGithub } from './mimic-note-fakes.js';

const members = loadMembers();

// 실제 data/ 를 건드리지 않도록 명부만 복사한 임시 미믹노트 폴더
function tempNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-note-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(NOTE_DIR, 'data', 'members.json'), path.join(dir, 'data', 'members.json'));
  return dir;
}

test('관리자 구성: 창민 대표관리자, 민호 관리자', () => {
  assert.equal(findMember('창민', members).role, 'owner');
  assert.equal(findMember('민호', members).role, 'admin');
  assert.equal(members.filter((m) => m.role === 'owner').length, 1);
});

test('이름·아이디·님 붙인 이름 모두 같은 팀원', () => {
  for (const v of ['민호', 'minho', 'Minho', ' 민호님 ', '[민호', '[minho]']) assert.equal(findMember(v, members).id, 'minho');
  for (const v of ['lucas', 'Lucas', '[lucas', '루카스', '[루카스]']) assert.equal(findMember(v, members).id, 'lucas');
  assert.equal(findMember('창민', members).id, 'changmin');
  assert.equal(findMember('없는사람', members), null);
  assert.equal(findMember('', members), null);
});

test('실제 데이터베이스: 민호님 체크인 시 미션 1·2·3번이 나온다', () => {
  const msg = buildMessage(findMember('민호', members));
  assert.match(msg, /^민호님의 미션 1번은 텔레그램 봇 만들기/);
  assert.match(msg, /민호님의 미션 2번은 봇에게 \/start 보내기/);
  assert.match(msg, /민호님의 미션 3번은 토큰·chat id 전달하고 비밀값 등록/);
  assert.match(msg, /BotFather/);
});

test('미션 추가는 관리자만, 번호는 담당자별로 1번부터', () => {
  const db = { nextId: 1, missions: [] };
  const a = addMission(db, { assignee: '유리', title: '첫 미션', by: '창민' }, members);
  const b = addMission(db, { assignee: 'yuri', title: '둘째 미션', by: '민호' }, members);
  const c = addMission(db, { assignee: '루카스', title: '다른 사람', by: '창민' }, members);
  assert.deepEqual([a.id, b.id, c.id], ['M-0001', 'M-0002', 'M-0003']);
  assert.deepEqual([a.order, b.order, c.order], [1, 2, 1]);
  assert.equal(a.createdBy, 'changmin');
  assert.throws(() => addMission(db, { assignee: '민호', title: 'x', by: '네이뜬' }, members), /관리자가 아니라/);
  assert.throws(() => addMission(db, { assignee: '민호', title: '  ', by: '창민' }, members), /비어 있습니다/);
  assert.throws(() => addMission(db, { assignee: '철수', title: 'x', by: '창민' }, members), /찾지 못했습니다/);
});

test('완료하면 남은 미션 번호가 당겨지고, 남의 미션은 완료할 수 없다', () => {
  const db = { nextId: 1, missions: [] };
  for (const t of ['A', 'B', 'C']) addMission(db, { assignee: '민호', title: t, by: '창민' }, members);
  completeMission(db, 'minho', '1');
  assert.deepEqual(openMissions(db, 'minho').map((m) => m.title), ['B', 'C']);
  assert.equal(formatMissions(findMember('민호', members), openMissions(db, 'minho')), '민호님의 미션 1번은 B\n\n민호님의 미션 2번은 C');
  completeMission(db, 'minho', 'm-0003');
  assert.throws(() => completeMission(db, 'yuri', '1'), /찾지 못했습니다/);
  assert.throws(() => completeMission(db, 'minho', '5'), /남은 미션 번호: 1\(M-0002\)/);
});

test('미션 없는 팀원은 안내 문구', () => {
  assert.equal(formatMissions(findMember('유리', members), []), '유리님, 지금 남은 미션이 없습니다.');
});

test('mission.mjs: add → list → done 이 GitHub main 에 저장된다(가짜 GitHub, 누가 했는지는 gh 로그인)', async () => {
  const dir = tempNote();
  const github = fakeGithub({ dir, login: 'darrenpual' }); // 창민
  const out = await run(['add', '민호', '테스트 미션', '설명', '--by', '유리'], { dir, github, wait: false });
  assert.match(out, /--by 는 더 이상 쓰지 않습니다/);
  assert.match(out, /GitHub 저장 완료 — 민호 미션추가 1개: \[M-0001\] 테스트 미션/);
  assert.equal(JSON.parse(github.store.get('mimic-note/data/missions.json').text).missions[0].createdBy, 'changmin', '--by 유리 가 아니라 gh 로그인(창민)으로 기록');
  assert.match(await run(['list', '민호'], { dir }), /1\. \[M-0001\] 테스트 미션/);
  assert.match(await run(['done', '민호', '1'], { dir, github, wait: false }), /완료: \[M-0001\] 테스트 미션[\s\S]*지금 남은 미션이 없습니다/);
  const db = loadDb(dir);
  assert.equal(db.missions[0].status, 'done');
  assert.equal(db.missions[0].doneBy, 'changmin');
  assert.ok(db.missions[0].doneAt);
  assert.equal(github.commits.length, 2);
  saveDb(db, dir);
  assert.equal(fs.readdirSync(path.join(dir, 'data')).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('chat id 는 개별 변수 또는 JSON 비밀값에서 읽는다', () => {
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_ID_MINHO: '1' }), '1');
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_IDS: '{"minho":"2"}' }), '2');
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_IDS: 'not json' }), null);
  assert.equal(chatIdFor('minho', {}), null);
});

test('체크인: 대전제가 먼저, 미션이 그다음', () => {
  const premise = loadPremise();
  assert.match(premise, /^# 대전제 v\d+\.\d+/);
  const minho = checkinText(findMember('민호', members));
  const p = minho.indexOf('대전제 v');
  const m = minho.indexOf('민호님의 미션 1번');
  assert.ok(p !== -1 && m !== -1 && p < m, '대전제가 미션보다 먼저 나와야 한다');
  const lucas = checkinText(findMember('lucas', members), { nextId: 1, missions: [] });
  assert.match(lucas, /대전제 v/);
  assert.match(lucas, /루카스님, 지금 남은 미션이 없습니다/);
  assert.match(lucas, /관리자가 등록합니다/);
});

test('--top 으로 넣은 미션은 그 사람의 1번이 된다', () => {
  const db = { nextId: 1, missions: [] };
  addMission(db, { assignee: '창민', title: 'A', by: '창민' }, members);
  addMission(db, { assignee: '창민', title: 'B', by: '창민' }, members);
  addMission(db, { assignee: '창민', title: '최우선', by: '창민', top: true }, members);
  assert.deepEqual(openMissions(db, 'changmin').map((m) => m.title), ['최우선', 'A', 'B']);
});

test('후순위: 관리자만 내릴 수 있고, 맨 뒤로 가며, 다른 관리자에게만 보인다', async () => {
  const { setLowPriority, othersLowMissions } = await import('../mimic-note/lib.mjs');
  const db = { nextId: 1, missions: [] };
  addMission(db, { assignee: '창민', title: '맥미니', by: '창민' }, members);
  addMission(db, { assignee: '창민', title: 'G-002', by: '창민' }, members);
  assert.throws(() => setLowPriority(db, 'changmin', 1, '네이뜬', members), /관리자가 아니라/);
  setLowPriority(db, 'changmin', 1, '창민', members);
  assert.deepEqual(openMissions(db, 'changmin').map((m) => m.title), ['G-002', '맥미니']);
  assert.match(formatMissions(findMember('창민', members), openMissions(db, 'changmin')), /맥미니 \(후순위\)/);
  assert.equal(othersLowMissions(db, findMember('민호', members), members).length, 1);
  assert.equal(othersLowMissions(db, findMember('유리', members), members).length, 1);
  assert.equal(othersLowMissions(db, findMember('창민', members), members).length, 0);
  assert.equal(othersLowMissions(db, findMember('루카스', members), members).length, 0);
});
