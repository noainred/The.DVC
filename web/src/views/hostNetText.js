/**
 * hostNetText.js — 호스트 상세 ‘네트워크’ 카드의 CVP 업링크 열·블록 문구(순수, v2.920 — 시안 D-② HostNet).
 * 서버 /hosts/:id/net-uplinks(cvp/hostMatch.js) 응답을 글자로. 방향은 스위치 포트 기준 — In = 서버 송신 · Out = 서버 수신.
 * 근거 없는 매칭을 만들지 않는다 — 매칭이 없으면 ‘미매칭’ 이고 그 이유(설명에 단서 없음 · CVP 없음)를 말한다.
 */
import { numOrNull } from '../numOrNull.js';

export const BASIS = Object.freeze({
  lldp: { label: '확정', note: 'LLDP 이웃', tone: 'green' },
  mac: { label: '높음', note: 'MAC 테이블 학습', tone: 'green' },
  'mac-vm': { label: '높음', note: 'MAC 테이블 — 이 호스트 VM MAC', tone: 'green' },   // v2.924(B-②)
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
/** v2.923(B-①): 직전 주기 드롭(in / out). 수집 전·못 읽음은 ‘—’. */
export const dropText = (u) => (numOrNull(u?.inDrop) == null && numOrNull(u?.outDrop) == null ? '—' : `${numOrNull(u?.inDrop) ?? '—'} / ${numOrNull(u?.outDrop) ?? '—'}`);
/** v2.923(B-①): 최근 24시간 합(in / out) — 값이 있는 표본만 더한 부분 합이라 일부 표본만 값이 있으면 그 수를 함께 준다. 없으면 ‘—’. */
export function daySumText(day, kind = 'drop') {
  if (!day) return '—';
  const [a, b, n] = kind === 'drop' ? [day.inDrop, day.outDrop, day.dropN] : [day.inErr, day.outErr, day.errN];
  if (numOrNull(a) == null && numOrNull(b) == null) return '—';
  return `${numOrNull(a) ?? '—'} / ${numOrNull(b) ?? '—'}${Number.isFinite(n) && Number.isFinite(day.samples) && n < day.samples ? ` (표본 ${n}/${day.samples})` : ''}`;
}
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
  const l2 = l2Text(d.l2);
  if (!ups.length) return { text: `CVP 매칭 0 / ${nicN} NIC`, note: `LLDP 이웃 · MAC 테이블 · 포트 설명 어디에서도 이 호스트(‘${d.terms?.short || ''}’ · NIC MAC · VM MAC)를 찾지 못했습니다. ${l2}` };
  return { text: `CVP 매칭 ${byNic.size} / ${nicN} NIC${ups.length - [...byNic.values()].flat().length ? ` · 호스트 수준 ${hostLevelUplinks(ups).length}` : ''}`, note: `${basisText}${d.conflicts?.length ? ` · 충돌 ${d.conflicts.length}(같은 MAC 이 포트 3개 이상)` : ''}${d.truncated ? ' · 후보 상한 초과(일부만)' : ''} · ${l2}` };
}

/**
 * v2.924(B-②): LLDP·MAC 테이블 수집 현황 한 줄 — 근거의 출처를 말한다. 0대면 '수집 전'(엣지 업그레이드 · 부품 주기 30분 · 경로 추정),
 *   조회 실패면 그렇다고. ESXi 는 표준 vSwitch 에서 LLDP 를 보내지 않는다(분산 스위치에서 켜야 한다) — LLDP 가 없다고 연결이 없는 것은 아니다.
 */
export function l2Text(l2) {
  if (!l2) return '';
  if (l2.error) return 'LLDP·MAC 테이블을 조회하지 못했습니다.';
  if (l2.unavailable) return 'CVP DB 를 열지 못해 LLDP·MAC 테이블을 볼 수 없습니다.';
  if (!l2.fdbDevices && !l2.lldpDevices) return 'LLDP·MAC 테이블은 아직 수집 전입니다(엣지 v2.924 이상 · 부품 주기 30분 · 텔레메트리 경로는 추정).';
  return `LLDP 를 읽은 스위치 ${l2.lldpDevices}대 · MAC 테이블을 읽은 스위치 ${l2.fdbDevices}대(ESXi 는 분산 스위치에서 LLDP 를 켜야 이웃으로 보입니다).`;
}
/** 업링크 합계(매칭 포트의 In/Out 합 — 없는 값은 더하지 않고 센다). */
export function uplinkTotals(uplinks = []) {
  let tx = null; let rx = null; let unmeasured = 0; let err = null; let drop = null; let dropDay = null; let errDay = null;
  for (const u of Array.isArray(uplinks) ? uplinks : []) {
    // v2.923(B-①): 드롭(직전 주기 · 24시간 합)과 24시간 오류는 처리량 측정 여부와 따로 센다 — 값이 있는 것만 더한다.
    for (const [k, a, b] of [['drop', u?.inDrop, u?.outDrop], ['dropDay', u?.day?.inDrop, u?.day?.outDrop], ['errDay', u?.day?.inErr, u?.day?.outErr]]) {
      if (numOrNull(a) == null && numOrNull(b) == null) continue;
      const v = (numOrNull(a) ?? 0) + (numOrNull(b) ?? 0);
      if (k === 'drop') drop = (drop ?? 0) + v; else if (k === 'dropDay') dropDay = (dropDay ?? 0) + v; else errDay = (errDay ?? 0) + v;
    }
  }
  for (const u of Array.isArray(uplinks) ? uplinks : []) {
    const i = numOrNull(u?.inBps); const o = numOrNull(u?.outBps);
    if (i == null && o == null) { unmeasured += 1; continue; }
    if (i != null) tx = (tx ?? 0) + i; if (o != null) rx = (rx ?? 0) + o;
    const e = (numOrNull(u?.inErr) ?? 0) + (numOrNull(u?.outErr) ?? 0);
    if (numOrNull(u?.inErr) != null || numOrNull(u?.outErr) != null) err = (err ?? 0) + e;
  }
  return { tx, rx, unmeasured, err, drop, dropDay, errDay };
}

export const SEVERITY_BADGE = Object.freeze({ critical: 'red', error: 'red', warning: 'amber', info: 'gray' });
export const eventTimeText = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
