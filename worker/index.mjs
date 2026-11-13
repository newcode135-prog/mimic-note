// 코어 오브 미믹노트 봇 서버 — 클라우드플레어 워커(24시간, 무료). PC·맥미니가 꺼져 있어도 동작한다.
// 처리 내용(이름봇·✅ 완료·📨 주기/요청·수락/거절·팀 현황·보낸 미션·🌐 언어·글 명령)은 PC 봇과 똑같이 mimic-note/app.mjs 를 쓴다.
//
//   POST /telegram         텔레그램 웹훅(WEBHOOK_SECRET 헤더) → app.handleUpdate. 관리자 "루카스 연결링크"(일회용 링크)도
//   POST /relay/send       GitHub Actions(notify.mjs, RELAY_SECRET): 팀원 아이디로 넘긴 메시지(+✅ 버튼)를 그 사람 chat id 로 발송
//   POST /relay/verified   Actions 가 "확인한 상태" 커밋을 알림 — 봇은 역할·미션을 이 커밋(+봇이 만든 커밋)에서만 읽는다
//   POST /relay/import     설치 스크립트만(IMPORT_SECRET — GitHub 에는 없음): 기존 연결·링크 코드·확인 상태 옮기기
//   GET  /health
//
// KV(바인딩 NOTE): chat:<chat id> → 팀원, member:<팀원> → chat id(사람마다 따로 — 동시에 연결해도 안 섞임),
//   code:<코드>(24시간 일회용 링크), verified, trusted(봇이 만든 커밋 → 부모), app:pend:·app:compose:·app:busy:(10분 이하 임시).
// 무료 한도(하루 요청 10만·KV 쓰기 1천·요청당 CPU 10ms)는 6명 팀이면 넉넉하다.
// 비밀값이 없거나 짧으면 모든 보호된 요청을 거절한다(fail closed). 토큰·chat id 는 로그·답장에 쓰지 않는다.
// 한계: RELAY_SECRET 은 GitHub Actions 비밀값이라 저장소 쓰기 권한자는 꺼낼 수 있다(그 사람은 봇 이름으로 팀원에게
//   메시지를 보내거나 확인 상태를 바꿔 알릴 수 있음) — 쓰기 권한은 믿는 사람에게만.
import {
  DB_FILE, MEMBERS_FILE, esc, telegramApi, validateDb, validateMembers, mutate, safeHead, changesData, dn, tr, renderTelegram,
} from '../mimic-note/core.mjs';
import { handleUpdate, linkAllowed } from '../mimic-note/app.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64decode = (s) => dec.decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function b64encode(text) {
  const bytes = enc.encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// 비밀값 비교: 비밀값이 없거나 32자 미만이면 무조건 거절
const authed = (got, secret, prefix = '') => {
  if (typeof secret !== 'string' || secret.length < 32 || typeof got !== 'string') return false;
  const want = `${prefix}${secret}`;
  if (got.length !== want.length) return false;
  let r = 0;
  for (let i = 0; i < want.length; i++) r |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return r === 0;
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const randomKey = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const MEMBER_RE = /^[a-z][a-z0-9_]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// GitHub API — core.mutate·safeHead 가 쓰는 어댑터. 저장은 확인한 커밋(head) 위에만 커밋을 만들고 main 을 빨리감기로만 옮긴다
// (그사이 누가 main 을 바꿨으면 422 → 처음부터 다시) — 확인 안 된 변경을 이 저장으로 끌어안지 않게.
const touched = new Map(); // 커밋이 데이터를 바꿨는지(커밋 내용은 안 바뀜)
export function githubApi(env) {
  const repo = env.REPO;
  const doFetch = env.fetch || fetch;
  const call = async (method, path, body) => {
    const res = await doFetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'mimic-note-bot', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status} ${j.message || ''}`.trim()), { status: res.status, ghMessage: j.message || '' });
    return j;
  };
  return {
    whoami: async () => (await call('GET', '/user')).login,
    access: async () => (await call('GET', `/repos/${repo}`)).permissions || {},
    headSha: async () => (await call('GET', `/repos/${repo}/git/ref/heads/main`)).object.sha,
    readFile: async (file, ref = 'main') => {
      const j = await call('GET', `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`);
      return { text: b64decode(j.content), sha: j.sha };
    },
    async commitFile(parent, file, text, message) {
      const blob = await call('POST', `/repos/${repo}/git/blobs`, { content: b64encode(text), encoding: 'base64' });
      const base = await call('GET', `/repos/${repo}/git/commits/${parent}`);
      const tree = await call('POST', `/repos/${repo}/git/trees`, { base_tree: base.tree.sha, tree: [{ path: file, mode: '100644', type: 'blob', sha: blob.sha }] });
      const commit = await call('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] });
      try {
        await call('PATCH', `/repos/${repo}/git/refs/heads/main`, { sha: commit.sha, force: false });
      } catch (e) {
        if (e.status === 422) return { conflict: true };
        throw e;
      }
      return { commit: commit.sha, url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha}` };
    },
    verifiedSha: async () => env.NOTE.get('verified'),
    // base 에서 head 까지 main 의 첫 부모 사슬(head → base 쪽, base 는 빼고). head 가 base 의 후손이 아니면 null (github.mjs 와 같음)
    async chain(base, head) {
      const r = await call('GET', `/repos/${repo}/compare/${base}...${head}`);
      if (!['ahead', 'identical'].includes(r.status)) return null;
      const parent = new Map((r.commits || []).map((c) => [c.sha, c.parents?.[0]?.sha]));
      const out = [];
      for (let c = head; c !== base; c = parent.get(c)) {
        if (!parent.has(c) || out.length > 250) return null;
        out.push(c);
      }
      return out;
    },
    async touchesData(sha) {
      if (!touched.has(sha)) {
        if (touched.size > 500) touched.clear();
        touched.set(sha, changesData((await call('GET', `/repos/${repo}/commits/${sha}`)).files));
      }
      return touched.get(sha);
    },
  };
}

const ownerOf = (env, chatId) => env.NOTE.get(`chat:${chatId}`);
const chatOf = (env, member) => env.NOTE.get(`member:${member}`);
async function linkChat(env, chatId, member) {
  const old = await chatOf(env, member);
  if (old && old !== chatId) await env.NOTE.delete(`chat:${old}`);
  await env.NOTE.put(`chat:${chatId}`, member);
  await env.NOTE.put(`member:${member}`, chatId);
  return old && old !== chatId ? old : null;
}

// 봇이 만든 커밋 → 부모(최근 500개) — 확인 전에도 이어서 저장·표시(core.safeHead)
async function loadTrusted(env) {
  try { return new Map(JSON.parse((await env.NOTE.get('trusted')) || '[]').filter((x) => SHA_RE.test(x?.[0]) && SHA_RE.test(x?.[1]))); } catch { return new Map(); }
}

// 커밋 내용은 바뀌지 않으니 커밋별로 기억(같은 워커 인스턴스 안에서), main 은 1분
const memo = new Map();
async function readAt(gh, file, ref) {
  const k = `${file}@${ref}`;
  const hit = memo.get(k);
  if (hit && (ref !== 'main' || Date.now() - hit.at < 60e3)) return hit.v;
  const v = JSON.parse((await gh.readFile(file, ref)).text);
  memo.set(k, { v, at: Date.now() });
  if (memo.size > 50) memo.delete(memo.keys().next().value);
  return v;
}

const langCache = new Map(); // 팀원별 마지막으로 본 언어(같은 인스턴스 안에서만, GitHub 를 읽기 전 문구용)
let botUsername = null;

// 웹훅 처리에 쓰는 ctx(app.mjs 참고)
export function workerCtx(env) {
  const gh = githubApi(env);
  const tg = (method, body) => telegramApi(env.TELEGRAM_BOT_TOKEN, method, body, { fetchFn: env.fetch || fetch });
  let trusted = null;
  const getTrusted = async () => (trusted ||= await loadTrusted(env));
  const verifiedState = async () => {
    const v = await env.NOTE.get('verified');
    if (!v) throw new Error('GitHub Actions 의 확인 상태를 아직 받지 못했어요');
    let sha = v;
    const t = await getTrusted();
    if (t.size) {
      try {
        const h = await gh.headSha();
        if (h !== v && await safeHead(gh, h, v, t)) sha = h;
      } catch { /* 확인된 상태로 */ }
    }
    const members = (await readAt(gh, MEMBERS_FILE, sha)).members;
    const db = await readAt(gh, DB_FILE, sha);
    if (validateMembers(members).length || validateDb(db, members).length) throw new Error('확인된 데이터가 올바르지 않아요');
    for (const m of members) langCache.set(m.id, db.langs?.[m.id] || 'ko');
    return { members, db };
  };
  const kvKey = (k) => `app:${k}`;
  return {
    tg,
    ownerOf: (chatId) => ownerOf(env, chatId),
    chatOf: (memberId) => chatOf(env, memberId),
    async linked() {
      const keys = env.NOTE.list ? (await env.NOTE.list({ prefix: 'member:' })).keys : [];
      return new Set(keys.map((k) => k.name.slice('member:'.length)));
    },
    langHint: async (memberId) => langCache.get(memberId) || null,
    state: verifiedState,
    async save(apply, describe, as) {
      const t = await getTrusted();
      const w = await mutate(gh, apply, describe, { as, via: '텔레그램', trusted: t });
      if (w.commit) {
        const fresh = await loadTrusted(env); // 다른 요청이 그사이 넣은 것도 살리기
        for (const [c, p] of t) if (!fresh.has(c)) fresh.set(c, p);
        fresh.set(w.commit, w.parent);
        while (fresh.size > 500) fresh.delete(fresh.keys().next().value);
        trusted = fresh;
        await env.NOTE.put('trusted', JSON.stringify([...fresh]));
      }
      return w;
    },
    kv: {
      get: async (k) => { const raw = await env.NOTE.get(kvKey(k)); try { return raw == null ? null : JSON.parse(raw); } catch { return null; } },
      put: (k, value, ttl) => env.NOTE.put(kvKey(k), JSON.stringify(value), { expirationTtl: Math.max(60, Math.floor(ttl)) }),
      del: (k) => env.NOTE.delete(kvKey(k)),
    },
    async unlinkedMembers() {
      const v = await env.NOTE.get('verified');
      return (await readAt(gh, MEMBERS_FILE, v || 'main')).members;
    },
    // 연결 안 된 대화의 /start <코드>: 코드는 KV(24시간·한 번만), 이미 연결된 사람을 옮기는 건 대표관리자가 만든 링크로만
    async link(u, lang) {
      const replyTo = String(u.message.chat.id);
      const code = u.message.text.trim().match(/^\/start(?:@\w+)?\s+(\S+)$/)?.[1];
      const raw = code && /^[A-Za-z0-9_-]{16}$/.test(code) ? await env.NOTE.get(`code:${code}`) : null;
      if (!raw) return { key: 'linkExpired' };
      const c = JSON.parse(raw);
      const { members, db } = await verifiedState();
      const member = members.find((m) => m.id === c.member);
      if (!member) return { text: '명부에 없는 팀원의 링크예요. 관리자에게 문의하세요.' };
      const by = members.find((m) => m.id === c.by);
      if ((await chatOf(env, member.id)) && by?.role !== 'owner') return { text: `${member.name}님은 이미 연결돼 있어요. 다시 연결하려면 대표관리자에게 새 링크를 요청하세요.` };
      await env.NOTE.delete(`code:${code}`);
      const evicted = await linkChat(env, replyTo, member.id);
      if (evicted) await tg('sendMessage', { chat_id: evicted, text: `이 대화의 미믹노트 연결(${esc(member.name)})이 해제됐어요 — 다른 텔레그램 대화로 다시 연결됐습니다. 본인이 한 게 아니면 대표관리자에게 알려 주세요.`, parse_mode: 'HTML' }).catch(() => {});
      await tg('sendMessage', { chat_id: replyTo, text: esc(tr(lang).linked(dn(member, lang))), parse_mode: 'HTML' });
      await tg('sendMessage', { chat_id: replyTo, text: renderTelegram(member, db, { lang }), parse_mode: 'HTML' }); // 지금 미션을 바로(Actions 를 부르지 않음)
      return { member, members };
    },
    // 관리자 "루카스 연결링크" → 그 팀원 일회용 연결 링크(24시간)
    async makeLink(owner, target) {
      const why = linkAllowed(owner, target, target && await chatOf(env, target.id));
      if (why === 'noMember') return '그 이름의 팀원이 명부에 없어요.';
      if (why === 'adminOnly') return '연결 링크는 관리자만 만들 수 있어요.';
      if (why === 'ownerOnly') return `${esc(target.name)}님은 이미 연결돼 있어요. 다시 연결 링크는 대표관리자만 만들 수 있어요.`;
      const code = randomKey(12);
      await env.NOTE.put(`code:${code}`, JSON.stringify({ member: target.id, by: owner.id }), { expirationTtl: 86400 });
      botUsername ||= (await tg('getMe', {})).username;
      return `🔗 <b>${esc(target.name)}</b>님 연결 링크(24시간·한 번만)\nhttps://t.me/${botUsername}?start=${code}\n\n${esc(target.name)}님에게만 개인 메시지로 보내 주세요.`;
    },
    latestDb: async () => JSON.parse((await gh.readFile(DB_FILE, 'main')).text),
    randomKey: () => randomKey(9),
    log: (line) => console.log(line),
  };
}

// Actions 가 붙여 보내는 버튼은 미션 앱 버튼(✅ 완료·🔄 새로고침)만 받는다
const okMarkup = (m) => m && Array.isArray(m.inline_keyboard) && m.inline_keyboard.length <= 20
  && m.inline_keyboard.every((row) => Array.isArray(row) && row.length <= 8 && row.every((b) => b && typeof b.text === 'string' && b.text.length <= 64 && /^[cv]:[\w-]{1,40}$/.test(b.callback_data || '') && Object.keys(b).length === 2));

// Actions → 팀원 아이디로 발송(chat id 는 워커만 안다). 길이 판단은 텔레그램에 맡긴다.
async function relaySend(body, env) {
  const member = String(body?.member || '');
  const text = String(body?.text || '');
  if (!MEMBER_RE.test(member) || !text || text.length > 20000) return { status: 'failed', error: '잘못된 요청', code: 400 };
  if (body.reply_markup != null && !okMarkup(body.reply_markup)) return { status: 'failed', error: '잘못된 버튼', code: 400 };
  const chatId = await chatOf(env, member);
  if (!chatId) return { status: 'unconnected' };
  try {
    const r = await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}) }, { fetchFn: env.fetch || fetch });
    if (!r?.message_id || String(r.chat?.id) !== String(chatId)) return { status: 'failed', error: 'sendMessage 응답이 올바르지 않음' };
    return { status: 'sent', messageId: r.message_id };
  } catch (e) {
    return { status: 'failed', error: String(e.message).slice(0, 200), code: e.code ?? null };
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return new Response('ok');
    if (req.method !== 'POST') return new Response('not found', { status: 404 });
    if (url.pathname === '/telegram') {
      if (!authed(req.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
      const update = await req.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, workerCtx(env))); // 텔레그램에는 바로 200, 처리는 뒤에서
      return new Response('ok');
    }
    const auth = req.headers.get('authorization');
    if (url.pathname === '/relay/send' || url.pathname === '/relay/verified') {
      if (!authed(auth, env.RELAY_SECRET, 'Bearer ')) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => ({}));
      if (url.pathname === '/relay/send') return json(await relaySend(body, env));
      if (!SHA_RE.test(body.sha || '')) return json({ error: 'bad sha' }, 400);
      if ((await env.NOTE.get('verified')) !== body.sha) await env.NOTE.put('verified', body.sha); // 10분마다 오므로 바뀔 때만 씀
      return json({ ok: true });
    }
    if (url.pathname === '/relay/import') { // 설치 스크립트만: 이미 연결된 사람은 건드리지 않는다
      if (!authed(auth, env.IMPORT_SECRET, 'Bearer ')) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => ({}));
      const linked = [];
      for (const [chat, member] of Object.entries(body.owners || {})) {
        if (!/^-?\d+$/.test(chat) || !MEMBER_RE.test(member)) continue;
        if (!(await chatOf(env, member)) && !(await ownerOf(env, chat))) await linkChat(env, chat, member);
        linked.push(member);
      }
      for (const c of body.codes || []) {
        if (/^[A-Za-z0-9_-]{16}$/.test(c.code) && MEMBER_RE.test(c.member) && c.ttl >= 60 && !(await chatOf(env, c.member))) {
          await env.NOTE.put(`code:${c.code}`, JSON.stringify({ member: c.member, by: 'setup' }), { expirationTtl: Math.floor(c.ttl) });
        }
      }
      if (SHA_RE.test(body.verified || '') && !(await env.NOTE.get('verified'))) await env.NOTE.put('verified', body.verified);
      return json({ ok: true, linked });
    }
    return new Response('not found', { status: 404 });
  },
};
