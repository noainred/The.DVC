/**
 * partfault/notify.js — 파트 장애 알림(v2.547).
 *
 * 사용자 선택(2026-09-17): **"파트당 1건 즉시"**.
 *
 * ⚠ **정직 기록 — 제가 폭주 위험을 제기했고 사용자가 이 방식을 선택했습니다.**
 * 서버 965대 × 부품 수이므로 **한 장비가 재부팅하면 수십 건이 동시에** 발화할 수 있습니다.
 * 선택은 존중하되, 이 파일은 **그 결과를 숨기지 않습니다**:
 *  · 발송 결과 문자열(`email:skip …` 포함)을 그대로 보관해 화면이 **'N건 미발송'** 을 말한다.
 *    메일은 `mail/kinds.js:63-68` 이 **60건/시간**에서 초과분을 조용히 버린다 — 그것을
 *    사용자가 알 수 있어야 한다(이건 정책이 아니라 **침묵**이다).
 *  · `alerts.js notify()` 자체의 전역 중복 억제(`shouldSuppress`, 기본 5분)는 **key 단위**라
 *    서로 다른 파트끼리는 억제되지 않는다 — 그래서 파트당 1건이 그대로 나간다.
 *
 * ⚠ **순차 발송이다.** `alerts.js:373` 의 `refreshState()` 는 `notify()` 를 **await 없이**
 *   부른다 — 100건이면 Slack webhook 에 **동시 100 POST** 가 나간다. 여기서는 그 실수를
 *   반복하지 않고 하나씩 보낸다(웹훅 rate limit 로 통째로 버려지는 것을 막는다).
 */

import { notify as sendAlert } from '../alerts.js';
import { PART_STATE_LABEL, PART_KIND_LABEL, SCOPE_LABEL, KEY_KIND_NOTE } from './types.js';

const t = (v) => String(v ?? '').trim();

/** 알림 1건의 제목·본문(순수) — 문구를 여기 한 곳에서만 만든다. */
export function alertOf(p, { closed = false } = {}) {
  const scope = SCOPE_LABEL[p.scope] || p.scope;
  const kind = PART_KIND_LABEL[p.kind] || p.kind;
  const dev = t(p.deviceName) || t(p.deviceId);
  const sev = closed ? 'info' : (p.state === 'fault' ? 'critical' : 'warning');
  const head = closed ? '파트 장애 해소' : '파트 장애';
  /*
   * ⚠ 라벨이 이미 종류를 담고 있으면 되풀이하지 않는다 — 'PSU PSU 2' 처럼 보인다
   *   (v2.547 자체 점검에서 실제로 그랬다).
   */
  const partText = t(p.label) && new RegExp(`^${kind}\\b`, 'i').test(t(p.label))
    ? t(p.label) : `${kind} ${t(p.label)}`.trim();
  const title = `${head} — ${dev} · ${partText}`;
  const lines = [
    `장비군: ${scope}`,
    `장비: ${dev}${t(p.agent) ? ` (수집: ${t(p.agent)})` : ''}`,
    `파트: ${partText}${t(p.detail) ? ` · ${t(p.detail)}` : ''}`,
    closed
      ? `상태: 해소됨${p.closeReason === 'removed' ? ' (부품이 제거되어 더 이상 보이지 않습니다 — 교체 여부를 확인하세요)' : ''}`
      : `상태: ${PART_STATE_LABEL[p.state] || p.state}${t(p.rawState) ? ` (장비 보고: ${t(p.rawState)})` : ''}`,
  ];
  // ⚠ 키 신뢰도를 알린다 — 순번 키는 '같은 부품이 다른 파트로 기록될 수 있다'.
  //   `KEY_KIND_NOTE.index` 가 이미 ⚠ 로 시작하므로 접두를 덧붙이지 않는다.
  if (p.keyKind === 'index') lines.push(KEY_KIND_NOTE.index);
  /*
   * ⚠⚠ **알림 본문에서 `**강조**` 를 제거한다.** 이 문구는 Slack·Teams·메일·웹훅으로 나가고
   *   그쪽에는 `BoldText` 가 없다 — 별표가 글자로 그대로 인쇄된다(v2.439·2.440·2.505 실제 사고,
   *   `reportExport` 가 PDF 에서 같은 처리를 한다).
   */
  const plain = (x) => String(x).replace(/\*\*/g, '');
  return {
    key: `partfault:${p.partKey}${closed ? ':close' : ''}`,
    severity: sev,
    title: plain(title),
    detail: plain(lines.join('\n')),
  };
}

/**
 * 전이 결과 → 알림 발송. **순차**로 보내고 결과를 그대로 돌려준다.
 * @param {{opened:Array, updated:Array, closed:Array}} tr
 * @param {{notifyClosed?:boolean, max?:number}} [opt]
 * @returns {{sent:number, capped:number, results:Array, skipped:number}}
 */
export async function notifyTransition(tr, { notifyClosed = true, max = 200 } = {}) {
  const items = [];
  // v2.612 LEFT2612-04: 장비 키만 바뀐 같은 장애(migratedFrom · 옛 키 key-migrated 닫힘)는 새 사건이 아니다 — 다시 알리지 않는다.
  //   단 상태가 달라졌으면(warn→fault 등) 그것은 알린다.
  for (const p of tr.opened || []) if (!(p.migratedFrom && p.prevState === p.state)) items.push({ p, closed: false });
  // 악화(warn→fault)는 새 사건이다 — 알린다. 호전(fault→warn)도 상태가 바뀐 것이므로 알린다.
  for (const p of tr.updated || []) if (!p.sameState) items.push({ p, closed: false });
  if (notifyClosed) for (const p of tr.closed || []) if (p.closeReason !== 'key-migrated') items.push({ p, closed: true });

  const results = [];
  let sent = 0; let skipped = 0;
  /*
   * ⚠ 상한은 **버리는 것이 아니라 밝히는 것**이다 — 넘친 개수를 `capped` 로 돌려주고
   *   화면·로그가 "N건은 보내지 않았습니다" 라고 말한다(조용한 상한 금지 — CLAUDE.md 규약).
   */
  const take = items.slice(0, max);
  for (const it of take) {
    const a = alertOf(it.p, { closed: it.closed });
    try {
      const r = await sendAlert(a);           // 순차 — 동시 POST 폭주를 만들지 않는다
      const line = Array.isArray(r) ? r.join(' · ') : String(r);
      results.push({ partKey: it.p.partKey, closed: it.closed, result: line });
      if (/suppressed/.test(line)) skipped += 1; else sent += 1;
    } catch (e) {
      results.push({ partKey: it.p.partKey, closed: it.closed, result: `err ${String(e.message || e).slice(0, 120)}` });
    }
  }
  return { sent, skipped, capped: Math.max(0, items.length - take.length), results, total: items.length };
}

/** 발송 결과 문자열에서 **조용히 버려진 것**을 센다(메일 60건/시간 상한 등). */
export function countDropped(results) {
  let n = 0;
  for (const r of results || []) if (/email:skip/.test(String(r?.result || ''))) n += 1;
  return n;
}
