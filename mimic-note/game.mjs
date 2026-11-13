#!/usr/bin/env node
// [사고력 게임] — 플레이어와 AI 가 [ ] 언어로 겨루는 게임. 각 플레이어의 자기 칸(data/players/<아이디>/games.json)에 저장.
// 출제자의 답은 '봉인'한다: 답 + 비밀 소금의 sha256 만 공개하고, 상대가 답한 뒤 공개해서 누구나 대조할 수 있다.
//
//   node mimic-note/game.mjs <이름>                                  마지막 게임 보기
//   node mimic-note/game.mjs <이름> list                             전체 게임 목록
//   node mimic-note/game.mjs <이름> new "제목" "문제" "판정 규칙" "<봉인할 답>"   AI 가 출제(소금은 화면에만 한 번 출력 — 따로 보관)
//   node mimic-note/game.mjs <이름> answer "<내 답>"                 플레이어가 답하기
//   node mimic-note/game.mjs <이름> reveal "<봉인했던 답>" <소금>      출제자 답 공개(해시가 맞아야 함)
//   node mimic-note/game.mjs <이름> reveal "<봉인했던 답>" <소금> --first   플레이어가 '먼저 해 줘'라고 할 때만, 답 전에 공개
//   node mimic-note/game.mjs <이름> judge <player|claude|draw> "이유"  승패 기록
//   node mimic-note/game.mjs <이름> concede <player|claude> [G-001] "이유"   패배 인정 — 인정한 쪽의 결정이 무조건 최종 판정
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, requireMember } from './lib.mjs';

export function gamesPath(memberId, dir = NOTE_DIR) {
  return path.join(dir, 'data', 'players', memberId, 'games.json');
}

export function loadGames(memberId, dir = NOTE_DIR) {
  try {
    const g = JSON.parse(fs.readFileSync(gamesPath(memberId, dir), 'utf8'));
    return { player: memberId, games: Array.isArray(g.games) ? g.games : [] };
  } catch {
    return { player: memberId, games: [] };
  }
}

export function saveGames(data, dir = NOTE_DIR) {
  const file = gamesPath(data.player, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const seal = (answer, salt) => `sha256:${crypto.createHash('sha256').update(`${salt}\n${answer.trim()}`).digest('hex')}`;

export function newGame(data, { title, question, rule, answer, salt = crypto.randomBytes(8).toString('hex') }, now = new Date().toISOString()) {
  if (!title || !question) throw new Error('제목과 문제가 필요합니다.');
  if (!answer) throw new Error('봉인할 출제자 답이 필요합니다.');
  const game = {
    id: `G-${String(data.games.length + 1).padStart(3, '0')}`,
    at: now,
    host: 'claude',
    title, question, rule: rule || '',
    hostAnswerSeal: seal(answer, salt),
    playerAnswer: null, playerAnsweredAt: null,
    hostAnswer: null, revealedAt: null,
    result: null, resultNote: '',
    status: 'waiting-player',
  };
  data.games.push(game);
  return { game, salt };
}

export const latestGame = (data) => data.games[data.games.length - 1] || null;

function requireLatest(data) {
  const g = latestGame(data);
  if (!g) throw new Error('아직 사고력 게임이 없습니다.');
  return g;
}

function requireGame(data, id) {
  if (!id) return requireLatest(data);
  const g = data.games.find((x) => x.id === String(id).toUpperCase());
  if (!g) throw new Error(`게임을 찾지 못했습니다: ${id}`);
  return g;
}

export function answerGame(data, answer, now = new Date().toISOString()) {
  const g = requireLatest(data);
  if (g.playerAnswer) throw new Error(`${g.id} 에는 이미 답했습니다: ${g.playerAnswer}`);
  if (!String(answer || '').trim()) throw new Error('답이 비어 있습니다.');
  g.playerAnswer = String(answer).trim();
  g.playerAnsweredAt = now;
  if (!g.result) g.status = g.hostAnswer ? 'waiting-judge' : 'waiting-reveal';
  return g;
}

// first: 플레이어가 '출제자가 먼저 해 줘'라고 했을 때만 답 전에 공개한다(기록에 hostFirst 로 남는다).
export function revealGame(data, answer, salt, now = new Date().toISOString(), { first = false } = {}) {
  const g = requireLatest(data);
  if (!g.playerAnswer && !first) throw new Error('플레이어가 답하기 전에는 공개하지 않습니다(봉인 유지). 플레이어가 먼저 해 달라고 했으면 --first');
  if (seal(String(answer || ''), String(salt || '')) !== g.hostAnswerSeal) throw new Error('봉인과 맞지 않습니다. 답이나 소금이 다릅니다.');
  g.hostAnswer = String(answer).trim();
  g.revealedAt = now;
  if (!g.playerAnswer) g.hostFirst = true;
  if (!g.result) g.status = g.playerAnswer ? 'waiting-judge' : 'waiting-player';
  return g;
}

export function judgeGame(data, result, note = '') {
  const g = requireLatest(data);
  if (g.resultBy === 'concession') throw new Error(`${g.id} 은 패배 인정으로 이미 확정됐습니다(${g.concededBy === 'claude' ? 'Claude' : '플레이어'} 인정). 판정을 바꿀 수 없습니다.`);
  if (!g.hostAnswer) throw new Error('양쪽 답이 공개된 뒤에 승패를 기록합니다.');
  if (!['player', 'claude', 'draw'].includes(result)) throw new Error('결과는 player · claude · draw 중 하나');
  g.result = result;
  g.resultNote = note;
  g.resultBy = 'judge';
  g.status = 'done';
  return g;
}

// 패배 인정: 인정한 사람의 결정이 무조건 최종 판정이 된다. 언제든(답 전·판정 후에도) 할 수 있고, 이후 judge 로 바꿀 수 없다.
// 이미 판정이 있었다면 그 판정은 overriddenResult 로 남긴다.
export function concedeGame(data, by, note = '', id = null, now = new Date().toISOString()) {
  if (!['player', 'claude'].includes(by)) throw new Error('패배를 인정하는 쪽은 player · claude 중 하나');
  const g = requireGame(data, id);
  if (g.resultBy === 'concession') throw new Error(`${g.id} 은 이미 패배 인정으로 확정됐습니다.`);
  if (g.result) g.overriddenResult = { result: g.result, note: g.resultNote };
  g.result = by === 'player' ? 'claude' : 'player';
  g.resultNote = note;
  g.resultBy = 'concession';
  g.concededBy = by;
  g.concededAt = now;
  g.status = 'done';
  return g;
}

const STATUS = {
  'waiting-player': '플레이어의 답을 기다리는 중',
  'waiting-reveal': '출제자(Claude)의 봉인 답 공개를 기다리는 중',
  'waiting-judge': '승패 판정을 기다리는 중',
  done: '끝남',
};

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

export function formatGame(member, g) {
  if (!g) return `${member.name}님의 사고력 게임이 아직 없습니다.`;
  const lines = [
    `${g.id} · ${g.title}  (${kst(g.at)} KST, 상태: ${STATUS[g.status] || g.status})`,
    '',
    g.question,
  ];
  if (g.rule) lines.push('', `판정 규칙: ${g.rule}`);
  lines.push('', `Claude 의 답: ${g.hostAnswer ?? `봉인됨 (${g.hostAnswerSeal.slice(0, 19)}…)`}`);
  lines.push(`${member.name}님의 답: ${g.playerAnswer ?? '아직 없음'}`);
  if (g.hostFirst) lines.push('(플레이어 요청으로 Claude 가 먼저 공개)');
  if (g.result) {
    const how = g.resultBy === 'concession' ? ` (${g.concededBy === 'claude' ? 'Claude' : `${member.name}님`} 패배 인정 — 확정)` : '';
    lines.push(`결과: ${{ player: `${member.name}님 승`, claude: 'Claude 승', draw: '무승부' }[g.result]}${how}${g.resultNote ? ` — ${g.resultNote}` : ''}`);
  }
  if (g.status === 'waiting-player') lines.push('', `답하려면: node mimic-note/game.mjs ${member.id} answer "[답 [답]]"  (그 뒤 git commit·push)`);
  return lines.join('\n');
}

export function run(argv, dir) {
  const [who, cmd, ...rest] = argv;
  const member = requireMember(who, loadMembers(dir));
  const data = loadGames(member.id, dir);
  if (!cmd) return formatGame(member, latestGame(data));
  if (cmd === 'list') return data.games.map((g) => `${g.id} ${kst(g.at)} ${g.title} — ${STATUS[g.status]}${g.result ? ` (${{ player: `${member.name}님 승`, claude: 'Claude 승', draw: '무승부' }[g.result]}${g.resultBy === 'concession' ? ', 패배 인정' : ''})` : ''}`).join('\n') || '게임이 없습니다.';
  let out;
  if (cmd === 'new') {
    const [title, question, rule, answer] = rest;
    const { game, salt } = newGame(data, { title, question, rule, answer });
    out = `출제했습니다: ${game.id} ${game.title}\n봉인: ${game.hostAnswerSeal}\n소금(공개 전까지 따로 보관, 저장소에 올리지 말 것): ${salt}`;
  } else if (cmd === 'answer') {
    out = `답을 기록했습니다: ${answerGame(data, rest[0]).playerAnswer}`;
  } else if (cmd === 'reveal') {
    out = `공개했습니다(봉인 일치): ${revealGame(data, rest[0], rest[1], undefined, { first: rest.includes('--first') }).hostAnswer}`;
  } else if (cmd === 'judge') {
    out = `결과를 기록했습니다: ${judgeGame(data, rest[0], rest[1] || '').result}`;
  } else if (cmd === 'concede') {
    const [by, ...more] = rest;
    const id = more[0] && /^G-\d+$/i.test(more[0]) ? more.shift() : null;
    const g = concedeGame(data, by, more[0] || '', id);
    out = `패배 인정으로 확정했습니다: ${g.id} ${g.result === 'player' ? `${member.name}님 승` : 'Claude 승'}`;
  } else {
    throw new Error(`모르는 명령: ${cmd}. list | new | answer | reveal | judge | concede`);
  }
  saveGames(data, dir);
  return `${out}\n→ git commit·push 해야 다른 기기·Claude Code 에서도 보입니다.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
