/**
 * hostNetText.js — 호스트 상세 ‘네트워크’ 카드의 CVP 업링크 열·블록 문구(순수, v2.920 — 시안 D-② HostNet).
 * 서버 /hosts/:id/net-uplinks(cvp/hostMatch.js) 응답을 글자로. 방향은 스위치 포트 기준 — In = 서버 송신 · Out = 서버 수신.
 * 근거 없는 매칭을 만들지 않는다 — 매칭이 없으면 ‘미매칭’ 이고 그 이유(설명에 단서 없음 · CVP 없음)를 말한다.
 */
import { numOrNull } from '../numOrNull.js';

export const BASIS = Object.freeze({
  lldp: { label: '확정', note: 'LLDP 이웃', tone: 'green' },
  endpoint: { label: '확정', note: 'CVP 위치(EndpointLocation) — CVP 가 이 NIC MAC 을 지금 배운 포트', tone: 'green' },   // v2.933(C-③)
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
  // v2.932(점검 A1-03): 범위 계정 + 법인 미지정 vCenter 는 서버가 CVP 를 하나도 싣지 않는다 — '등록된 CVP 가 없다' 가 아니라 그 이유를 말한다.
  if (!d.servers && d.corpMissing) return { text: 'CVP 없음', note: '범위 계정은 자기 법인의 CVP 만 봅니다 — 이 호스트의 vCenter 에 법인이 지정되지 않아 CVP 매칭을 보여 주지 않습니다(설정 › 법인).' };
  if (!d.servers) return { text: 'CVP 없음', note: d.corpLimited || d.hostCorpMatched ? '이 호스트 법인에 등록된 CVP 서버가 없습니다(매칭은 그 호스트 법인의 CVP 만 봅니다 — 법인 · vCenter 1:1).' : '등록된 CVP 서버가 없습니다(특수 기능 › Arista CloudVision).' };
  const ups = Array.isArray(d.uplinks) ? d.uplinks : [];
  const byNic = uplinksByNic(ups);
  const nicN = Array.isArray(nics) ? nics.length : 0;
  const counts = {};
  for (const u of ups) counts[u.basis] = (counts[u.basis] || 0) + 1;
  const basisText = Object.entries(counts).map(([k, n]) => `${basisOf(k).label}(${basisOf(k).note}) ${n}`).join(' · ');
  const l2 = l2Text(d.l2);
  if (!ups.length) return { text: `CVP 매칭 0 / ${nicN} NIC`, note: `LLDP 이웃 · MAC 테이블 · 포트 설명 어디에서도 이 호스트(‘${d.terms?.short || ''}’ · NIC MAC · VM MAC)를 찾지 못했습니다. ${l2}` };
  // v2.924: 인벤토리에 물리 NIC 목록이 없으면 'n / 0 NIC' 대신 매칭한 포트 수로 말한다(Chromium 판독에서 발견).
  const head = nicN ? `CVP 매칭 ${byNic.size} / ${nicN} NIC${ups.length - [...byNic.values()].flat().length ? ` · 호스트 수준 ${hostLevelUplinks(ups).length}` : ''}` : `CVP 매칭 포트 ${ups.length}(인벤토리에 NIC 목록 없음)`;
  return { text: head, note: `${basisText}${d.conflicts?.length ? ` · 충돌 ${d.conflicts.length}(같은 MAC 이 포트 3개 이상)` : ''}${d.truncated ? ' · 후보 상한 초과(일부만)' : ''}${d.termsTruncated ? ' · 찾을 단서가 많아 일부 NIC 의 MAC 은 설명에서 찾지 않음' : ''} · ${l2}` };
}

/**
 * v2.924(B-②): LLDP·MAC 테이블 수집 현황 한 줄 — 근거의 출처를 말한다. 0대면 '수집 전'(엣지 업그레이드 · 부품 주기 30분 · 경로 추정),
 *   조회 실패면 그렇다고. ESXi 는 표준 vSwitch 에서 LLDP 를 보내지 않는다(분산 스위치에서 켜야 한다) — LLDP 가 없다고 연결이 없는 것은 아니다.
 */
export function l2Text(l2, now = Date.now()) {
  if (!l2) return '';
  if (l2.error) return 'LLDP·MAC 테이블을 조회하지 못했습니다.';
  if (l2.unavailable) return 'CVP DB 를 열지 못해 LLDP·MAC 테이블을 볼 수 없습니다.';
  if (!l2.fdbDevices && !l2.lldpDevices) return 'LLDP·MAC 테이블은 아직 수집 전입니다(엣지 v2.924 이상 · 부품 주기 30분 · 텔레메트리 경로는 추정).';
  // v2.924(반증 M-3): 근거가 언제 읽은 값인지 · 마지막 시도가 실패한 스위치 수를 말한다(실패한 스위치의 근거는 오래된 값이다).
  const fail = (Number(l2.lldpFailing) || 0) + (Number(l2.fdbFailing) || 0);
  return `LLDP 를 읽은 스위치 ${l2.lldpDevices}대 · MAC 테이블을 읽은 스위치 ${l2.fdbDevices}대${Number.isFinite(l2.lastAt) ? ` · 최근 ${ageText(l2.lastAt, now)}` : ''}${fail ? ` · 마지막 읽기 실패 ${fail}건(그 스위치의 근거는 오래된 값)` : ''}${l2.fdbTruncated ? ' · MAC 조회 상한 초과(일부만)' : ''}(ESXi 는 분산 스위치에서 LLDP 를 켜야 이웃으로 보입니다).`;
}
/** 경과 시간 글자 — 근거 나이(분 · 시간 · 일). 값이 없으면 ''. */
export function ageText(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return '1분 안';   // v2.925: '0분 전' 이 어색했다(B-② 화면 확인)
  return m < 60 ? `${m}분 전` : m < 48 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}
/** v2.924(반증 M-3): L2 근거가 이만큼 넘게 오래되면 타일에 ‘오래됨’ 을 붙인다(부품 주기 30분 × 6). */
export const L2_STALE_MS = 3 * 3600_000;
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

/**
 * v2.933(C-③): CVP EndpointLocation 현황 한 줄 — 물어본 MAC 수 · 최근 시각 · 미지원 CVP · 대기 중인 요청.
 *   물어본 적이 없으면 그 사실만(‘위치 없음’ 으로 단정하지 않는다).
 */
export function epStatusText(ep, now = Date.now()) {
  if (!ep) return '';
  if (ep.error) return 'CVP 위치(EndpointLocation)를 읽지 못했습니다';
  // v2.933 반증 L-7: DB 를 못 읽은 것을 '아직 안 물음' 으로 말하지 않는다 · L-9: 주기 숫자 · 켜짐은 API 값으로.
  if (ep.unavailable) return 'CVP 위치 — 위치 DB 를 읽지 못했습니다(물어본 적이 없다는 뜻이 아닙니다)';
  const parts = [];
  parts.push(ep.macs ? `CVP 위치 — 물어본 MAC ${ep.macs}개${Number.isFinite(ep.lastAt) ? ` · 최근 ${ageText(ep.lastAt, now)}` : ''}` : `CVP 위치 — 아직 물어보지 않았습니다(${epCycleText(ep)})`);
  if (ep.unsupported) parts.push(`EndpointLocation 미지원 CVP ${ep.unsupported}대(2021.1 이상 필요)`);
  if (ep.pending) parts.push('엣지 조회 요청 대기 중');
  return parts.join(' · ');
}
/** 주기 조회 안내 — 켜짐 · 주기는 서버 값(scan · partsEveryMs). 모르면 숫자를 말하지 않는다. */
export function epCycleText(ep) {
  if (ep?.scan === false) return '주기 조회는 꺼져 있습니다 · 버튼으로 지금';
  const m = Number(ep?.partsEveryMs) > 0 ? Math.round(Number(ep.partsEveryMs) / 60_000) : null;
  return m ? `부품 주기 ${m}분에 차례로 · 버튼으로 지금` : '부품 주기에 차례로 · 버튼으로 지금';
}
/** 지금 조회 결과 문구 — 직접 물은 CVP 결과 · 엣지로 보낸 요청. */
export function epLocateText(r) {
  if (!r) return '';
  if (r.note) return r.note;
  const parts = [];
  for (const d of r.direct || []) parts.push(d.ok ? `${d.name}: 위치 있음 ${d.found ?? 0} · 없음 ${d.none ?? 0}${d.errors ? ` · 오류 ${d.errors}` : ''}${d.unsupported ? ' · 이 CVP 는 EndpointLocation 미지원' : ''}` : `${d.name}: 실패(${d.reason || '사유 미상'})`);
  for (const q of r.queued || []) parts.push(`${q.name}: 담당 엣지 ${q.agent} 에 요청함(다음 설정 pull 때 묻고 결과를 올립니다)`);
  if (!parts.length) parts.push('이 호스트 법인에 물을 CVP 가 없습니다');
  return parts.join(' · ');
}
/** LLDP 와 CVP 위치가 다른 NIC — 둘 다 보여 준다(어느 쪽이 맞는지 정하지 않는다). */
export function epDisagreeText(list = []) {
  return (Array.isArray(list) ? list : []).map((x) => `${x.nic}: LLDP 는 ${x.lldp?.hostname || '?'} ${x.lldp?.port || ''} · CVP 위치는 ${x.endpoint?.hostname || '?'} ${x.endpoint?.port || ''}`);
}

