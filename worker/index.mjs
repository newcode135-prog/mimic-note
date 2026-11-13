// 코어 오브 미믹노트 봇 서버 — 클라우드플레어 워커(24시간, 무료). PC·맥미니가 꺼져 있어도 동작한다.
//
//   POST /telegram         텔레그램 웹훅(비밀 헤더 확인): 버튼(창민봇…)·미션 명령·연결(/start 코드)·연결 링크 만들기
//   POST /relay/send       GitHub Actions(notify.mjs)가 보낼 메시지를 팀원 아이디로 넘기면 그 사람 chat id 로 발송
//   POST /relay/verified   Actions 가 "확인한 상태" 커밋을 알림 — 봇은 역할·미션을 이 커밋에서만 읽는다
//   POST /relay/import     설치 스크립트가 기존 연결·링크 코드·확인 상태를 한 번 옮길 때
//   GET  /health
//
// 저장소(KV, 바인딩 NOTE): owners(chat id → 팀원), code:<코드>(24시간), pend:<키>(확인 대기 10분), verified.
// 무료 한도(하루 요청 10만·KV 쓰기 1천·요청당 CPU 10ms)는 5명 팀이면 넉넉하다.
// 비밀값(wrangler secret): TELEGRAM_BOT_TOKEN, GITHUB_TOKEN(mimic-note 저장소 Contents·Actions 읽기/쓰기), RELAY_SECRET, WEBHOOK_SECRET.
// 미션 데이터는 GitHub 에만 있다. 토큰·chat id 는 로그·답장에 쓰지 않는다.
import {
  DB_FILE, MEMBERS_FILE, ADMIN_ROLES, esc, telegramApi, findMember, decide, menuText, menuKeyboard, missionsText, confirmText,
  resolveRefs, addMissions, setMissions, completeMissions, validateDb, validateMembers, mutate,
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
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const randomKey = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PENDING_TTL = 600;

// GitHub API — mission.mjs 의 gh 어댑터와 같은 모양(비동기). core.mutate 가 그대로 쓴다.
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
    readFile: async (file, ref = 'main') => {
      const j = await call('GET', `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`);
      return { text: b64decode(j.content), sha: j.sha };
    },
    writeFile: async (file, text, sha, message) => {
      try {
        const j = await call('PUT', `/repos/${repo}/contents/${file}`, { message, content: b64encode(text), sha, branch: 'main' });
        return { commit: j.commit.sha, url: j.commit.html_url };
      } catch (e) {
        if (e.status === 409 && /does not match|but expected/i.test(e.ghMessage || e.message)) return { conflict: true };
        throw e;
      }
    },
    verifiedSha: async () => env.NOTE.get('verified'),
    dispatch: (member) => call('POST', `/repos/${repo}/actions/workflows/mimic-checkin.yml/dispatches`, { ref: 'main', inputs: { member, force: 'false' } }),
  };
}

const loadOwners = async (env) => JSON.parse((await env.NOTE.get('owners')) || '{}');

// 커밋 내용은 바뀌지 않으니 커밋별로 기억(같은 워커 인스턴스 안에서)
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

// 웹훅에는 곧바로 200 을 주므로 텔레그램이 같은 업데이트를 다시 보내지 않는다(KV 무료 쓰기 하루 1,000번 아낌).
async function onUpdate(u, env) {
  const tg = (method, body) => telegramApi(env.TELEGRAM_BOT_TOKEN, method, body, { fetchFn: env.fetch || fetch });
  const send = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const edit = (chatId, messageId, text) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }).catch(() => send(chatId, text));
  const gh = githubApi(env);
  const owners = await loadOwners(env);
  const chatOwners = new Map(Object.entries(owners));
  const replyTo = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
  try {
    if (u.callback_query) return await onConfirm(u.callback_query, { env, tg, edit, gh, replyTo });
    const msg = u.message;
    if (!msg?.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return; // 단체방·사진 등은 무시
    const text = msg.text.trim();

    // 연결 안 된 대화: 연결 코드만 처리하고 나머지는 안내
    if (!chatOwners.has(replyTo)) {
      const members = (await readAt(gh, MEMBERS_FILE, 'main')).members;
      const code = text.match(/^\/start(?:@\w+)?\s+(\S+)$/)?.[1];
      if (!code) return void (await send(replyTo, menuText(null), { reply_markup: menuKeyboard(members) }));
      const raw = /^[A-Za-z0-9_-]{16}$/.test(code) ? await env.NOTE.get(`code:${code}`) : null;
      if (!raw) return void (await send(replyTo, '연결 링크가 올바르지 않거나 만료됐어요. 관리자에게 새 링크를 요청하세요.'));
      const member = members.find((m) => m.id === JSON.parse(raw).member);
      if (!member) return void (await send(replyTo, '명부에 없는 팀원의 링크예요. 관리자에게 문의하세요.'));
      for (const [c, m] of Object.entries(owners)) if (m === member.id) delete owners[c]; // 다시 연결하면 새 대화로 바꿈
      owners[replyTo] = member.id;
      await env.NOTE.put('owners', JSON.stringify(owners));
      await env.NOTE.delete(`code:${code}`);
      await send(replyTo, `✅ 미믹노트 연결 완료 — ${esc(member.name)}님의 미션 알림이 이 대화로 와요.\n\n${menuText(member)}`, { reply_markup: menuKeyboard(members) });
      try { await gh.dispatch(member.id); } catch (e) { console.log(`연결 후 미션 발송 요청 실패: ${e.message}`); }
      return;
    }

    const { members, db } = await verifiedState(env, gh);
    const owner = members.find((m) => m.id === chatOwners.get(replyTo)) || null;
    // 관리자: "루카스 연결링크" / "/link 루카스" → 그 팀원 일회용 연결 링크(24시간)
    const lk = text.match(/^(?:\/link(?:@\w+)?\s+(\S+)|(\S+?)\s*연결\s*링크)$/);
    if (lk && owner) {
      const target = findMember(lk[1] || lk[2], members);
      if (!target) return void (await send(replyTo, '그 이름의 팀원이 명부에 없어요.'));
      if (!ADMIN_ROLES.has(owner.role)) return void (await send(replyTo, '연결 링크는 관리자만 만들 수 있어요.'));
      const code = randomKey(12);
      await env.NOTE.put(`code:${code}`, JSON.stringify({ member: target.id, by: owner.id }), { expirationTtl: 86400 });
      botUsername ||= (await tg('getMe', {})).username;
      return void (await send(replyTo, `🔗 <b>${esc(target.name)}</b>님 연결 링크(24시간·한 번만)\nhttps://t.me/${botUsername}?start=${code}\n\n${esc(target.name)}님에게만 개인 메시지로 보내 주세요.`));
    }
    const d = decide(msg, { members, chatOwners });
    if (d.kind === 'ignore' || d.kind === 'link') return;
    if (d.kind === 'menu' || d.kind === 'unlinked') return void (await send(replyTo, menuText(d.owner || null), { reply_markup: menuKeyboard(members) }));
    if (d.kind === 'deny') return void (await send(replyTo, `${esc(d.target.name)}봇은 ${esc(d.target.name)}님만 쓸 수 있어요. 본인 버튼(<b>${esc(d.owner.name)}봇</b>)을 누르세요.`));
    if (d.kind === 'missions') return void (await send(replyTo, missionsText(d.member, db)));
    if (d.kind === 'act-denied') {
      return void (await send(replyTo, d.action === 'done' ? '다른 사람의 미션 완료는 관리자만 할 수 있어요. 본인 미션만 완료하세요.' : `미션 주기·바꾸기는 관리자(${members.filter((m) => ADMIN_ROLES.has(m.role)).map((m) => esc(m.name)).join('·')})만 할 수 있어요.`));
    }
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
    const apply = {
      add: (db, ms, actor) => addMissions(db, p.targetId, p.items, actor.id, ms),
      set: (db, ms, actor) => setMissions(db, p.targetId, p.items, actor.id, ms),
      done: (db, ms, actor) => ({ done: completeMissions(db, p.targetId, p.ids, { by: actor.id, members: ms }), changed: true }),
    }[p.action];
    const label = { add: '미션추가', set: '미션설정', done: '미션완료' }[p.action];
    const w = await mutate(gh, apply, (r) => `${p.targetName} ${label}${r.added ? ` ${r.added.length}개` : ''}`, { as: p.ownerId, via: '텔레그램' });
    const r = w.result;
    const out = w.unchanged ? [`변경 없음 — ${n}님에게 이미 그대로 있어요.`]
      : p.action === 'done' ? [`☑️ ${n}님의 미션을 완료했어요`, ...r.done.map((m) => `• [${m.id}] ${esc(m.title)}`)]
        : p.action === 'set' ? [`♻️ ${n}님의 미션을 바꿨어요 — 새 ${r.added.length} · 유지 ${r.kept.length} · 보관 ${r.replaced.length}`]
          : [`✅ ${n}님에게 미션을 줬어요`, ...r.added.map((m) => `• [${m.id}] ${esc(m.title)}`), ...(r.skipped.length ? [`(이미 있어서 건너뜀: ${r.skipped.map(esc).join(', ')})`] : [])];
    if (!w.unchanged) out.push('', `${n}님에게 곧 텔레그램 알림이 가요.`);
    await edit(replyTo, mid, out.join('\n'));
  } catch (e) {
    await edit(replyTo, mid, `❌ 저장하지 못했어요: ${esc(e.message)}`);
  }
}

// Actions → 팀원 아이디로 발송(chat id 는 워커만 안다)
async function relaySend(body, env) {
  const member = String(body?.member || '');
  const text = String(body?.text || '');
  if (!/^[a-z][a-z0-9_]*$/.test(member) || !text || text.length > 4096) return { status: 'failed', error: '잘못된 요청', code: 400 };
  const chatId = Object.entries(await loadOwners(env)).find(([, m]) => m === member)?.[0];
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
      if (!safeEq(req.headers.get('x-telegram-bot-api-secret-token') || '', env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
      const update = await req.json().catch(() => null);
      if (update) ctx.waitUntil(onUpdate(update, env)); // 텔레그램에는 바로 200, 처리는 뒤에서
      return new Response('ok');
    }
    if (url.pathname.startsWith('/relay/')) {
      if (!safeEq(req.headers.get('authorization') || '', `Bearer ${env.RELAY_SECRET}`)) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => ({}));
      if (url.pathname === '/relay/send') return json(await relaySend(body, env));
      if (url.pathname === '/relay/verified') {
        if (!/^[0-9a-f]{40}$/.test(body.sha || '')) return json({ error: 'bad sha' }, 400);
        if ((await env.NOTE.get('verified')) !== body.sha) await env.NOTE.put('verified', body.sha); // 10분마다 오므로 바뀔 때만 씀
        return json({ ok: true });
      }
      if (url.pathname === '/relay/import') { // 설치할 때 한 번: 기존 연결·링크 코드·확인 상태 옮기기
        const owners = await loadOwners(env);
        for (const [chat, member] of Object.entries(body.owners || {})) if (/^-?\d+$/.test(chat) && /^[a-z][a-z0-9_]*$/.test(member)) owners[chat] = member;
        await env.NOTE.put('owners', JSON.stringify(owners));
        for (const c of body.codes || []) if (/^[A-Za-z0-9_-]{16}$/.test(c.code) && c.ttl >= 60) await env.NOTE.put(`code:${c.code}`, JSON.stringify({ member: c.member }), { expirationTtl: Math.floor(c.ttl) });
        if (/^[0-9a-f]{40}$/.test(body.verified || '')) await env.NOTE.put('verified', body.verified);
        return json({ ok: true, linked: Object.values(owners) });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
