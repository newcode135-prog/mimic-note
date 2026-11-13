// 미믹노트 [사고력 게임]: 봉인 → 답 → 공개 → 판정, 체크인 ④ 표시
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_DIR, loadMembers, findMember } from '../mimic-note/lib.mjs';
import { loadGames, newGame, answerGame, revealGame, judgeGame, concedeGame, latestGame, seal, run } from '../mimic-note/game.mjs';
import { checkinText } from '../mimic-note/checkin.mjs';

const members = loadMembers();
const T = '2026-11-13T00:00:00.000Z';

test('봉인: 같은 답·소금이면 같은 해시, 하나라도 다르면 다름', () => {
  assert.equal(seal('[a [b]]', 's1'), seal(' [a [b]] ', 's1'));
  assert.notEqual(seal('[a [b]]', 's1'), seal('[a [b]]', 's2'));
  assert.notEqual(seal('[a [b]]', 's1'), seal('[a [c]]', 's1'));
});

test('게임 흐름: 답 전에는 공개 불가, 틀린 소금 거부, 공개 후 판정', () => {
  const data = { player: 'changmin', games: [] };
  const { game, salt } = newGame(data, { title: 't', question: 'q', rule: 'r', answer: '[동기화 [x]]' }, T);
  assert.equal(game.id, 'G-001');
  assert.equal(game.hostAnswer, null);
  assert.throws(() => revealGame(data, '[동기화 [x]]', salt), /답하기 전에는/);
  assert.throws(() => judgeGame(data, 'draw'), /공개된 뒤/);
  answerGame(data, '[순환 [x]]', T);
  assert.throws(() => answerGame(data, '다시'), /이미 답했습니다/);
  assert.throws(() => revealGame(data, '[동기화 [x]]', 'wrong'), /봉인과 맞지 않습니다/);
  assert.throws(() => revealGame(data, '[다른 답]', salt), /봉인과 맞지 않습니다/);
  revealGame(data, '[동기화 [x]]', salt, T);
  judgeGame(data, 'player', '더 넓음');
  assert.equal(latestGame(data).status, 'done');
});

test('CLI: 자기 칸(data/players/<아이디>/games.json)에 저장', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-note-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(NOTE_DIR, 'data', 'members.json'), path.join(dir, 'data', 'members.json'));
  assert.match(run(['창민'], dir), /사고력 게임이 아직 없습니다/);
  const out = run(['창민', 'new', '제목', '문제', '규칙', '[답 [답]]'], dir);
  assert.match(out, /G-001/);
  assert.equal(loadGames('changmin', dir).games.length, 1);
  assert.match(run(['changmin'], dir), /봉인됨/);
  run(['창민', 'answer', '[내 답]'], dir);
  assert.match(run(['창민'], dir), /창민님의 답: \[내 답\]/);
});

test('실제 저장소: 창민 체크인에 ④ 마지막 사고력 게임이 보이고 소금은 저장소에 없다', () => {
  const text = checkinText(findMember('창민', members));
  const i4 = text.indexOf('④ 마지막 [사고력 게임]');
  assert.ok(i4 > text.indexOf('① 대전제'));
  const last = latestGame(loadGames('changmin'));
  assert.ok(text.slice(i4).includes(`${last.id} · ${last.title}`));
  assert.match(text.slice(i4), /Claude 의 답: \S/);
  assert.ok(!fs.readFileSync(path.join(NOTE_DIR, 'data', 'players', 'changmin', 'games.json'), 'utf8').includes('"salt"'), '소금은 저장소에 없어야 한다');
});

test('게임이 없는 플레이어 체크인도 깨지지 않는다', () => {
  assert.match(checkinText(findMember('유리', members)), /유리님의 사고력 게임이 아직 없습니다/);
});

test('패배 인정: 인정한 쪽의 결정이 무조건 최종 판정, 이후 judge 로 못 바꿈', () => {
  const data = { player: 'changmin', games: [] };
  const { salt } = newGame(data, { title: 't', question: 'q', answer: '[a [b]]' }, T);
  answerGame(data, '[c [d]]', T);
  revealGame(data, '[a [b]]', salt, T);
  judgeGame(data, 'player', '판정');
  const g = concedeGame(data, 'player', '내가 졌다', 'G-001', T);
  assert.equal(g.result, 'claude');
  assert.equal(g.resultBy, 'concession');
  assert.deepEqual(g.overriddenResult, { result: 'player', note: '판정' });
  assert.throws(() => judgeGame(data, 'draw'), /패배 인정으로 이미 확정/);
  assert.throws(() => concedeGame(data, 'claude'), /이미 패배 인정/);
});

test('패배 인정은 답 전에도, 지난 게임(id 지정)에도 된다', () => {
  const data = { player: 'changmin', games: [] };
  newGame(data, { title: '1', question: 'q', answer: 'x' }, T);
  newGame(data, { title: '2', question: 'q', answer: 'y' }, T);
  assert.equal(concedeGame(data, 'claude', '', 'g-001', T).result, 'player');
  assert.equal(data.games[1].result, null);
  assert.throws(() => concedeGame(data, 'nobody'), /player · claude/);
});

test('먼저 공개(--first): 플레이어 요청 시 답 전에 공개, 그 뒤 답하면 판정 대기', () => {
  const data = { player: 'changmin', games: [] };
  const { salt } = newGame(data, { title: 't', question: 'q', answer: '[a [b]]' }, T);
  revealGame(data, '[a [b]]', salt, T, { first: true });
  assert.equal(latestGame(data).hostFirst, true);
  assert.equal(latestGame(data).status, 'waiting-player');
  answerGame(data, '[c]', T);
  assert.equal(latestGame(data).status, 'waiting-judge');
});
