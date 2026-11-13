#!/usr/bin/env node
// AI 하네스 v1 — 패시브 스킬 [자동 다운로드]가 "규칙만으로 애매하다"고 넘긴 경우(AI 검토 후보)에 Claude 를 부르는 장치.
//
// 원칙(대전제 8조·11조)
//   - 규칙이 먼저, AI 는 애매할 때만. AI 는 '제안'만 하고 결정은 관리자가 한다.
//   - 같은 후보는 한 번만 부른다(제안을 저장해 두고 다음 회차에 재사용 → 10분마다 돈이 나가지 않는다).
//   - AI 호출이 실패하거나 키가 없어도 패시브 스킬은 규칙 결과로 계속 돈다.
//   - 관리자가 제안을 수락/거절하면 그것이 '정답 데이터'가 되고, eval 로 정확도를 잰다.
//
// 저장 위치
//   data/harness/suggestions.json  AI 제안(패시브 스킬만 씀)
//   data/harness/verdicts.json     관리자 판정(관리자만 씀)
//
//   node mimic-note/harness/harness.mjs list                              제안 목록
//   node mimic-note/harness/harness.mjs verdict H-001 수락|거절 --by 창민 ["메모"]   관리자 판정
//   node mimic-note/harness/harness.mjs eval                              호출 수·판정 수·수락률
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, requireMember, loadPremise, openMissions } from '../lib.mjs';
import { STAGE_NAME } from '../work.mjs';

export const HARNESS_VERSION = 'harness-v1';
export const MODEL = 'claude-opus-5-5';
export const MAX_ATTEMPTS = 3;
const ADMINS = ['changmin', 'minho'];

const harnessDir = (dir) => path.join(dir, 'data', 'harness');
export const suggestionsPath = (dir = NOTE_DIR) => path.join(harnessDir(dir), 'suggestions.json');
export const verdictsPath = (dir = NOTE_DIR) => path.join(harnessDir(dir), 'verdicts.json');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export const loadSuggestions = (dir) => readJson(suggestionsPath(dir), { version: HARNESS_VERSION, items: [] });
export const loadVerdicts = (dir) => readJson(verdictsPath(dir), { verdicts: {} });

// 같은 후보인지 알아보는 열쇠: 이유·단계·대상·관련 플레이어
export const escKey = (e) => [e.reason, e.stage, e.target, [...(e.players || [])].sort().join(',')].join('|');

// ---- 호출 기준(정책 v1): 처음 보는 후보만, 실패는 3번까지 ----
export function shouldCall(esc, items) {
  const prev = items.find((x) => x.key === escKey(esc));
  if (!prev) return true;
  return prev.status === 'failed' && (prev.attempts || 0) < MAX_ATTEMPTS;
}

// ---- AI 에 넘길 입력 ----
export function buildPrompt({ esc, members, db, works, premise }) {
  const nameOf = (id) => members.find((m) => m.id === id)?.name || id;
  const related = Object.entries(works).flatMap(([p, w]) =>
    (w.items || []).filter((it) => it.target === esc.target).map((it) => `- ${nameOf(p)}(${p}): ${STAGE_NAME[it.stage]} ${it.status === 'done' ? '완료' : '진행 중'}`));
  const missions = esc.players.flatMap((p) => openMissions(db, p).map((m) => `- ${nameOf(p)}: [${m.id}] ${m.title}`));
  return [
    '너는 미믹노트 패시브 스킬의 AI 조언자다. 아래 대전제를 따른다. 너는 제안만 하고, 결정은 관리자(창민·민호)가 한다.',
    '', '## 대전제', premise.trim(),
    '', '## 규칙이 애매하다고 넘긴 상황',
    `이유: ${esc.reason}`, `단계: ${STAGE_NAME[esc.stage] || esc.stage}`, `대상: ${esc.target}`,
    `관련 플레이어: ${esc.players.map((p) => `${nameOf(p)}(${p})`).join(', ')}`,
    '', '## 이 대상의 작업 기록', related.join('\n') || '- 없음',
    '', '## 관련 플레이어의 남은 미션', missions.join('\n') || '- 없음',
    '', '## 할 일',
    '관련된 모두가 만족하는 제안 하나를 내라. 한쪽을 고르는 것이 최선이 아니면, 틀 밖의 세 번째 제안을 낸다.',
    '가장 빠르게 실행할 수 있는 형태로, 한국어 1~2문장. 담당을 정해야 하면 assignTo 에 플레이어 아이디 하나, 아니면 null.',
  ].join('\n');
}

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      suggestion: { type: 'string' },
      assignTo: { type: ['string', 'null'] },
      reason: { type: 'string' },
    },
    required: ['suggestion', 'assignTo', 'reason'],
    additionalProperties: false,
  },
};

// ---- Claude 호출(기본 구현). 테스트에서는 ask 를 갈아끼운다 ----
export async function askClaude(prompt, { apiKey }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: OUTPUT_SCHEMA },
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`AI 가 응답을 거절함(${res.stop_details?.category ?? '분류 없음'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('AI 응답이 길이 제한에 걸림');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...JSON.parse(text), model: res.model };
}

// ---- 한 회차: 후보마다 필요하면 AI 를 부르고, 제안을 저장하고, 지금 유효한 제안을 돌려준다 ----
export async function consult({ escalations, members, db, works, dir = NOTE_DIR, env = {}, ask = askClaude, now = new Date().toISOString(), log = () => {} }) {
  const store = loadSuggestions(dir);
  const memberIds = new Set(members.map((m) => m.id));
  let called = 0;
  let changed = false;
  if (env.ANTHROPIC_API_KEY || ask !== askClaude) {
    let premise;
    try { premise = loadPremise(dir); } catch { premise = loadPremise(); }
    for (const esc of escalations) {
      if (!shouldCall(esc, store.items)) continue;
      const key = escKey(esc);
      let item = store.items.find((x) => x.key === key);
      if (!item) {
        item = { id: `H-${String(store.items.length + 1).padStart(3, '0')}`, key, escalation: esc, attempts: 0 };
        store.items.push(item);
      }
      item.attempts += 1;
      item.at = now;
      called += 1;
      changed = true;
      try {
        const out = await ask(buildPrompt({ esc, members, db, works, premise }), { apiKey: env.ANTHROPIC_API_KEY });
        Object.assign(item, {
          status: 'ok', model: out.model || MODEL,
          suggestion: String(out.suggestion || '').trim(),
          assignTo: memberIds.has(out.assignTo) ? out.assignTo : null,
          reason: String(out.reason || '').trim(), error: undefined,
        });
      } catch (e) {
        Object.assign(item, { status: 'failed', error: String(e.message).slice(0, 200) });
        log(`AI 하네스: ${item.id} 호출 실패(${item.attempts}/${MAX_ATTEMPTS}) — 규칙 결과로 계속: ${item.error}`);
      }
    }
    if (changed) writeJson(suggestionsPath(dir), { version: HARNESS_VERSION, items: store.items });
  }
  // 지금도 살아 있는 후보의 성공한 제안만 화면에 보인다(거절된 제안은 숨김)
  const verdicts = loadVerdicts(dir).verdicts;
  const liveKeys = new Set(escalations.map(escKey));
  const active = store.items.filter((x) => x.status === 'ok' && liveKeys.has(x.key) && verdicts[x.id]?.result !== 'reject');
  return { called, changed, active };
}

// 유효한 제안을 관련 플레이어의 '더 중요한 일'에 붙인다
export function applySuggestions(players, active, members) {
  const nameOf = (id) => members.find((m) => m.id === id)?.name || id;
  for (const s of active) {
    const who = s.assignTo ? ` → 담당 제안: ${nameOf(s.assignTo)}님` : '';
    const line = `💡 AI 제안 ${s.id}(관리자 결정 필요): ${s.suggestion}${who}`;
    for (const p of s.escalation.players) if (players[p] && !players[p].important.includes(line)) players[p].important.push(line);
  }
  return players;
}

// ---- 관리자 판정 = 정답 데이터 ----
export function recordVerdict(dir, id, result, by, note = '', now = new Date().toISOString()) {
  const r = { 수락: 'accept', accept: 'accept', 거절: 'reject', reject: 'reject' }[result];
  if (!r) throw new Error('판정은 수락 또는 거절');
  if (!ADMINS.includes(by)) throw new Error('판정은 관리자(창민·민호)만 합니다.');
  if (!loadSuggestions(dir).items.some((x) => x.id === id)) throw new Error(`없는 제안: ${id}`);
  const v = loadVerdicts(dir);
  v.verdicts[id] = { result: r, by, note, at: now };
  writeJson(verdictsPath(dir), v);
  return v.verdicts[id];
}

export function evaluate(dir) {
  const items = loadSuggestions(dir).items;
  const verdicts = loadVerdicts(dir).verdicts;
  const ok = items.filter((x) => x.status === 'ok');
  const judged = ok.filter((x) => verdicts[x.id]);
  const accepted = judged.filter((x) => verdicts[x.id].result === 'accept');
  return {
    version: HARNESS_VERSION, model: MODEL,
    calls: items.reduce((n, x) => n + (x.attempts || 0), 0),
    suggestions: ok.length, failed: items.filter((x) => x.status === 'failed').length,
    judged: judged.length, accepted: accepted.length,
    acceptRate: judged.length ? Math.round((accepted.length / judged.length) * 100) : null,
  };
}

export function run(argv, dir = NOTE_DIR) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'list') {
    const verdicts = loadVerdicts(dir).verdicts;
    const items = loadSuggestions(dir).items;
    if (!items.length) return 'AI 제안이 아직 없습니다(AI 검토 후보가 생기고 ANTHROPIC_API_KEY 가 있을 때 만들어집니다).';
    return items.map((x) => `${x.id} [${x.status}${verdicts[x.id] ? ` · ${verdicts[x.id].result === 'accept' ? '수락' : '거절'}` : ''}] ${x.escalation.reason} · ${x.escalation.target}\n   ${x.suggestion || x.error}`).join('\n');
  }
  if (cmd === 'verdict') {
    const byIdx = rest.indexOf('--by');
    if (byIdx < 0) throw new Error('--by <관리자 이름> 이 필요합니다.');
    const by = requireMember(rest[byIdx + 1], loadMembers(dir)).id;
    const args = rest.filter((_, i) => i !== byIdx && i !== byIdx + 1);
    const v = recordVerdict(dir, args[0], args[1], by, args[2] || '');
    return `판정을 기록했습니다: ${args[0]} ${v.result === 'accept' ? '수락' : '거절'}\n→ git commit·push`;
  }
  if (cmd === 'eval') {
    const e = evaluate(dir);
    return `${e.version} (${e.model})\n호출 ${e.calls}회 · 제안 ${e.suggestions}개 · 실패 ${e.failed}개\n관리자 판정 ${e.judged}개 · 수락 ${e.accepted}개 · 수락률 ${e.acceptRate ?? '-'}%`;
  }
  throw new Error(`모르는 명령: ${cmd}. list | verdict | eval`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(run(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); }
}
