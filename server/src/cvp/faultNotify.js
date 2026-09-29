/**
 * cvp/faultNotify.js — CVP 장애 전이 → 알림(v2.640). partfault/notify.js 와 같은 규약:
 *  · **파트당 1건 즉시**(사용자 선택 v2.547) · **순차 발송**(alerts.js refreshState 처럼 await 없이 돌리면 Slack webhook 에
 *    동시 수백 POST 가 나간다) · 상한은 버리는 것이 아니라 **밝히는 것**(capped) · 결과 문자열을 그대로 보관해 화면이
 *    'N건 미발송' 을 말한다.
 *  · 알림 본문에서 `**강조**` 를 제거한다 — Slack·메일에는 BoldText 가 없다(v2.439·2.440·2.505 사고).
 *  · `alerts.js notify()` 의 전역 중복 억제(shouldSuppress, key 단위)는 서로 다른 장애끼리 억제하지 않는다.
 * 테스트가 실제 웹훅을 부르지 않게 `send` 를 주입받는다(기본 alerts.notify).
 */
import { notify as sendAlert } from '../alerts.js';

const t = (v) => String(v ?? '').trim();
const plain = (x) => String(x ?? '').replace(/\*\*/g, '');

export const FAULT_KIND_LABEL = Object.freeze({ psu: 'PSU', fan: '팬', temp: '온도', xcvr: '트랜시버', port: '포트', bgp: 'BGP 피어' });
export const FAULT_STATE_LABEL = Object.freeze({ ok: '정상', warn: '주의', fault: '이상', unknown: '확인 불가', absent: '빈 슬롯' });

/** 알림 1건의 키·심각도·제목·본문(순수) — 문구를 여기 한 곳에서만 만든다. */
export function alertOf(f, { closed = false } = {}) {
  const kind = FAULT_KIND_LABEL[f?.kind] || t(f?.kind);
  const dev = t(f?.deviceName) || t(f?.hostname) || t(f?.deviceKey);
  const label = t(f?.label);
  const partText = label && new RegExp(`^${kind}\\b`, 'i').test(label) ? label : `${kind} ${label}`.trim();
  const head = closed ? (f?.closeReason === 'no-link' ? 'CVP 장애 판정 제외' : 'CVP 장애 해소') : 'CVP 장애';
  const title = `${head} — ${dev} · ${partText}`;
  const lines = [
    `장비: ${dev}${t(f?.agent) ? ` (수집: ${t(f.agent)})` : ''}`,
    ...(t(f?.cvpName) ? [`CVP: ${t(f.cvpName)}`] : []),
    `파트: ${partText}${t(f?.detail) ? ` · ${t(f.detail)}` : ''}`,
    closed
      ? (f?.closeReason === 'no-link'
        ? '상태: 판정 대상에서 제외됨 (링크가 내려간 포트라 광량·Tx·바이어스를 판정하지 않습니다 — 고쳐졌다는 뜻이 아닙니다)'
        : `상태: 해소됨${f?.closeReason === 'removed' ? ' (부품이 제거되어 더 이상 보이지 않습니다 — 교체 여부를 확인하세요)' : ''}`)
      : `상태: ${FAULT_STATE_LABEL[f?.state] || t(f?.state)}${t(f?.prevState) ? ` (이전: ${FAULT_STATE_LABEL[f.prevState] || t(f.prevState)})` : ''}`,
  ];
  return {
    key: `cvpfault:${t(f?.agent)}|${t(f?.cvpId)}|${t(f?.deviceKey)}|${t(f?.faultKey)}${closed ? ':close' : ''}`,
    severity: closed ? 'info' : (f?.state === 'fault' ? 'critical' : 'warning'),
    title: plain(title),
    detail: plain(lines.join('\n')),
  };
}

/**
 * 전이 결과 → 알림 발송(순차). opened + updated(상태 변화) + closed(notifyClosed).
 * @param {{opened?:object[], updated?:object[], closed?:object[]}} tr
 * @param {{notifyClosed?:boolean, max?:number, send?:Function}} [opt]
 * @returns {Promise<{sent:number, skipped:number, capped:number, total:number, results:Array<{key:string, closed:boolean, results:string}>}>}
 */
export async function notifyFaultTransition(tr, { notifyClosed = true, max = 200, send = sendAlert } = {}) {
  const items = [];
  for (const f of tr?.opened || []) items.push({ f, closed: false });
  for (const f of tr?.updated || []) if (!f.sameState) items.push({ f, closed: false });
  if (notifyClosed) for (const f of tr?.closed || []) items.push({ f, closed: true });
  const take = items.slice(0, Math.max(0, Math.trunc(Number(max)) || 0));
  const results = [];
  let sent = 0; let skipped = 0;
  for (const it of take) {
    const a = alertOf(it.f, { closed: it.closed });
    try {
      const r = await send(a);
      const line = Array.isArray(r) ? r.join(' · ') : String(r ?? '');
      results.push({ key: a.key, closed: it.closed, results: line });
      if (/suppressed/.test(line)) skipped += 1; else sent += 1;
    } catch (e) {
      results.push({ key: a.key, closed: it.closed, results: `err ${String(e?.message || e).slice(0, 120)}` });
    }
  }
  return { sent, skipped, capped: Math.max(0, items.length - take.length), total: items.length, results };
}
