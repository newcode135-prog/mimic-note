// 코어 오브 미믹노트 봇 서버 — 클라우드플레어 워커(24시간, 무료). PC·맥미니가 꺼져 있어도 동작한다.
//
//   POST /telegram         텔레그램 웹훅(WEBHOOK_SECRET 헤더): 버튼(창민봇…)·미션 명령·연결(/start 코드)·연결 링크 만들기
//   POST /relay/send       GitHub Actions(notify.mjs, RELAY_SECRET): 팀원 아이디로 넘긴 메시지를 그 사람 chat id 로 발송
//   POST /relay/verified   Actions 가 "확인한 상태" 커밋을 알림 — 봇은 역할·미션을 이 커밋에서만 읽는다
//   POST /relay/import     설치 스크립트만(IMPORT_SECRET — GitHub 에는 없음): 기존 연결·링크 코드·확인 상태 옮기기
//   GET  /health
//
// KV(바인딩 NOTE): chat:<chat id> → 팀원, member:<팀원> → chat id(사람마다 따로 — 동시에 연결해도 안 섞임),
//   code:<코드>(24시간 일회용 링크), pend:<키>(확인 대기 10분), verified.
// 한계: 미션 앱 버튼(✅ 완료·📨 주기/요청·요청 수락/거절·🔄)과 요청 알림은 아직 bot.mjs 에만 있다 — 여기서는 글 명령·보기만.
// 무료 한도(하루 요청 10만·KV 쓰기 1천·요청당 CPU 10ms)는 5명 팀이면 넉넉하다.
// 비밀값이 없거나 짧으면 모든 보호된 요청을 거절한다(fail closed). 토큰·chat id 는 로그·답장에 쓰지 않는다.
// 한계: RELAY_SECRET 은 GitHub Actions 비밀값이라 저장소 쓰기 권한자는 꺼낼 수 있다(그 사람은 봇 이름으로 팀원에게
//   메시지를 보내거나 확인 상태를 바꿔 알릴 수 있음) — 쓰기 권한은 믿는 사람에게만.
import {
  DB_FILE, MEMBERS_FILE, ADMIN_ROLES, esc, telegramApi, findMember, decide, menuText, menuKeyboard, missionsText, confirmText,
  resolveRefs, validateDb, validateMembers, mutate, boardText, teamText, sentText, ACTIONS, resultText,
} from '../mimic-note/core.mjs';

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
const PENDING_TTL = 600;
const MEMBER_RE = /^[a-z][a-z0-9_]*$/;

// GitHub API — core.mutate 가 쓰는 어댑터. 저장은 확인한 커밋(head) 위에만 커밋을 만들고 main 을 빨리감기로만 옮긴다
// (그사이 누가 main 을 바꿨으면 422 → 처음부터 다시) — 확인 안 된 변경을 이 저장으로 끌어안지 않게.
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
async function verifiedState(env, gh) {
  const sha = await env.NOTE.get('verified');
  if (!sha) throw new Error('GitHub Actions 의 확인 상태를 아직 받지 못했어요');
  const members = (await readAt(gh, MEMBERS_FILE, sha)).members;
  const db = await readAt(gh, DB_FILE, sha);
  if (validateMembers(members).length || validateDb(db, members).length) throw new Error('확인된 데이터가 올바르지 않아요');
  return { members, db };
}

let botUsername = null;

// 웹훅에는 곧바로 200 을 주므로 텔레그램이 같은 업데이트를 다시 보내지 않는다.
async function onUpdate(u, env) {
  const tg = (method, body) => telegramApi(env.TELEGRAM_BOT_TOKEN, method, body, { fetchFn: env.fetch || fetch });
  const send = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const edit = (chatId, messageId, text) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }).catch(() => send(chatId, text));
  const gh = githubApi(env);
  const replyTo = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
  try {
    if (u.callback_query) return await onConfirm(u.callback_query, { env, tg, edit, gh, replyTo });
    const msg = u.message;
    if (!msg?.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return; // 단체방·사진 등은 무시
    const text = msg.text.trim();
    const ownerId = await ownerOf(env, replyTo);

    // 연결 안 된 대화: 연결 코드만 처리하고 나머지는 안내
    if (!ownerId) {
      const code = text.match(/^\/start(?:@\w+)?\s+(\S+)$/)?.[1];
      if (!code) return void (await send(replyTo, menuText(null), { reply_markup: menuKeyboard((await readAt(gh, MEMBERS_FILE, 'main')).members) }));
      const raw = /^[A-Za-z0-9_-]{16}$/.test(code) ? await env.NOTE.get(`code:${code}`) : null;
      if (!raw) return void (await send(replyTo, '연결 링크가 올바르지 않거나 만료됐어요. 관리자에게 새 링크를 요청하세요.'));
      const c = JSON.parse(raw);
      const { members, db } = await verifiedState(env, gh);
      const member = members.find((m) => m.id === c.member);
      if (!member) return void (await send(replyTo, '명부에 없는 팀원의 링크예요. 관리자에게 문의하세요.'));
      const linkedChat = await chatOf(env, member.id);
      const by = members.find((m) => m.id === c.by);
      if (linkedChat && by?.role !== 'owner') { // 이미 연결된 사람을 다른 대화로 옮기는 건 대표관리자가 만든 링크로만
        return void (await send(replyTo, `${esc(member.name)}님은 이미 연결돼 있어요. 다시 연결하려면 대표관리자에게 새 링크를 요청하세요.`));
      }
      await env.NOTE.delete(`code:${code}`);
      const evicted = await linkChat(env, replyTo, member.id);
      if (evicted) await send(evicted, `이 대화의 미믹노트 연결(${esc(member.name)})이 해제됐어요 — 다른 텔레그램 대화로 다시 연결됐습니다. 본인이 한 게 아니면 대표관리자에게 알려 주세요.`).catch(() => {});
      await send(replyTo, `✅ 미믹노트 연결 완료 — ${esc(member.name)}님의 미션 알림이 이 대화로 와요.\n\n${menuText(member)}`, { reply_markup: menuKeyboard(members) });
      await send(replyTo, missionsText(member, db)); // 지금 미션을 바로(Actions 를 부르지 않음)
      return;
    }

    const { members, db } = await verifiedState(env, gh);
    const owner = members.find((m) => m.id === ownerId) || null;
    const chatOwners = new Map([[replyTo, ownerId]]); // 판단에는 보낸 사람 것만 있으면 된다
    // 관리자: "루카스 연결링크" / "/link 루카스" → 그 팀원 일회용 연결 링크(24시간)
    const lk = text.match(/^(?:\/link(?:@\w+)?\s+(\S+)|(\S+?)\s*연결\s*링크)$/);
    if (lk && owner) {
      const target = findMember(lk[1] || lk[2], members);
      if (!target) return void (await send(replyTo, '그 이름의 팀원이 명부에 없어요.'));
      if (!ADMIN_ROLES.has(owner.role)) return void (await send(replyTo, '연결 링크는 관리자만 만들 수 있어요.'));
      if ((await chatOf(env, target.id)) && owner.role !== 'owner') return void (await send(replyTo, `${esc(target.name)}님은 이미 연결돼 있어요. 다시 연결 링크는 대표관리자만 만들 수 있어요.`));
      const code = randomKey(12);
      await env.NOTE.put(`code:${code}`, JSON.stringify({ member: target.id, by: owner.id }), { expirationTtl: 86400 });
      botUsername ||= (await tg('getMe', {})).username;
      return void (await send(replyTo, `🔗 <b>${esc(target.name)}</b>님 연결 링크(24시간·한 번만)\nhttps://t.me/${botUsername}?start=${code}\n\n${esc(target.name)}님에게만 개인 메시지로 보내 주세요.`));
    }
    const d = decide(msg, { members, chatOwners });
    if (d.kind === 'ignore' || d.kind === 'link') return;
    if (d.kind === 'menu' || d.kind === 'unlinked') return void (await send(replyTo, menuText(d.owner || null, members), { reply_markup: menuKeyboard(members) }));
    if (d.kind === 'board') return void (await send(replyTo, boardText(d.owner, d.member, db, members)));
    if (d.kind === 'team') return void (await send(replyTo, teamText(members, db)));
    if (d.kind === 'sent') return void (await send(replyTo, sentText(d.owner, members, db)));
    if (d.kind === 'act-denied') return void (await send(replyTo, d.text));
    if (d.kind === 'act-error') return void (await send(replyTo, esc(d.error)));
    if (d.kind === 'act') {
      let picked = [];
      if (d.action === 'done') {
        try { picked = resolveRefs(db, d.target.id, d.refs); } catch (e) { return void (await send(replyTo, esc(e.message))); }
      }
      const key = randomKey(9);
      await env.NOTE.put(`pend:${key}`, JSON.stringify({ action: d.action, chatId: replyTo, fromId: String(msg.from?.id), ownerId: d.owner.id, targetId: d.target.id, targetName: d.target.name, items: d.items || [], ids: picked.map((x) => x.id) }), { expirationTtl: PENDING_TTL });
      await send(replyTo, confirmText(d, picked), { reply_markup: { inline_keyboard: [[{ text: '✅ 확인', callback_data: `g:${key}` }, { text: '취소', callback_data: `x:${key}` }]] } });
    }
  } catch (e) {
    console.log(`처리 실패: ${e.message}`);
    if (replyTo) await send(replyTo, `지금 처리하지 못했어요(${esc(e.message)}). 잠시 뒤 다시 해 주세요.`).catch(() => {});
  }
}

async function onConfirm(cq, { env, tg, edit, gh, replyTo }) {
  const [act, key] = String(cq.data || '').split(':');
  const raw = key ? await env.NOTE.get(`pend:${key}`) : null;
  const p = raw && JSON.parse(raw);
  if (!p || p.chatId !== replyTo || p.fromId !== String(cq.from?.id)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '이미 처리했거나 만료된 버튼이에요.' }).catch(() => {});
    return;
  }
  await env.NOTE.delete(`pend:${key}`);
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const mid = cq.message.message_id;
  if (act !== 'g') return void (await edit(replyTo, mid, '취소했어요.'));
  await edit(replyTo, mid, '저장 중…'); // 버튼을 없애 두 번 눌리지 않게
  const n = esc(p.targetName);
  try {
    const spec = ACTIONS[p.action];
    if (!spec) return void (await edit(replyTo, mid, '알 수 없는 확인이에요. 다시 보내 주세요.'));
    const w = await mutate(gh, spec.apply(p), (r) => `${p.targetName} ${spec.label}${r.added ? ` ${r.added.length}개` : ''}`, { as: p.ownerId, via: '텔레그램' });
    await edit(replyTo, mid, resultText(p.action, p.targetName, w));
  } catch (e) {
    // 같은 확인을 거의 동시에 두 번 눌러 이미 저장된 경우는 실패로 덮어쓰지 않는다
    if (p.action === 'done') {
      try {
        const latest = JSON.parse((await gh.readFile(DB_FILE, 'main')).text);
        if (p.ids.length && p.ids.every((id) => latest.missions.find((m) => m.id === id)?.status === 'done')) return void (await edit(replyTo, mid, `☑️ ${n}님의 미션은 이미 완료돼 있어요.`));
      } catch { /* 아래 실패 표시 */ }
    }
    await edit(replyTo, mid, `❌ 저장하지 못했어요: ${esc(e.message)}`);
  }
}

// Actions → 팀원 아이디로 발송(chat id 는 워커만 안다). 길이 판단은 텔레그램에 맡긴다.
async function relaySend(body, env) {
  const member = String(body?.member || '');
  const text = String(body?.text || '');
  if (!MEMBER_RE.test(member) || !text || text.length > 20000) return { status: 'failed', error: '잘못된 요청', code: 400 };
  const chatId = await chatOf(env, member);
  if (!chatId) return { status: 'unconnected' };
  try {
    const r = await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, { fetchFn: env.fetch || fetch });
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
      if (update) ctx.waitUntil(onUpdate(update, env)); // 텔레그램에는 바로 200, 처리는 뒤에서
      return new Response('ok');
    }
    const auth = req.headers.get('authorization');
    if (url.pathname === '/relay/send' || url.pathname === '/relay/verified') {
      if (!authed(auth, env.RELAY_SECRET, 'Bearer ')) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => ({}));
      if (url.pathname === '/relay/send') return json(await relaySend(body, env));
      if (!/^[0-9a-f]{40}$/.test(body.sha || '')) return json({ error: 'bad sha' }, 400);
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
      if (/^[0-9a-f]{40}$/.test(body.verified || '') && !(await env.NOTE.get('verified'))) await env.NOTE.put('verified', body.verified);
      return json({ ok: true, linked });
    }
    return new Response('not found', { status: 404 });
  },
};
