/**
 * views/tools/cvpOverviewText.js — CVP Overview·모델·트래픽·법인 칩의 판정·문구(순수 · v2.645).
 *
 * 서버 `/tools/cvp/overview`(cvp/overview.js)가 집계를 주고, 여기서는 **그리는 모양**만 만든다(판정 복제 금지).
 *  · '확인 불가' 는 정상에도 이상에도 넣지 않는다 — 비율의 분모는 전체 대수이고, 확인 불가를 따로 말한다.
 *  · 법인 = CVP 서버에 지정한 DataCenter(장비 단위가 아니다) — CORP_NOTE 가 그 사실을 말한다.
 *  · 트래픽 합은 마지막 수집의 **순간값** 합이다(평균이 아니다) — TRAFFIC_NOTE.
 *  · 문구에 백틱 금지(BoldText 는 굵게만 해석한다).
 */
import { numOrNull } from '../../numOrNull.js';
import { spanText, countText, bpsText } from './cvpText.js';

export const HEALTH_KEYS = ['ok', 'warn', 'bad', 'unknown'];
export const HEALTH_LABEL = { ok: '정상', warn: '주의', bad: '장애', unknown: '확인 불가' };
export const HEALTH_COLOR = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', unknown: 'var(--text-dim)' };
export const UNKNOWN_REASON_LABEL = { never: '받은 적 없음', stale: '오래된 수집', 'not-streaming': '스트리밍 아님', unread: '읽은 항목 없음' };
export const UNASSIGNED_LABEL = '법인 미지정';

export const CORP_NOTE = '법인은 **그 장비를 수집하는 CVP 서버에 지정한 DataCenter** 입니다. 한 CVP 가 여러 법인의 장비를 관리하면 전부 그 법인으로 보입니다(장비 단위 법인 정보는 CVP 응답에 없습니다).';
export const TRAFFIC_NOTE = '링크가 올라온 포트의 수신·송신 처리량을 **마지막 수집 순간값**으로 더했습니다(평균이 아닙니다). 스위치끼리 연결된 링크는 **양쪽 스위치에서 모두** 세어지므로 법인 밖으로 나간 양이 아니라 법인 장비가 처리한 총량입니다. 처리량이 오래됐거나 없는 포트는 합에서 빼고 개수를 밝힙니다.';

/** 법인 표시명 — 미지정은 '법인 미지정', 삭제된 DataCenter 는 id 뒤에 (삭제됨). */
export function corpLabel(c) {
  const o = c && typeof c === 'object' ? c : {};
  if (!o.corpId) return UNASSIGNED_LABEL;
  return `${o.corpName || o.corpId}${o.missing ? ' (삭제된 DataCenter)' : ''}`;
}

/** 관리 상태 링(r=60). 분모는 전체 대수(확인 불가 포함). 장비 0대면 pct null. */
export function healthRing(health, r = 60) {
  const h = health && typeof health === 'object' ? health : {};
  const n = (k) => Math.max(0, numOrNull(h[k]) ?? 0);
  const total = HEALTH_KEYS.reduce((s, k) => s + n(k), 0);
  const C = 2 * Math.PI * r;
  let off = 0;
  const segs = [];
  for (const k of HEALTH_KEYS) {
    const len = total ? (n(k) / total) * C : 0;
    if (len > 0) segs.push({ key: k, color: HEALTH_COLOR[k], dash: `${len} ${C}`, offset: -off });
    off += len;
  }
  return { total, okPct: total ? Math.round((n('ok') / total) * 100) : null, segs, C };
}

/** 링 아래 한 줄 — 몇 대를 지금 값으로 확인했고, 확인 불가를 왜 정상에 넣지 않았는지. */
export function healthNote(totals) {
  const t = totals && typeof totals === 'object' ? totals : {};
  const h = t.health || {};
  const total = numOrNull(t.devices) ?? 0;
  if (!total) return '아직 수집된 장비가 없습니다.';
  const known = total - (numOrNull(h.unknown) ?? 0);
  const unk = numOrNull(h.unknown) ?? 0;
  const by = t.unknownBy && typeof t.unknownBy === 'object' ? t.unknownBy : {};
  const parts = Object.entries(by).filter(([, v]) => numOrNull(v) > 0).map(([k, v]) => `${UNKNOWN_REASON_LABEL[k] || k} ${countText(v)}`);
  let s = `전체 ${countText(total)}대 중 ${countText(known)}대를 지금 값으로 확인했습니다.`;
  if (unk > 0) s += ` 확인 불가 ${countText(unk)}대(${parts.join(' · ')})는 정상에 넣지 않았습니다.`;
  const partial = numOrNull(t.partial) ?? 0;
  if (partial > 0) s += ` 일부 항목만 읽은 장비 ${countText(partial)}대는 읽은 항목 기준으로 판정했습니다.`;
  return s;
}

/** KPI 칸 6개. 값을 모르면 '—' 이고 경고색을 칠하지 않는다(0 을 경고색으로 칠하지 않는다). */
export function overviewKpis(ov) {
  const o = ov && typeof ov === 'object' ? ov : {};
  const t = o.totals || {};
  const ev = o.events || {};
  const n = (v) => numOrNull(v);
  const tone = (v, bad) => (n(v) > 0 ? bad : null);
  const errs = (n(ev.error) ?? 0) + (n(ev.critical) ?? 0);
  const devs = n(t.devices) ?? 0;
  return [
    { key: 'faults', label: '열린 장애', value: countText(t.openFaults), unit: '건', tone: tone(t.openFaultsFault, 'bad') || tone(t.openFaultsWarn, 'warn'),
      sub: `장애 ${countText(t.openFaultsFault)} · 주의 ${countText(t.openFaultsWarn)} · 전이 기록 기준`, go: 'devices' },
    { key: 'ports', label: '내려간 포트', value: countText(t.portsDown), unit: '개', tone: tone(t.portsDown, 'warn'),
      sub: n(t.portsUnreadDevices) > 0 ? `켜져 있는데 링크 없음 · 포트를 못 읽은 장비 ${countText(t.portsUnreadDevices)}대 제외` : '켜져 있는데 링크가 없는 포트', go: 'ports' },
    { key: 'bgp', label: 'BGP 끊김', value: countText(t.bgpDown), unit: `/ ${countText(t.bgpPeers)} 피어`, tone: tone(t.bgpDown, 'bad'),
      sub: [n(t.bgpStateUnknown) > 0 ? `상태 모름 ${countText(t.bgpStateUnknown)}` : '', n(t.bgpUnreadDevices) > 0 ? `BGP 를 못 읽은 장비 ${countText(t.bgpUnreadDevices)}대` : ''].filter(Boolean).join(' · ') || 'Established 가 아닌 피어', go: 'devices' },
    { key: 'stream', label: '스트리밍', value: countText(t.streaming), unit: `/ ${countText(devs)}대`, tone: n(t.notStreaming) > 0 ? 'warn' : null,
      sub: `스트리밍 아님 ${countText(t.notStreaming)}${n(t.streamingUnknown) > 0 ? ` · 모름 ${countText(t.streamingUnknown)}` : ''}`, go: 'devices' },
    { key: 'events', label: '이벤트(24시간)', value: countText(errs), unit: '오류', tone: errs > 0 ? 'bad' : null,
      sub: `경고 ${countText(ev.warning)}${ev.truncated ? ' · 최근 2,000건만 셌습니다' : ''}`, go: 'events' },
    { key: 'eol', label: '지원 종료 지남', value: n(t.lifecycleRead) > 0 ? countText(t.swEolPassed) : '—', unit: n(t.lifecycleRead) > 0 ? '대' : '',
      tone: tone(t.swEolPassed, 'warn'),
      sub: n(t.lifecycleRead) > 0 ? `수명주기 정보를 읽은 ${countText(t.lifecycleRead)}대 기준(EOS 지원 종료)` : '수명주기 정보를 읽은 장비가 없습니다 — 지원 상태를 지어내지 않습니다', go: 'models' },
  ];
}

/** 법인 카드 — 이름순(서버가 정렬, 미지정 맨 뒤). 점 색은 가장 나쁜 판정, 전부 확인 불가면 회색. */
export function corpCards(corps) {
  return (Array.isArray(corps) ? corps : []).filter((c) => c && typeof c === 'object').map((c) => {
    const h = c.health || {};
    const n = (k) => Math.max(0, numOrNull(h[k]) ?? 0);
    const total = numOrNull(c.devices) ?? 0;
    const pct = (k) => (total ? `${(n(k) / total) * 100}%` : '0%');
    const tone = n('bad') > 0 ? 'bad' : n('warn') > 0 ? 'warn' : n('ok') > 0 ? 'ok' : 'unknown';
    const bits = [];
    if (n('bad')) bits.push(`장애 ${n('bad')}`);
    if (n('warn')) bits.push(`주의 ${n('warn')}`);
    if (n('unknown')) bits.push(`확인 불가 ${n('unknown')}`);
    const note = total === 0 ? '장비 없음(장애·이벤트만 있음)' : bits.length ? bits.join(' · ') : '모두 정상';
    return {
      corpId: c.corpId ?? '', name: corpLabel(c), count: total, tone, dot: HEALTH_COLOR[tone],
      okPct: pct('ok'), warnPct: pct('warn'), badPct: pct('bad'), unknownPct: pct('unknown'), note,
      cvps: Array.isArray(c.cvps) ? c.cvps : [],
    };
  });
}

/** 모델 막대 — 가장 많은 모델을 100% 로. 모델 문자열이 없으면 '(모델 미상)'. */
export function modelBars(models, max = 6) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && typeof m === 'object');
  const top = Math.max(1, ...list.map((m) => numOrNull(m.count) ?? 0));
  return list.slice(0, max).map((m) => ({
    model: m.model || '', name: m.model || '(모델 미상)', count: numOrNull(m.count) ?? 0,
    pct: `${Math.round(((numOrNull(m.count) ?? 0) / top) * 100)}%`, split: Array.isArray(m.versions) && m.versions.length > 1,
  }));
}

/**
 * EOS 버전 행 — 같은 모델 안에서 버전이 갈린 버전을 먼저. 태그는 '버전 갈림' 또는 'N개 모델'.
 * 권장·지원 종료 같은 벤더 상태는 지어내지 않는다.
 */
export function versionRows(ov, max = 6) {
  const o = ov && typeof ov === 'object' ? ov : {};
  const split = new Set((Array.isArray(o.models) ? o.models : []).filter((m) => Array.isArray(m?.versions) && m.versions.length > 1).map((m) => m.model));
  const rows = (Array.isArray(o.versions) ? o.versions : []).filter((v) => v && typeof v === 'object').map((v) => {
    const models = Array.isArray(v.models) ? v.models : [];
    const splitIn = models.filter((m) => split.has(m));
    return {
      version: v.version || '', name: v.version || '(버전 미상)', count: numOrNull(v.count) ?? 0,
      split: splitIn.length > 0, tag: splitIn.length ? '버전 갈림' : `${models.length}개 모델`,
      title: splitIn.length ? `같은 모델에 다른 버전이 섞여 있습니다: ${splitIn.map((m) => m || '(모델 미상)').join(', ')}` : models.map((m) => m || '(모델 미상)').join(', '),
    };
  });
  rows.sort((a, b) => (Number(b.split) - Number(a.split)) || (b.count - a.count));
  return rows.slice(0, max);
}

/** 모델 화면 표 — 모델 × 버전(대수) · 법인 수 · 판정 분포. */
export function modelTableRows(models) {
  return (Array.isArray(models) ? models : []).filter((m) => m && typeof m === 'object').map((m) => {
    const vs = Array.isArray(m.versions) ? m.versions : [];
    return {
      model: m.model || '', name: m.model || '(모델 미상)', count: numOrNull(m.count) ?? 0, corps: numOrNull(m.corps) ?? 0,
      health: m.health || {}, versionCount: vs.length,
      versionsText: vs.map((v) => `${v.version || '(미상)'} ${countText(v.count)}대`).join(' · ') || '—',
    };
  });
}

/** 신선도 3칸(주기에서 나온 경계 — 숫자를 박지 않는다). */
export function freshnessRows(freshness) {
  const f = freshness && typeof freshness === 'object' ? freshness : {};
  const n = (k) => Math.max(0, numOrNull(f[k]) ?? 0);
  const total = n('fresh') + n('late') + n('stale') + n('never');
  const pct = (v) => (total ? `${(v / total) * 100}%` : '0%');
  const a = spanText(f.freshMs); const b = spanText(f.staleMs);
  return {
    total,
    rows: [
      { key: 'fresh', label: `${a} 이내`, count: n('fresh'), pct: pct(n('fresh')), color: 'var(--green)' },
      { key: 'late', label: `${a} ~ ${b}`, count: n('late'), pct: pct(n('late')), color: 'var(--amber)' },
      { key: 'old', label: `${b} 넘음 · 받은 적 없음`, count: n('stale') + n('never'), pct: pct(n('stale') + n('never')), color: 'var(--text-dim)' },
    ],
    note: n('stale') + n('never') > 0 ? `${b} 넘은 장비 ${countText(n('stale') + n('never'))}대는 '확인 불가' 로 세고 정상에 넣지 않았습니다.` : '',
  };
}

/** 법인별 트래픽 행 — 합(수신+송신) 큰 순. 측정 포트가 0 인 법인의 합은 '—'(0 bps 가 아니다). */
export function trafficRows(corps) {
  const rows = (Array.isArray(corps) ? corps : []).filter((c) => c && typeof c === 'object').map((c) => {
    const t = c.traffic || {};
    const measured = numOrNull(t.portsMeasured) ?? 0;
    const inB = measured > 0 ? numOrNull(t.inBps) : null;
    const outB = measured > 0 ? numOrNull(t.outBps) : null;
    const sum = inB == null && outB == null ? null : (inB ?? 0) + (outB ?? 0);
    const unmeasured = numOrNull(t.portsUnmeasured) ?? 0;
    const notes = [];
    if (measured > 0) notes.push(`측정 포트 ${countText(measured)}개`);
    if (unmeasured > 0) notes.push(`처리량 없음 ${countText(unmeasured)}개 제외`);
    if (numOrNull(t.devicesUnmeasured) > 0) notes.push(`장비 ${countText(t.devicesUnmeasured)}대 미측정`);
    return {
      corpId: c.corpId ?? '', name: corpLabel(c), inBps: inB, outBps: outB, sum,
      inText: bpsText(inB), outText: bpsText(outB), sumText: bpsText(sum),
      note: notes.join(' · ') || '측정된 포트 없음', partial: unmeasured > 0,
      top: Array.isArray(t.top) ? t.top : [],
    };
  });
  rows.sort((a, b) => (b.sum ?? -1) - (a.sum ?? -1) || a.name.localeCompare(b.name, 'ko'));
  const max = Math.max(0, ...rows.map((r) => r.sum ?? 0));
  for (const r of rows) r.pct = max > 0 && r.sum != null ? `${(r.sum / max) * 100}%` : '0%';
  return rows;
}

/**
 * 장비 목록 필터(법인 × 모델) — deviceFacets.facetState 에 넘길 행 모양으로 바꾼다(`datacenterId`·`type`).
 * 법인 칩 이름이 곧 필터 키이므로 표시명(corpLabel)을 쓴다.
 */
export function facetRowsOf(devices) {
  return (Array.isArray(devices) ? devices : []).filter((d) => d && typeof d === 'object')
    .map((d) => ({ ...d, datacenterId: d.corpId ?? '', type: d.model || '' }));
}
export function corpNameFn(devices) {
  const m = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    if (d && typeof d === 'object') m.set(d.corpId ?? '', corpLabel({ corpId: d.corpId, corpName: d.corpName, missing: d.corpMissing }));
  }
  return (id) => m.get(id ?? '') || (id ? String(id) : UNASSIGNED_LABEL);
}
export const modelLabel = (t) => t || '(모델 미상)';
/** v2.652: 버전 축 — 장비가 보고한 EOS 버전. 읽지 못한 장비는 '(버전 미상)' 한 칸(지어내지 않는다). */
export const eosVersionOf = (d) => (d && typeof d === 'object' && typeof d.eosVersion === 'string' ? d.eosVersion.trim() : '');
export const versionLabel = (v) => v || '(버전 미상)';

/**
 * v2.656: CVP 서버 버전 — 장비가 속한 **CVP 서버**(cvpId)의 버전이다. 장비 자신의 EOS 버전과 다르다(한 CVP 가 여러 EOS 를 관리).
 * 서버 상태의 cvpVersion(getCvpInfo)을 cvpId 로 붙인다. 못 읽었으면 '' — 지어내지 않는다.
 */
export function cvpServerVersionMap(servers) {
  const m = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object' || s.id == null) continue;
    const v = s.status && typeof s.status === 'object' && typeof s.status.cvpVersion === 'string' ? s.status.cvpVersion.trim() : '';
    m.set(String(s.id), v);
  }
  return m;
}
export const cvpServerVersionOf = (d, map) => (d && typeof d === 'object' && map instanceof Map ? (map.get(String(d.cvpId ?? '')) || '') : '');
export const cvpVersionLabel = (v) => v || '(CVP 버전 미상)';
/** CVP 버전 칩 — 개수는 호출자가 넘긴 집합(다른 축만 적용한 것) 기준. 칩이 하나뿐이면 가를 것이 없어 빈 배열. */
export function cvpVersionChips(rows, map) {
  const by = new Map();
  for (const d of Array.isArray(rows) ? rows : []) { const v = cvpServerVersionOf(d, map); by.set(v, (by.get(v) || 0) + 1); }
  const out = [...by.entries()].map(([ver, count]) => ({ ver, count }))
    .sort((a, b) => (a.ver === '') - (b.ver === '') || b.ver.localeCompare(a.ver, undefined, { numeric: true }));
  return out.length > 1 ? out : [];
}

/**
 * 이벤트 화면의 두 축(v2.646 사용자 요청 — '법인: AZ WA … / 이벤트: 경고 오류' 를 **따로** 고른다. 한 칩에 둘을 묶지 않는다).
 *  · SEV_GROUPS: '' 전체 · errors(critical+error) · warning · info. 서버 severity 파라미터와 같은 값이다.
 *  · 법인 칩의 개수는 **고른 이벤트 종류** 기준, 이벤트 칩의 개수는 **고른 법인** 기준(서버 counts 가 법인 필터 뒤 값) — 규칙 ②.
 */
export const SEV_GROUPS = Object.freeze([
  { key: '', label: '전체', sev: null },
  { key: 'errors', label: '오류', sev: ['critical', 'error'] },
  { key: 'warning', label: '경고', sev: ['warning'] },
  { key: 'info', label: '정보', sev: ['info'] },
]);
const sevCount = (by, key) => {
  const g = SEV_GROUPS.find((x) => x.key === key) || SEV_GROUPS[0];
  const o = by && typeof by === 'object' ? by : {};
  if (!g.sev) return Object.values(o).reduce((a, v) => a + (numOrNull(v) ?? 0), 0);
  return g.sev.reduce((a, k) => a + (numOrNull(o[k]) ?? 0), 0);
};
/** 법인 칩 — 이름순, 미지정 맨 뒤. count = 고른 이벤트 종류의 개수. */
export function eventCorpChips(corpCounts, sevKey = '') {
  const list = (Array.isArray(corpCounts) ? corpCounts : []).filter((c) => c && typeof c === 'object').map((c) => {
    const by = c.bySeverity && typeof c.bySeverity === 'object' ? c.bySeverity : {};
    const errors = sevCount(by, 'errors'); const warnings = sevCount(by, 'warning');
    return { corpId: c.corpId ?? '', name: corpLabel(c), count: sevCount(by, sevKey), errors, warnings, tone: errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'muted' };
  });
  list.sort((a, b) => (a.corpId === '' ? 1 : 0) - (b.corpId === '' ? 1 : 0) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  return list;
}
/** 이벤트 종류 칩 — counts(심각도별, 고른 법인 기준). 정보는 개수가 있거나 골랐을 때만. */
export function eventSevChips(counts, sevKey = '') {
  return SEV_GROUPS.map((g) => ({ key: g.key, label: g.label, count: sevCount(counts, g.key), tone: g.key === 'errors' ? 'bad' : g.key === 'warning' ? 'warn' : 'muted' }))
    .filter((c) => c.key !== 'info' || c.count > 0 || sevKey === 'info');
}

/** 장비 상세 요약 칸(판정은 서버 값 그대로 — 여기서는 모양만). */
export function deviceSummaryTiles(det) {
  const d = det && typeof det === 'object' ? det : {};
  const dev = d.device || {};
  const h = d.history || {};
  const open = Array.isArray(h.openFaults) ? h.openFaults : [];
  const fault = open.filter((f) => f.state === 'fault').length;
  const ev = Array.isArray(h.events) ? h.events : [];
  const errs = ev.filter((e) => e.severity === 'error' || e.severity === 'critical').length;
  const ports = dev.ports && typeof dev.ports === 'object' ? dev.ports : null;
  return [
    { key: 'faults', label: '열린 장애', value: h.unavailable ? '—' : countText(open.length), tone: fault ? 'bad' : open.length ? 'warn' : null },
    { key: 'ports', label: '내려간 포트', value: ports ? countText(ports.down) : '—', tone: ports && numOrNull(ports.down) > 0 ? 'warn' : null },
    { key: 'events', label: `이벤트(${h.eventDays || 7}일)`, value: h.unavailable ? '—' : countText(ev.length), tone: errs ? 'bad' : null,
      sub: errs ? `오류 ${errs}` : '' },
  ];
}

/** 장비 이력 탭의 각주 — 잘린 개수·조회 범위(조용한 상한 금지). */
export function historyNotes(h) {
  const o = h && typeof h === 'object' ? h : {};
  const out = [];
  if (o.unavailable) out.push('중앙 CVP DB 를 일부 읽지 못했습니다 — 아래 목록이 전부가 아닐 수 있습니다.');
  if (numOrNull(o.faultEventsOmitted) > 0) out.push(`장애 전이는 최근 100건만 보입니다(${countText(o.faultEventsOmitted)}건 생략).`);
  if (numOrNull(o.eventsOmitted) > 0) out.push(`이벤트는 최근 100건만 보입니다(${countText(o.eventsOmitted)}건 생략).`);
  if (o.eventsScanTruncated) out.push(`이 CVP 의 최근 이벤트 2,000건 안에서 이 장비를 골랐습니다 — ${o.eventDays || 7}일 전부를 본 것이 아닙니다.`);
  return out;
}
