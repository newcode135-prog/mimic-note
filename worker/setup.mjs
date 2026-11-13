#!/usr/bin/env node
// 코어 오브 미믹노트 봇 서버(클라우드플레어 워커) 설치 — 저장소 주인이 본인 터미널(PowerShell 등)에서 한 번 실행.
//
//   node worker/setup.mjs                      설치·다시 배포(이미 된 것은 건너뜀)
//   node worker/setup.mjs --new-github-token   워커의 GitHub 토큰을 새로 넣기
//   node worker/setup.mjs --api-token          브라우저 로그인을 건너뛰고 클라우드플레어 API 토큰으로(로그인 창이 안 될 때)
//
// ① 클라우드플레어 로그인(없으면 브라우저가 열림) ② KV 만들기 ③ 배포 ④ 워커 비밀값(텔레그램 토큰·GitHub 토큰·연결 비밀)
// ⑤ GitHub 비밀값 NOTE_RELAY_URL·NOTE_RELAY_SECRET ⑥ 이 컴퓨터의 기존 연결·링크·확인 상태 옮기기 ⑦ 텔레그램 웹훅 연결
// 토큰은 화면·저장소에 남기지 않는다. 필요한 GitHub 토큰: https://github.com/settings/personal-access-tokens/new
//   Repository access: Only select repositories → newcode135-prog/mimic-note
//   Permissions: Contents = Read and write (Metadata 는 자동) — 다른 권한은 필요 없음
//   Expiration: Custom → 1년 뒤(기본 30일이면 그날 봇이 멈춤). 만료 전에 node worker/setup.mjs --new-github-token
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnv, telegramApi, REPO } from '../mimic-note/lib.mjs';
import { setEnvVar, setSecret, askHidden, secretNames } from '../mimic-note/telegram.mjs';
import { createGithub } from '../mimic-note/github.mjs';
import { HOME_DIR } from '../mimic-note/passive/compress.mjs';
import { setCommands } from '../mimic-note/bot.mjs';
import { BOT_NAME } from '../mimic-note/lib.mjs';

const WRANGLER = 'wrangler@4.157.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENV_FILE = path.join(ROOT, '.env');
const TOML = path.join(HERE, 'wrangler.toml');

function wrangler(args, { input, interactive = false, allowFail = false } = {}) {
  const r = spawnSync('npx', ['--yes', WRANGLER, ...args], {
    cwd: HERE,
    shell: process.platform === 'win32',
    input,
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args[0]} ${args[1] || ''} 실패:\n${out.trim().split('\n').slice(-6).join('\n')}`);
  return out;
}
const key = (n) => crypto.randomBytes(n).toString('base64url');

async function main() {
  const args = new Set(process.argv.slice(2));
  let env = readEnv(ROOT, process.env);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('.env 에 TELEGRAM_BOT_TOKEN 이 없습니다. 먼저 node mimic-note/telegram.mjs connect 로 봇 토큰을 넣으세요.');
  const me = await telegramApi(token, 'getMe');
  console.log(`봇: @${me.username}`);

  console.log('① 클라우드플레어 로그인 확인…');
  const loggedIn = () => /You are logged in/i.test(wrangler(['whoami'], { allowFail: true }));
  if (!args.has('--api-token') && !loggedIn()) {
    console.log('   브라우저가 열리면 클라우드플레어에 로그인(무료 가입 가능)하고 [Allow]를 누르세요 — 이 PC 의 브라우저에서, 2분 안에.');
    wrangler(['login'], { interactive: true, allowFail: true });
  }
  if (!loggedIn()) {
    // 브라우저 로그인이 안 되면(시간 초과·다른 기기에서 열림 등) API 토큰으로 — 이번 실행에만 쓰고 저장하지 않는다
    console.log('   브라우저 로그인이 끝나지 않았어요. 대신 클라우드플레어 API 토큰을 넣어도 됩니다:');
    console.log('   https://dash.cloudflare.com/profile/api-tokens → Create Token → "Edit Cloudflare Workers" 템플릿 → 계정 선택 → Create');
    process.env.CLOUDFLARE_API_TOKEN = await askHidden('   클라우드플레어 API 토큰(화면에 표시되지 않음): ');
    if (!loggedIn()) throw new Error('클라우드플레어 API 토큰으로도 로그인하지 못했습니다. 토큰 권한(Edit Cloudflare Workers)과 계정을 확인하세요.');
  }
  console.log('   로그인됨');

  let toml = fs.readFileSync(TOML, 'utf8');
  if (toml.includes('REPLACE_WITH_KV_ID')) {
    console.log('② KV 저장소 만들기…');
    const id = wrangler(['kv', 'namespace', 'create', 'NOTE']).match(/\b([0-9a-f]{32})\b/)?.[1];
    if (!id) throw new Error('KV id 를 찾지 못했습니다(wrangler 출력 형식 확인).');
    toml = toml.replace('REPLACE_WITH_KV_ID', id);
    fs.writeFileSync(TOML, toml);
    console.log('   만들었습니다(worker/wrangler.toml 에 기록 — 비밀값 아님, 커밋해도 됨)');
  } else console.log('② KV 저장소: 있음');

  console.log('③ 배포…');
  const deployed = wrangler(['deploy'], { allowFail: true });
  const url = deployed.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  if (!url) {
    throw new Error(`배포 주소를 찾지 못했습니다. 처음이면 클라우드플레어 대시보드 → Workers & Pages 에서 workers.dev 하위 도메인을 한 번 정한 뒤 다시 실행하세요.\n${deployed.trim().split('\n').slice(-6).join('\n')}`);
  }
  console.log(`   ${url}`);

  console.log('④ 워커 비밀값…');
  const have = new Set([...wrangler(['secret', 'list'], { allowFail: true }).matchAll(/"name":\s*"([A-Z_]+)"/g)].map((m) => m[1]));
  if (!env.NOTE_RELAY_SECRET) setEnvVar(ENV_FILE, 'NOTE_RELAY_SECRET', key(32));
  if (!env.NOTE_WEBHOOK_SECRET) setEnvVar(ENV_FILE, 'NOTE_WEBHOOK_SECRET', key(32));
  if (!env.NOTE_IMPORT_SECRET) setEnvVar(ENV_FILE, 'NOTE_IMPORT_SECRET', key(32)); // 이 컴퓨터와 워커에만(GitHub 에는 안 올림)
  env = readEnv(ROOT, process.env);
  wrangler(['secret', 'put', 'TELEGRAM_BOT_TOKEN'], { input: token });
  wrangler(['secret', 'put', 'RELAY_SECRET'], { input: env.NOTE_RELAY_SECRET });
  wrangler(['secret', 'put', 'WEBHOOK_SECRET'], { input: env.NOTE_WEBHOOK_SECRET });
  wrangler(['secret', 'put', 'IMPORT_SECRET'], { input: env.NOTE_IMPORT_SECRET });
  if (!have.has('GITHUB_TOKEN') || args.has('--new-github-token')) {
    console.log('   GitHub 토큰이 필요합니다(맨 위 주석의 권한으로 만든 fine-grained 토큰, 화면에 표시되지 않음).');
    const ghToken = process.env.MIMIC_GITHUB_TOKEN || await askHidden('   GitHub 토큰: ');
    const h = { authorization: `Bearer ${ghToken}`, 'user-agent': 'mimic-note-setup', accept: 'application/vnd.github+json' };
    const check = await fetch(`https://api.github.com/repos/${REPO}/contents/mimic-note/data/members.json`, { headers: h });
    if (!check.ok) throw new Error(`GitHub 토큰으로 ${REPO} 를 읽지 못했습니다(${check.status}). 저장소 선택·권한을 확인하세요.`);
    const exp = check.headers.get('github-authentication-token-expiration');
    const days = exp ? Math.floor((Date.parse(exp.replace(' UTC', 'Z').replace(' ', 'T')) - Date.now()) / 86400e3) : null;
    console.log(`   GitHub 토큰 만료: ${exp || '없음(만료 없음)'}${days != null ? ` — ${days}일 남음` : ''}`);
    if (days != null && days < 60) console.log('   ⚠️ 곧 만료돼요. 만료되면 봇이 멈춥니다 — Expiration 을 1년으로 다시 만들어 node worker/setup.mjs --new-github-token 를 권합니다.');
    // 쓰기 권한 확인: 아무 데도 연결되지 않는 작은 blob 하나를 만들어 본다(브랜치·파일은 바뀌지 않음)
    const write = await fetch(`https://api.github.com/repos/${REPO}/git/blobs`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'mimic-note write check', encoding: 'utf-8' }) });
    if (!write.ok) throw new Error(`GitHub 토큰에 쓰기 권한이 없습니다(${write.status}). Contents 를 Read and write 로 바꿔 다시 만드세요.`);
    wrangler(['secret', 'put', 'GITHUB_TOKEN'], { input: ghToken });
  }
  console.log('   등록했습니다(텔레그램 토큰·GitHub 토큰·연결 비밀)');

  console.log('⑤ GitHub 비밀값(Actions → 봇 서버)…');
  setEnvVar(ENV_FILE, 'NOTE_RELAY_URL', url); // 이 컴퓨터의 telegram.mjs connect 가 봇 서버 모드임을 알게(링크는 봇에서)
  const okUrl = setSecret('NOTE_RELAY_URL', url);
  const okSec = setSecret('NOTE_RELAY_SECRET', env.NOTE_RELAY_SECRET);
  console.log(okUrl && okSec ? '   등록했습니다' : '   일부 실패 — 위 안내대로 GitHub Settings → Secrets 에서 직접 등록하세요');

  console.log('⑥ 기존 연결·링크·확인 상태 옮기기…');
  const owners = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^TELEGRAM_CHAT_ID_([A-Z0-9_]+)$/);
    if (m && v) owners[String(v)] = m[1].toLowerCase();
  }
  const codes = [];
  try {
    const all = JSON.parse(fs.readFileSync(path.join(HOME_DIR(), 'telegram-codes.json'), 'utf8')).codes || {};
    for (const [code, c] of Object.entries(all)) {
      const ttl = (Date.parse(c.expiresAt) - Date.now()) / 1000;
      if (!c.usedAt && ttl >= 60) codes.push({ code, member: c.member, ttl });
    }
  } catch { /* 링크 없음 */ }
  let verified = null;
  try { verified = createGithub().verifiedSha(); } catch { /* 다음 알림 실행 때 들어감 */ }
  const imp = await fetch(`${url}/relay/import`, { method: 'POST', headers: { authorization: `Bearer ${env.NOTE_IMPORT_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ owners, codes, verified }) });
  const impJ = await imp.json().catch(() => ({}));
  if (!imp.ok) throw new Error(`봇 서버에 옮기지 못했습니다(${imp.status}) — 비밀값이 막 등록돼 반영 중일 수 있으니 1분 뒤 다시 실행하세요.`);
  console.log(`   연결 ${(impJ.linked || []).join(', ') || '없음'}(이미 서버에 연결된 사람은 그대로) · 링크 ${codes.length}개 · 확인 상태 ${verified ? verified.slice(0, 7) : '다음 알림 때'}`);
  const onGithub = [...(secretNames() || [])].map((n) => n.match(/^TELEGRAM_CHAT_ID_([A-Z0-9_]+)$/)?.[1]?.toLowerCase()).filter(Boolean);
  const missing = onGithub.filter((m) => !Object.values(owners).includes(m));
  if (missing.length) console.log(`   ⚠️ 다른 컴퓨터에서 연결한 사람(${missing.join(', ')})은 옮기지 못했어요 — 알림은 계속 가지만 버튼을 쓰려면 관리자가 봇에 "<이름> 연결링크"로 다시 연결하세요.`);

  console.log('⑦ 텔레그램 웹훅 연결·봇 이름·명령어 메뉴…');
  try { if ((await telegramApi(token, 'getMyName')).name !== BOT_NAME) await telegramApi(token, 'setMyName', { name: BOT_NAME }); } catch { /* 다음에 */ }
  await setCommands(token);
  await telegramApi(token, 'setWebhook', { url: `${url}/telegram`, secret_token: env.NOTE_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
  const info = await telegramApi(token, 'getWebhookInfo');
  const health = await fetch(`${url}/health`).then((r) => r.text()).catch(() => '');
  console.log(`   웹훅: ${info.url === `${url}/telegram` ? '연결됨' : '확인 필요'} · 서버 상태: ${health === 'ok' ? '정상' : '확인 필요'}${info.last_error_message ? ` · 최근 오류: ${info.last_error_message}` : ''}`);

  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(HOME_DIR(), 'core-bot.lock'), 'utf8'));
    process.kill(pid, 0);
    console.log('\n⚠️ 이 컴퓨터의 bot.mjs 가 아직 켜져 있습니다. 이제 봇 서버가 대신하니 그 창에서 Ctrl+C 로 끄세요.');
  } catch { /* 꺼져 있음 */ }
  console.log('\n맥미니 등 다른 컴퓨터에 bot.mjs 상시 실행을 설치했다면 그곳에서 bash mimic-note/bot-install-macmini.sh --remove 로 지우세요(같은 봇은 한 곳에서만).');
  console.log(`끝났습니다. 이제 PC 가 꺼져 있어도 텔레그램 @${me.username} 이 24시간 답합니다.`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
