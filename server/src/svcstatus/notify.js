/**
 * svcstatus/notify.js — 상태 변화 메일(v3.54 — 중앙 전용 · 1분 틱 · 측정 주기 밖).
 *
 * 규칙(조사 6 §1 — bareos/health · vmclone/notify · diskbad 와 같은 계열):
 *   · 대상마다 **알린 상태 커서**(DB `sv_latest.notified`)와 지금 알림 수준(`judge.alertLevelOf`)을 비교해 바뀐 것만 보낸다 — 같은 상태를 다시 보내지 않는다.
 *   · 처음 본 대상(커서 없음)은 **기준점만** 세우고 보내지 않는다 — 업그레이드 직후 · 새 등록 직후에 과거 상태를 쏟지 않는다.
 *   · 메일 / 이 종류가 꺼졌거나 받는 사람이 없으면(정책대로) 커서만 옮긴다 — 나중에 켰을 때 쌓인 변화를 한꺼번에 쏟지 않는다.
 *   · 보내지 못했으면(SMTP 실패 · 인증 정지 · 시간당 한도) 커서를 옮기지 않고 10분 뒤 다시 — 그때의 상태로 보낸다.
 *   · 한 틱의 변화는 **법인별 한 통**, 법인이 `SUMMARY_CORPS` 를 넘으면 전체 요약 한 통(중앙 회선 장애로 28법인이 동시에 끊기면 28통이 시간당 한도를 태운다).
 *   · 데모(mock)는 보내지 않는다(커서는 옮긴다 — docs/rules/demo.md v2.708).
 *   · 사람이 끄거나 뺀 대상(off · excluded · problem)은 '복구' 를 보내지 않고 커서만 조용히 정상으로(다시 넣었을 때 끊겨 있으면 그때 알린다).
 */
import { config } from '../config.js';
import { loadSvcStatusSettings } from './settings.js';
import { getPlan, currentRows } from './service.js';
import { alertLevelOf } from './judge.js';
import * as db from './db.js';
import { isMockMode } from '../mock/demo/flags.js';

export const MAIL_KIND = 'svc-status';
export const SUMMARY_CORPS = 5;
export const MAIL_RETRY_MS = 10 * 60_000;
const ROWS_PER_MAIL = 200;
let _busy = false; let _nextTry = 0; let _last = null;

export function svcStatusMailInfo() { return _last ? { ..._last } : null; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEVEL_LABEL = { ok: '복구', slow: '지연', down: '끊김', unknown: '못 잼' };
const fmtTs = (ms) => { try { return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }); } catch { return String(ms); } };

/**
 * 이번 틱에 보낼 변화(순수).
 * @param {Array} rows view.buildRows 행(서버 칸 `_tid` · `_notified` 포함)
 * @returns {{ events:Array<{row,from,to}>, quiet:Array<[tid, level]> }}
 */
export function planMail(rows, { alerts = {}, now = Date.now() } = {}) {
  const events = []; const quiet = [];
  for (const r of rows) {
    if (r._tid == null) continue;            // 측정한 적 없는 대상 — 알릴 것이 없다
    const cur = r._notified ?? null;
    const unknownForMs = r.state === 'unknown' ? (r.since != null ? now - r.since : (r.lastTs != null ? now - r.lastTs : 0)) : 0;
    const level = alertLevelOf(r.state, { alerts, unknownForMs });
    if (level === 'hold') continue;
    if (level === 'quiet') { if (cur != null && cur !== 'ok') quiet.push([r._tid, 'ok']); continue; }
    if (cur == null) { quiet.push([r._tid, level]); continue; }   // 처음 본 상태 — 기준점만
    if (level === cur) continue;
    events.push({ row: r, from: cur, to: level });
  }
  return { events, quiet };
}

/** 메일 한 통(순수). */
export function buildMail(events, { corpLabel = '', summary = false } = {}) {
  const cnt = {};
  for (const e of events) cnt[e.to] = (cnt[e.to] || 0) + 1;
  const parts = ['down', 'unknown', 'slow', 'ok'].filter((k) => cnt[k]).map((k) => `${LEVEL_LABEL[k]} ${cnt[k]}`);
  const subject = `[포탈 서비스 상태] ${parts.join(' · ')}${summary ? ` — 전체 ${new Set(events.map((e) => e.row.corp?.label || '')).size}개 법인` : corpLabel ? ` — ${corpLabel}` : ''}`;
  const list = events.slice(0, ROWS_PER_MAIL);
  const tr = list.map((e) => {
    const r = e.row;
    const val = e.to === 'down' ? (r.failKind || '연결 실패') : e.to === 'unknown' ? '측정값 없음' : (r.ms != null ? `${r.ms} ms${r.baseMs != null ? ` (평소 ${r.baseMs} ms)` : ''}` : '—');
    return `<tr><td style="padding:4px 8px">${esc(LEVEL_LABEL[e.to])}</td><td style="padding:4px 8px">${esc(r.kindLabel)}</td><td style="padding:4px 8px">${esc(r.corp?.label || '—')}</td>`
      + `<td style="padding:4px 8px">${esc(r.name)}</td><td style="padding:4px 8px">${esc(r.address || '—')}</td><td style="padding:4px 8px">${esc(r.by === 'central' ? '중앙' : r.by || '—')}</td>`
      + `<td style="padding:4px 8px">${esc(val)}</td><td style="padding:4px 8px">${esc(r.since != null ? fmtTs(r.since) : '—')}</td></tr>`;
  }).join('');
  const html = `<div style="font-family:sans-serif;font-size:13px"><p>${esc(subject)}</p>
<table style="border-collapse:collapse;font-size:12.5px"><thead><tr><th style="text-align:left;padding:4px 8px">변화</th><th style="text-align:left;padding:4px 8px">종류</th><th style="text-align:left;padding:4px 8px">법인</th>
<th style="text-align:left;padding:4px 8px">이름</th><th style="text-align:left;padding:4px 8px">접속처</th><th style="text-align:left;padding:4px 8px">측정</th><th style="text-align:left;padding:4px 8px">값</th><th style="text-align:left;padding:4px 8px">상태 시작</th></tr></thead>
<tbody>${tr}</tbody></table>
${events.length > list.length ? `<p style="font-size:12px;color:#667085">그 밖에 ${events.length - list.length}건은 포탈에서 봅니다.</p>` : ''}
<p style="font-size:11.5px;color:#667085;margin-top:12px">TCP 연결만 봅니다(로그인 · 서비스 응답은 보지 않습니다). 특수 기능 › 포탈 서비스 상태 모니터링에서 자세히 봅니다.</p></div>`;
  const text = `${subject}\n\n${list.map((e) => `${LEVEL_LABEL[e.to]}\t${e.row.kindLabel}\t${e.row.corp?.label || '—'}\t${e.row.name}\t${e.row.address || '—'}`).join('\n')}`;
  return { subject, html, text };
}

/** 묶음: 법인별 → 법인이 많으면 한 통. */
export function groupMails(events) {
  const by = new Map();
  for (const e of events) { const k = e.row.corp?.key || e.row.corp?.label || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  if (by.size > SUMMARY_CORPS) return [{ corpLabel: '', summary: true, events }];
  return [...by.values()].map((list) => ({ corpLabel: list[0].row.corp?.label || '', summary: false, events: list }));
}

export async function svcStatusMailTick({ now = Date.now(), send = null, mock = null } = {}) {
  if (config.agent?.centralUrl) return { ok: false, skipped: 'edge-node' };
  if (_busy) return { ok: false, skipped: 'busy' };
  if (now < _nextTry) return { ok: false, skipped: 'retry-wait' };
  _busy = true;
  try {
    const settings = loadSvcStatusSettings();
    const plan = await getPlan();
    const { rows, dbOk } = await currentRows({ plan, now });
    if (!dbOk) { _last = { at: now, skipped: 'db-unavailable' }; return _last; }
    const { events, quiet } = planMail(rows, { alerts: settings.alerts, now });
    if (quiet.length) await db.setNotified(quiet, now);
    if (!events.length) return { ok: true, events: 0 };
    const isMock = mock ?? isMockMode();
    if (isMock) {
      await db.setNotified(events.map((e) => [e.row._tid, e.to]), now);
      _last = { at: now, events: events.length, skipped: 'demo' };
      return _last;
    }
    const { sendPortalMail } = await import('../mail/service.js');
    const { load: loadMail } = await import('../mail/settings.js');
    const { resolveRecipients } = await import('../mail/kinds.js');
    const doSend = send || sendPortalMail;
    const cfg = loadMail();
    const extra = Array.isArray(settings.alerts?.to) ? settings.alerts.to : [];
    const base = resolveRecipients(cfg, MAIL_KIND, extra.length ? extra : null);
    const mails = groupMails(events);
    if (!base.ok) {
      // 정책대로 보내지 않는다(메일 꺼짐 · 종류 꺼짐 · 받는 사람 없음) — 커서만 옮긴다(나중에 켰을 때 쌓인 변화를 쏟지 않게).
      await db.setNotified(events.map((e) => [e.row._tid, e.to]), now);
      _last = { at: now, events: events.length, mails: 0, skipped: 'policy', reason: String(base.reason || '').slice(0, 200) };
      return _last;
    }
    const kindTo = resolveRecipients(cfg, MAIL_KIND);
    const results = [];
    for (const m of mails) {
      const mail = buildMail(m.events, m);
      const to = extra.length ? [...new Set([...(kindTo.ok ? kindTo.to : []), ...extra])] : null;
      // 받는 사람을 명시하면 공용 경로가 종류별 참조를 빼므로 참조도 함께 넘긴다(diskbad 반증 R2-2 와 같다).
      // eslint-disable-next-line no-await-in-loop
      const r = await doSend({ kind: MAIL_KIND, subject: mail.subject, html: mail.html, text: mail.text, ...(to ? { to, cc: kindTo.ok && Array.isArray(kindTo.cc) ? kindTo.cc : [] } : {}) });
      if (r?.ok) {
        // eslint-disable-next-line no-await-in-loop
        await db.setNotified(m.events.map((e) => [e.row._tid, e.to]), now);
        results.push({ ok: true, events: m.events.length });
      } else results.push({ ok: false, events: m.events.length, reason: String(r?.reason || '').slice(0, 200) });
    }
    const failed = results.filter((x) => !x.ok);
    if (failed.length) {
      _nextTry = now + MAIL_RETRY_MS;
      console.warn(`[svc-status] 상태 변화 메일 ${failed.length}/${results.length}통을 보내지 못했습니다 — ${Math.round(MAIL_RETRY_MS / 60_000)}분 뒤 다시: ${failed[0].reason}`);
    }
    _last = { at: now, events: events.length, mails: results.length, sent: results.length - failed.length, failed: failed.length, ...(failed.length ? { reason: failed[0].reason } : {}) };
    return _last;
  } catch (e) {
    _last = { at: now, ok: false, error: String(e?.message || e).slice(0, 200) };
    console.warn(`[svc-status] 메일 틱 실패: ${_last.error}`);
    return _last;
  } finally { _busy = false; }
}

export function _resetSvcStatusMailForTest() { _busy = false; _nextTry = 0; _last = null; }
