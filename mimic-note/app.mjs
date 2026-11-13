// 코어 오브 미믹노트 — 텔레그램 업데이트 하나를 처리한다(미션 앱의 모든 버튼·글 명령).
// PC 봇(bot.mjs, 롱폴링)과 클라우드플레어 워커(worker/index.mjs, 웹훅)가 똑같이 쓴다. Node 전용 기능은 쓰지 않는다.
// 플랫폼마다 다른 것(연결 정보·임시 저장·GitHub 읽기/저장)은 ctx 로 받는다:
//
//   tg(method, body)                     텔레그램 API 호출
//   ownerOf(chatId) / chatOf(memberId)   연결(chat id ↔ 팀원 아이디). 모르면 null
//   linked() → Set(연결된 팀원 아이디)       팀 현황의 "미연결" 표시
//   state() → { members, db }            확인된 상태(+봇이 직접 만든 커밋) — core.safeHead
//   save(apply, describe, as) → w        core.mutate(+봇이 만든 커밋 기록)
//   kv.get(key) / kv.put(key, value, ttlSec) / kv.del(key)   확인 대기·쓰기 대기·처리 중 표시(JSON 값)
//   langHint(memberId) → 언어|null         GitHub 를 읽기 전에 보내는 문구(만료 버튼·오류)용
//   unlinkedMembers() → members          연결 안 된 대화에 보여 줄 버튼판용 명부
//   link(u, lang) → { member, members } | { key } | { text }   연결 안 된 대화의 /start <코드> (연결 완료 문구는 플랫폼이 보냄)
//   makeLink(owner, target, members) → 안내 문구   (선택) 관리자 "루카스 연결링크"
//   latestDb() → main 의 미션 DB(안내용 — 거의 동시에 두 번 누른 완료가 이미 저장됐는지)
//   randomKey() · log(line)
import {
  ADMIN_ROLES, esc, menuKeyboard, menuText, decide, confirmText, resolveRefs, boardText, boardKeyboard, teamText, sentText,
  decideCallback, composePrompt, requestNotice, respondNotice, respondRequest, setLang, ACTIONS, resultText, langKeyboard,
  tr, dn, langOf, guessLang, findMember, LANG_NAMES,
} from './core.mjs';

export const PENDING_SEC = 600; // 확인 버튼·📨 쓰기는 10분

// 누른 버튼의 미션만 메시지에서 뺀다(처리한 요청 버튼이 남아 다시 눌리지 않게)
export const withoutMission = (markup, missionId) => ({
  inline_keyboard: (markup?.inline_keyboard || []).map((row) => row.filter((b) => !String(b.callback_data || '').endsWith(`:${missionId}`))).filter((row) => row.length),
});

export async function handleUpdate(u, ctx) {
  const send = (chatId, text, extra = {}) => ctx.tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const edit = (chatId, messageId, text, markup) => ctx.tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) })
    .catch((e) => (/not modified/i.test(e.message) ? null : send(chatId, text, markup ? { reply_markup: markup } : {})));
  const replyTo = String(u.message?.chat?.id || u.callback_query?.message?.chat?.id || '');
  if (!replyTo) return;
  const ownerId = await ctx.ownerOf(replyTo);
  let lang = ownerId ? ((await ctx.langHint(ownerId)) || 'ko') : guessLang(u.message?.from?.language_code || u.callback_query?.from?.language_code);
  try {
    if (u.callback_query) return await onCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return; // 단체방·사진 등은 무시
    return await onMessage(msg);
  } catch (e) {
    ctx.log(`처리 실패: ${e.message}`);
    if (u.callback_query) await ctx.tg('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {}); // 버튼 로딩 표시를 끝낸다
    await send(replyTo, tr(lang).cannotNow(esc(e.message))).catch(() => {});
  }

  // 확인 대기에 넣고 [✅][취소] 를 보낸다
  async function ask(fromId, d, picked = []) {
    const t = tr(lang);
    const key = ctx.randomKey();
    // targetName: 커밋 메시지용(한글 이름), shown: 화면에 보일 이름(누른 사람의 언어)
    await ctx.kv.put(`pend:${key}`, { action: d.action, chatId: replyTo, fromId, ownerId: d.owner.id, targetId: d.target.id, targetName: d.target.name, shown: dn(d.target, lang), lang, items: d.items || [], ids: picked.map((x) => x.id), at: Date.now() }, PENDING_SEC);
    const yes = { add: t.yesAdd, request: t.yesRequest, set: t.yesSet, done: t.yesDone }[d.action];
    await send(replyTo, confirmText(d, picked, lang), { reply_markup: { inline_keyboard: [[{ text: yes, callback_data: `g:${key}` }, { text: t.cancelBtn, callback_data: `x:${key}` }]] } });
  }

  async function onCallback(cq) {
    const answer = (text) => ctx.tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
    const mid = cq.message?.message_id;
    const data = String(cq.data || '');
    if (cq.message?.chat?.type !== 'private') return answer();
    // 확인·취소: 그 확인을 만든 사람만, 10분 안에, 한 번만
    if (/^[gx]:/.test(data)) {
      const key = data.slice(2);
      const p = /^[\w-]{1,40}$/.test(key) ? await ctx.kv.get(`pend:${key}`) : null;
      if (!p || p.chatId !== replyTo || p.fromId !== String(cq.from?.id)) return answer(tr(lang).expired);
      await ctx.kv.del(`pend:${key}`);
      lang = p.lang || lang;
      const t = tr(lang);
      await answer();
      if (Date.now() - p.at > PENDING_SEC * 1000) return void (await edit(replyTo, mid, t.timedOut));
      if (data[0] !== 'g') return void (await edit(replyTo, mid, t.cancelled));
      await edit(replyTo, mid, t.saving); // 버튼을 없애 두 번 눌리지 않게
      const spec = ACTIONS[p.action];
      if (!spec) return void (await edit(replyTo, mid, t.unknownBtn));
      try {
        const w = await ctx.save(spec.apply(p), (r) => `${p.targetName} ${spec.label}${r.added ? ` ${r.added.length}개` : ''}`, p.ownerId);
        const shown = p.shown || p.targetName;
        await edit(replyTo, mid, resultText(p.action, shown, w, lang), { inline_keyboard: [[{ text: t.viewBtn(shown), callback_data: `v:${p.targetId}` }]] });
        ctx.log(`${w.actor.name} → ${p.targetName} ${spec.label} (${w.commit ? w.commit.slice(0, 7) : '변경 없음'})`);
        if (p.action === 'request' && w.result.added.length) {
          const to = await ctx.chatOf(p.targetId);
          if (to) {
            const n = requestNotice(w.actor, w.result.added, langOf(w.db, p.targetId)); // 받는 사람의 언어로
            await send(to, n.text, { reply_markup: n.reply_markup }).catch((e) => send(replyTo, t.notifyFail(esc(shown), esc(e.message))));
          } else await send(replyTo, t.targetUnlinked(esc(shown)));
        }
      } catch (e) {
        if (p.action === 'done' && p.ids.length) {
          try {
            const latest = await ctx.latestDb();
            if (p.ids.every((id) => latest.missions.find((m) => m.id === id)?.status === 'done')) return void (await edit(replyTo, mid, t.alreadyDone(esc(p.shown || p.targetName))));
          } catch { /* 아래 실패 표시 */ }
        }
        await edit(replyTo, mid, t.saveFail(esc(e.message)));
      }
      return;
    }
    if (!ownerId) return answer(tr(lang).linkFirst);
    const { members, db } = await ctx.state();
    const viewer = members.find((m) => m.id === ownerId) || null;
    lang = viewer ? langOf(db, viewer.id) : lang;
    const t = tr(lang);
    const d = decideCallback(data, { viewer, members, db, lang });
    if (d.kind === 'stale' || d.kind === 'pending') return answer(d.text || t.expired);
    if (d.kind === 'board') {
      await answer();
      await edit(replyTo, mid, boardText(viewer, d.member, db, members, lang), boardKeyboard(viewer, d.member, db, lang));
    } else if (d.kind === 'lang') {
      await answer();
      try {
        await ctx.save((db2, ms, actor) => setLang(db2, actor.id, d.lang, actor.id), () => `${viewer.name} 텔레그램 언어 ${d.lang}`, viewer.id);
        await edit(replyTo, mid, `🌐 ${LANG_NAMES[d.lang]}`);
        await send(replyTo, `${tr(d.lang).langSet}\n\n${menuText(viewer, members, { lang: d.lang })}`, { reply_markup: menuKeyboard(members, d.lang) });
      } catch (e) {
        await send(replyTo, t.saveFail(esc(e.message)));
      }
    } else if (d.kind === 'compose') {
      await answer();
      await ctx.kv.put(`compose:${replyTo}`, { target: d.target.id, at: Date.now() }, PENDING_SEC);
      await send(replyTo, composePrompt(d.target, d.mode, lang));
    } else if (d.kind === 'confirm-done') {
      await answer();
      await ask(String(cq.from?.id), { action: 'done', owner: viewer, target: d.target }, d.picked);
    } else if (d.kind === 'respond') {
      const busyKey = `busy:${d.mission.id}`;
      if (await ctx.kv.get(busyKey)) return answer(t.busy);
      await ctx.kv.put(busyKey, 1, 60);
      await answer(d.accept ? t.accepting : t.declining);
      try {
        const label = d.accept ? '요청수락' : '요청거절';
        const w = await ctx.save((db2, ms, actor) => respondRequest(db2, d.mission.id, d.accept, actor.id, ms), () => `${d.target.name} ${label} ${d.mission.id}`, viewer.id);
        const m = w.result.mission;
        const assignee = w.members.find((x) => x.id === m.assignee) || { id: m.assignee, name: m.assignee };
        await ctx.tg('editMessageReplyMarkup', { chat_id: replyTo, message_id: mid, reply_markup: withoutMission(cq.message.reply_markup, m.id) }).catch(() => {});
        const an = dn(assignee, lang);
        await send(replyTo, d.accept ? t.acceptedMsg(esc(m.title), esc(an)) : t.declinedMsg(esc(m.title)), { reply_markup: { inline_keyboard: [[{ text: t.viewBtn(an), callback_data: `v:${assignee.id}` }]] } });
        const reqChat = m.createdBy !== w.actor.id ? await ctx.chatOf(m.createdBy) : null;
        if (reqChat) await send(reqChat, respondNotice(m, d.accept, w.actor, assignee, langOf(w.db, m.createdBy))).catch((e) => ctx.log(`요청 결과 알림 실패: ${e.message}`));
        ctx.log(`${w.actor.name} ${label} ${m.id} (${w.commit ? w.commit.slice(0, 7) : '변경 없음'})`);
      } catch (e) {
        await send(replyTo, t.respondFail(esc(e.message)));
      } finally {
        await ctx.kv.del(busyKey);
      }
    }
  }

  async function onMessage(msg) {
    // 연결 안 된 대화: GitHub 를 부르지 않고 연결(코드)·안내만
    if (!ownerId) {
      if (/^\/start(?:@\w+)?\s+\S+/.test(msg.text.trim())) {
        const r = await ctx.link(u, lang);
        if (r.member) {
          await send(replyTo, menuText(r.member, r.members, { lang }), { reply_markup: menuKeyboard(r.members, lang) });
          await send(replyTo, tr(lang).langPrompt, { reply_markup: langKeyboard() }); // 처음 연결하면 언어부터 고르게
        } else await send(replyTo, esc(r.key ? tr(lang)[r.key] : r.text || tr(lang).linkNeedCode));
      } else await send(replyTo, menuText(null, [], { lang }), { reply_markup: menuKeyboard(await ctx.unlinkedMembers(), lang) });
      return;
    }
    const { members, db } = await ctx.state();
    lang = langOf(db, ownerId);
    const t = tr(lang);
    const owner = members.find((m) => m.id === ownerId) || null;
    // 관리자: "루카스 연결링크" / "/link 루카스" → 그 팀원 일회용 연결 링크(플랫폼이 지원할 때)
    const lk = ctx.makeLink && msg.text.trim().match(/^(?:\/link(?:@\w+)?\s+(\S+)|(\S+?)\s*연결\s*링크)$/);
    if (lk && owner) {
      const target = findMember(lk[1] || lk[2], members);
      return void (await send(replyTo, await ctx.makeLink(owner, target, members)));
    }
    const c = await ctx.kv.get(`compose:${replyTo}`);
    const ct = c && Date.now() - c.at < PENDING_SEC * 1000 ? members.find((m) => m.id === c.target) : null;
    const chatOwners = new Map([[replyTo, ownerId]]); // 판단에는 보낸 사람 것만 있으면 된다
    const d = decide(msg, { members, chatOwners, compose: ct ? { target: ct } : null, lang });
    if (c && d.kind !== 'act-error') await ctx.kv.del(`compose:${replyTo}`); // 내용이 잘못됐으면 다시 적을 수 있게 남겨 둔다
    if (d.kind === 'ignore') return;
    if (d.kind === 'link') return void (await send(replyTo, t.alreadyLinked(esc(dn(owner, lang))))); // 남의 링크를 누름 — 연결은 그대로
    if (d.kind === 'menu' || d.kind === 'unlinked') await send(replyTo, menuText(d.owner || null, members, { lang }), { reply_markup: menuKeyboard(members, lang) });
    else if (d.kind === 'cancel') await send(replyTo, t.cancelled);
    else if (d.kind === 'lang-menu') await send(replyTo, t.langPrompt, { reply_markup: langKeyboard() });
    else if (d.kind === 'board') {
      await send(replyTo, boardText(d.owner, d.member, db, members, lang), { reply_markup: boardKeyboard(d.owner, d.member, db, lang) });
      ctx.log(`${d.owner.name} → ${d.member.name}봇`);
    } else if (d.kind === 'team') await send(replyTo, teamText(members, db, await ctx.linked(), lang));
    else if (d.kind === 'sent') await send(replyTo, sentText(d.owner, members, db, lang));
    else if (d.kind === 'act-denied') await send(replyTo, d.text);
    else if (d.kind === 'act-error') await send(replyTo, esc(d.error));
    else if (d.kind === 'act') {
      let picked = [];
      if (d.action === 'done') {
        try { picked = resolveRefs(db, d.target.id, d.refs); } catch (e) { return void (await send(replyTo, esc(e.ref != null ? t.notFound(e.ref, e.left) : e.message))); }
      }
      await ask(String(msg.from?.id), d, picked);
    }
  }
}

// 관리자 연결 링크 문구(워커가 씀) — 코드 만들기는 플랫폼이
export function linkAllowed(owner, target, alreadyLinked) {
  if (!target) return 'noMember';
  if (!ADMIN_ROLES.has(owner.role)) return 'adminOnly';
  if (alreadyLinked && owner.role !== 'owner') return 'ownerOnly';
  return null;
}
