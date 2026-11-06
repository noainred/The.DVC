/**
 * hostNetText.js — 호스트 상세 ‘네트워크’ 카드의 CVP 업링크 열·블록 문구(순수, v2.920 — 시안 D-② HostNet).
 * 서버 /hosts/:id/net-uplinks(cvp/hostMatch.js) 응답을 글자로. 방향은 스위치 포트 기준 — In = 서버 송신 · Out = 서버 수신.
 * 근거 없는 매칭을 만들지 않는다 — 매칭이 없으면 ‘미매칭’ 이고 그 이유(설명에 단서 없음 · CVP 없음)를 말한다.
 */
import { numOrNull } from '../numOrNull.js';

export const BASIS = Object.freeze({
  lldp: { label: '확정', note: 'LLDP 이웃', tone: 'green' },
  mac: { label: '높음', note: 'MAC 테이블 학습', tone: 'green' },
  'desc-mac': { label: '보통', note: '포트 설명에 NIC MAC', tone: 'amber' },
  'desc-nic': { label: '보통', note: '포트 설명에 호스트 이름 + vmnic', tone: 'amber' },
  'desc-name': { label: '보통', note: '포트 설명에 호스트 이름(NIC 미확정)', tone: 'amber' },
});
export const basisOf = (k) => BASIS[k] || { label: '미매칭', note: '근거 없음', tone: 'gray' };

export function bpsText(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(n)} bps`;
}
/** 송신/수신 — 스위치 In = 서버 송신 · Out = 서버 수신. */
export const txRxText = (u) => (numOrNull(u?.inBps) == null && numOrNull(u?.outBps) == null ? '—' : `${bpsText(u?.inBps)} / ${bpsText(u?.outBps)}`);
export const errText = (u) => (numOrNull(u?.inErr) == null && numOrNull(u?.outErr) == null ? '—' : `${numOrNull(u?.inErr) ?? '—'} / ${numOrNull(u?.outErr) ?? '—'}`);
export const speedText = (bps) => { const n = numOrNull(bps); return n == null ? '—' : n >= 1e9 ? `${Math.round(n / 1e8) / 10} G` : `${Math.round(n / 1e6)} M`; };
export const portLabel = (u) => `${u?.hostname || u?.key || '?'} ${u?.port || ''}`.trim();

/** NIC(vmnicN) 별 업링크 — 설명이 NIC 까지 지목한 것만. 호스트 이름만 맞은 포트는 nic 이 null 이라 여기 없다. */
export function uplinksByNic(uplinks = []) {
  const m = new Map();
  for (const u of Array.isArray(uplinks) ? uplinks : []) if (u?.nic) { if (!m.has(u.nic)) m.set(u.nic, []); m.get(u.nic).push(u); }
  return m;
}
export const hostLevelUplinks = (uplinks = []) => (Array.isArray(uplinks) ? uplinks : []).filter((u) => !u?.nic);

/** NIC 표의 ‘CVP 스위치 · 포트’ 칸 글자. */
export function nicUplinkText(list) {
  if (!list?.length) return '';
  return list.map(portLabel).join(' · ');
}

/** 카드 머리에 붙는 요약 + 블록 머리 문구. */
export function uplinkSummary(d, nics = []) {
  if (!d) return { text: '', note: '' };
  if (d.cvpUnavailable) return { text: 'CVP DB 없음', note: 'CVP 수집 DB 를 열지 못했습니다.' };
  if (!d.servers) return { text: 'CVP 없음', note: d.corpLimited ? '이 법인에 등록된 CVP 서버가 없습니다(범위 계정은 자기 법인 CVP 만 봅니다).' : '등록된 CVP 서버가 없습니다(특수 기능 › Arista CloudVision).' };
  const ups = Array.isArray(d.uplinks) ? d.uplinks : [];
  const byNic = uplinksByNic(ups);
  const nicN = Array.isArray(nics) ? nics.length : 0;
  const counts = {};
  for (const u of ups) counts[u.basis] = (counts[u.basis] || 0) + 1;
  const basisText = Object.entries(counts).map(([k, n]) => `${basisOf(k).label}(${basisOf(k).note}) ${n}`).join(' · ');
  if (!ups.length) return { text: `CVP 매칭 0 / ${nicN} NIC`, note: `CVP 포트 설명에서 호스트 이름 ‘${d.terms?.short || ''}’ 이나 NIC MAC 을 찾지 못했습니다 — 스위치 포트 설명(description)에 호스트 이름 또는 MAC 을 적으면 매칭됩니다. LLDP·MAC 테이블 수집은 다음 단계입니다.` };
  return { text: `CVP 매칭 ${byNic.size} / ${nicN} NIC${ups.length - [...byNic.values()].flat().length ? ` · 호스트 수준 ${hostLevelUplinks(ups).length}` : ''}`, note: `${basisText}${d.conflicts?.length ? ` · 충돌 ${d.conflicts.length}(같은 MAC 이 포트 3개 이상)` : ''}${d.truncated ? ' · 후보 상한 초과(일부만)' : ''}` };
}

/** 업링크 합계(매칭 포트의 In/Out 합 — 없는 값은 더하지 않고 센다). */
export function uplinkTotals(uplinks = []) {
  let tx = null; let rx = null; let unmeasured = 0; let err = null;
  for (const u of Array.isArray(uplinks) ? uplinks : []) {
    const i = numOrNull(u?.inBps); const o = numOrNull(u?.outBps);
    if (i == null && o == null) { unmeasured += 1; continue; }
    if (i != null) tx = (tx ?? 0) + i; if (o != null) rx = (rx ?? 0) + o;
    const e = (numOrNull(u?.inErr) ?? 0) + (numOrNull(u?.outErr) ?? 0);
    if (numOrNull(u?.inErr) != null || numOrNull(u?.outErr) != null) err = (err ?? 0) + e;
  }
  return { tx, rx, unmeasured, err };
}

export const SEVERITY_BADGE = Object.freeze({ critical: 'red', error: 'red', warning: 'amber', info: 'gray' });
export const eventTimeText = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
