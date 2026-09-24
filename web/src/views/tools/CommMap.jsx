/**
 * 통신 지도 — 중앙 포탈 ↔ 엣지(수집 서버) 통신을 **라디얼 그래프**로 본다(v2.584).
 *
 * 사용자 요청(2026-09-23, 캡처): "이런 방식으로 메인과 edge 가 통신하는 것을 비주얼하게 보여주는 dashboard".
 * 형태: 중앙 허브(빛나는 코어) → 안쪽 링(엣지, 상태색) → 바깥 링(각 엣지가 위임받은 vCenter·스토리지·
 * SAN·PDU). 허브↔엣지 선은 두 가닥(pull / push)이고 **마지막 두 조회 사이에 관측된 통신**에만 점이 흐른다.
 *
 * 설계:
 *  · 데이터는 `/tools/comm-map` 하나(15초 폴링, 서버 memoJson 12초). 장비·엣지 왕복 0.
 *  · 배치·문구는 순수 모듈(`commMapLayout.js`·`commMapText.js`)이 소유한다 — 이 파일은 조립만 한다.
 *  · 애니메이션은 SVG SMIL(`animateMotion` + `mpath`) — JS 프레임 루프 없음. 허브 맥동은 요소 하나뿐이다.
 *  · 좁은 폭(컨테이너 700px 미만)에서는 바깥 라벨을 끄고 상세 패널을 아래로 내린다(400px 가로 넘침 0).
 *  · 표는 `STable` + `minWidth`(v2.575 규약).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { layoutCommMap, arcPath, labelAnchor } from './commMapLayout.js';
import { rejectKindLabel } from './invCheckText.js'; // v2.599: 거부 종류 코드 → 라벨(unknown-route 포함)
import {
  STATE_LABEL, STATE_COLOR, RES_KIND_LABEL, RES_KIND_ICON, RES_STATE_LABEL, RES_STATE_COLOR,
  PULL_LABEL, PUSH_LABEL, REASON_TEXT, ageText, spanText, bytesText, edgeSummary, resourceSummary,
  headerNote, activityOf, LEGEND_NOTES,
} from './commMapText.js';

const SIZE = 1000;
const PULL_COLOR = { ok: STATE_COLOR.ok, degraded: STATE_COLOR.warn, fail: STATE_COLOR.fail, none: STATE_COLOR.unknown };
const PUSH_COLOR = { ok: STATE_COLOR.ok, stale: STATE_COLOR.warn, rejected: STATE_COLOR.fail, none: STATE_COLOR.unknown };
const TONE_BG = { red: 'rgba(248,113,113,.12)', amber: 'rgba(251,191,36,.12)', green: 'rgba(74,222,128,.10)', muted: 'rgba(148,163,184,.10)' };

/** 한 방향의 흐르는 점 3개 — 관측이 있을 때만 그린다. */
function Particles({ pathId, color, count = 3, dur = 2.4 }) {
  return Array.from({ length: count }, (_, i) => (
    <circle key={i} r={4.2} fill={color} opacity={0.95}>
      <animateMotion dur={`${dur}s`} begin={`${(i * dur) / count}s`} repeatCount="indefinite" rotate="auto">
        <mpath href={`#${pathId}`} />
      </animateMotion>
    </circle>
  ));
}

function Badge({ color, children }) {
  return <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: '#0b1220', background: color, whiteSpace: 'nowrap' }}>{children}</span>;
}

function Row({ k, v }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border)' }}><span className="muted" style={{ fontSize: 12 }}>{k}</span><span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{v}</span></div>;
}

function LinkRow({ label, lk, now }) {
  if (!lk) return <Row k={label} v={<span className="muted">측정 없음</span>} />;
  return <Row k={label} v={<><Badge color={lk.ok ? STATE_COLOR.ok : STATE_COLOR.fail}>{lk.ok ? '정상' : '실패'}</Badge> {lk.ok ? '' : `${lk.phase || ''} ${lk.failKind || ''} `}연속 {lk.streak}회 · {ageText(lk.ts, now)}</>} />;
}

function EdgeDetail({ e, now }) {
  const reasons = (e.reasons || []).map((c) => REASON_TEXT[c] ? { code: c, ...REASON_TEXT[c] } : { code: c, title: c, fix: '' });
  const resRows = [];
  for (const k of ['vcenter', 'storage', 'sanswitch', 'pdu']) for (const r of e.resources?.[k]?.items || []) resRows.push({ ...r, kind: k });
  const omitted = Object.values(e.resources || {}).reduce((s, g) => s + (g?.omitted || 0), 0);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <b style={{ fontSize: 16 }}>{e.name}</b>
        <Badge color={STATE_COLOR[e.state]}>{STATE_LABEL[e.state]}</Badge>
        {e.datacenter && <span className="muted" style={{ fontSize: 12 }}>{e.datacenter}</span>}
        {e.version && <span className="muted" style={{ fontSize: 12 }}>v{e.version}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8, overflowWrap: 'anywhere' }}>{e.origin || '(URL 없음)'}{e.hostname ? ` · ${e.hostname}` : ''}{e.managed ? ' · 수동 고정' : ' · 자기등록'}</div>
      {reasons.length > 0 && (
        <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
          {reasons.map((r) => <li key={r.code} style={{ fontSize: 13, marginBottom: 4 }}><b>{r.title}</b>{r.fix ? <span className="muted"> {r.fix}</span> : null}</li>)}
        </ul>
      )}
      <div style={{ fontWeight: 600, fontSize: 13, margin: '8px 0 2px' }}>중앙 → 엣지 pull</div>
      <Row k="상태" v={<><Badge color={PULL_COLOR[e.pull?.state] || STATE_COLOR.unknown}>{PULL_LABEL[e.pull?.state] || '—'}</Badge>{e.pull?.fails ? ` 연속 실패 ${e.pull.fails}회` : ''}</>} />
      {/* ⚠ 실패 중인 엣지의 `at` 은 마지막 시도가 아니라 **마지막 성공 pull 시각**이다(state.js 가 실패를 직전 상태 위에 덮는다 —
          v2.548 H5). 그 전 성공이 없으면 첫 실패 시각이다. '마지막 pull' 이라 적으면 60초마다 재시도 중인 사실과 어긋난다. */}
      <Row k={e.pull?.state === 'fail' || e.pull?.state === 'degraded' ? '마지막 정상 pull' : '마지막 pull'} v={<>{ageText(e.pull?.at, now)}{(e.pull?.state === 'fail' || e.pull?.state === 'degraded') ? <span className="muted" style={{ fontSize: 11 }}> (그 전 성공이 없으면 첫 실패 시각 · 재시도는 주기마다 계속됩니다)</span> : null}</>} />
      {e.pull?.error && <Row k="사유" v={e.pull.error} />}
      {e.pull?.hosts != null && <Row k="export 호스트" v={`${e.pull.hosts}대`} />}
      {e.pull?.identityIssue?.reason && <Row k="정체" v={e.pull.identityIssue.reason} />}
      <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 2px' }}>엣지 → 중앙 push</div>
      <Row k="상태" v={<Badge color={PUSH_COLOR[e.push?.state] || STATE_COLOR.unknown}>{PUSH_LABEL[e.push?.state] || '—'}</Badge>} />
      <Row k="마지막 수신" v={ageText(e.push?.lastAt, now)} />
      <Row k="수신 누계" v={e.push?.pushes ? `${e.push.pushes}회 · ${bytesText(e.push.wireBytes)}` : '—'} />
      <Row k="평균 간격" v={e.push?.intervalSec != null ? `${spanText(e.push.intervalSec * 1000)} (신선 경계 ${spanText(e.push.freshMs)})` : '—'} />
      {e.push?.rejects && <Row k="거부" v={<>{e.push.rejects.total}건 · 마지막 {ageText(e.push.rejects.lastAt, now)} · {rejectKindLabel(e.push.rejects.lastKind)} {e.push.rejects.lastReason}<div className="muted" style={{ fontSize: 11 }}>거부된 요청의 엣지 이름은 검증되지 않은 값입니다.</div></>} />}
      {e.push?.endpoints?.length > 0 && (
        <STable minWidth={360} style={{ marginTop: 6 }} className="v3-table">
          <thead><tr><th>경로</th><th className="right">횟수</th><th className="right">바이트</th><th>마지막</th></tr></thead>
          <tbody>{e.push.endpoints.map((x) => <tr key={x.endpoint}><td style={{ fontFamily: 'monospace', fontSize: 12 }}>{x.endpoint}</td><td className="right">{x.count}</td><td className="right">{bytesText(x.wireBytes)}</td><td>{ageText(x.lastAt, now)}</td></tr>)}</tbody>
        </STable>
      )}
      <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 2px' }}>통신 점검(v2.552){e.linkCheck?.enabled ? '' : ' · 꺼짐'}</div>
      <LinkRow label="중앙 → 엣지" lk={e.linkCheck?.['central->edge']} now={now} />
      <LinkRow label="엣지 → 중앙 push" lk={e.linkCheck?.['edge->central']} now={now} />
      <LinkRow label="엣지 → 설정 pull" lk={e.linkCheck?.['edge->central-pull']} now={now} />
      {e.linkCheck?.reportAt != null && <Row k="엣지 보고" v={`${ageText(e.linkCheck.reportAt, now)}${e.linkCheck.reportStale ? ' · 오래됨' : ''}`} />}
      <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 2px' }}>위임 자원 {e.resourceCounts?.total ?? 0}개{omitted ? ` (표시 ${resRows.length} · 생략 ${omitted})` : ''}</div>
      {['storage', 'sanswitch', 'pdu'].map((k) => e.reports?.[k] ? <Row key={k} k={`${RES_KIND_LABEL[k]} 보고`} v={`${ageText(e.reports[k].at, now)} · ${e.reports[k].devices}대`} /> : null)}
      {resRows.length > 0 && (
        <STable minWidth={420} style={{ marginTop: 6 }} className="v3-table">
          <thead><tr><th>종류</th><th>이름</th><th>상태</th><th className="right">호스트/VM</th></tr></thead>
          <tbody>{resRows.map((r) => <tr key={`${r.kind}|${r.id}`}><td>{RES_KIND_LABEL[r.kind]}</td><td>{r.name}{r.agentMismatch ? <span className="muted" style={{ fontSize: 11 }}> · 실제 push ‘{r.collectedBy}’</span> : null}</td><td><span style={{ color: RES_STATE_COLOR[r.state] }}>●</span> {RES_STATE_LABEL[r.state] || r.state}</td><td className="right">{r.kind === 'vcenter' ? `${r.hosts ?? '—'} / ${r.vms ?? '—'}` : '—'}</td></tr>)}</tbody>
        </STable>
      )}
    </div>
  );
}

function HubDetail({ data, now }) {
  const d = data.hub?.direct || {};
  const rows = [];
  for (const k of ['vcenter', 'storage', 'sanswitch', 'pdu']) for (const r of d[k]?.items || []) rows.push({ ...r, kind: k });
  const omitted = Object.values(d).reduce((s, g) => s + (g?.omitted || 0), 0);
  return (
    <div>
      <b style={{ fontSize: 16 }}>중앙 포탈</b> <span className="muted" style={{ fontSize: 12 }}>v{data.central?.version}{data.central?.agentName ? ` · ${data.central.agentName}` : ''}</span>
      <Row k="엣지 pull 주기" v={data.hub?.pullerEnabled ? spanText(data.hub.pullIntervalMs) : '꺼짐(0)'} />
      <Row k="push 낡음 경계" v={`${spanText(data.hub?.siteStaleMs)} 또는 관측 push 간격 × ${data.limits?.pushFreshFactor ?? 3} 중 큰 값`} />
      <Row k="수신 누계" v={data.ingest?.totalBytes ? `${bytesText(data.ingest.totalBytes)} (${ageText(data.ingest.since, now)}부터 · ${data.ingest.agents}곳)` : '기록 없음'} />
      <Row k="통신 점검" v={data.hub?.linkCheckEnabled ? '켜짐' : '꺼짐'} />
      <Row k="중앙 토큰" v={data.central?.centralTokenSet ? '설정됨' : '미설정(엣지 push 를 받을 수 없음)'} />
      <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 2px' }}>중앙 직접 수집 자원 {data.hub?.directTotal ?? 0}개{omitted ? ` (표시 ${rows.length} · 생략 ${omitted})` : ''}</div>
      {rows.length > 0 && (
        <STable minWidth={380} style={{ marginTop: 6 }} className="v3-table">
          <thead><tr><th>종류</th><th>이름</th><th>상태</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={`${r.kind}|${r.id}`}><td>{RES_KIND_LABEL[r.kind]}</td><td>{r.name}{r.registryMissing ? <span className="muted" title="등록부(vcenters.json)에 없고 스냅샷에만 있는 vCenter — 목 데이터 폴백이 그렇습니다"> ¹</span> : null}</td><td><span style={{ color: RES_STATE_COLOR[r.state] }}>●</span> {RES_STATE_LABEL[r.state] || r.state}</td></tr>)}</tbody>
        </STable>
      )}
      {rows.some((r) => r.registryMissing) && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>¹ 등록부에 없고 스냅샷에만 있는 vCenter(목 데이터 폴백)입니다.</div>}
    </div>
  );
}

export default function CommMap() {
  const { data, error } = usePolling('/tools/comm-map', {}, 15_000);
  const prevRef = useRef(null);
  const [activity, setActivity] = useState({});
  const [selected, setSelected] = useState({ type: 'hub', id: null });
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(1000);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!data) return;
    setActivity(activityOf(prevRef.current, data));
    prevRef.current = data;
    setNow(Date.now());
  }, [data?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⚠ 래퍼 div 는 데이터가 온 뒤에야 렌더된다(그 전엔 Loading) — 마운트 1회 효과로 붙이면 ref 가 null 이라
  //   관찰이 영영 안 붙고 400px 에서 2열 그리드가 남아 카드가 18px 로 접힌다(v2.584 Chromium 실측). 데이터 유무를 의존성에 둔다.
  const hasData = !!data;
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width) || 1000);
    const ro = new ResizeObserver((es) => { for (const en of es) setWidth(Math.round(en.contentRect.width)); });
    ro.observe(el); return () => ro.disconnect();
  }, [hasData]);

  const layout = useMemo(() => layoutCommMap(data, { size: SIZE }), [data]);
  const compact = width < 700;
  const note = useMemo(() => headerNote(data, now), [data, now]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const by = data.counts?.byState || {};
  const sel = selected.type === 'edge' ? (data.edges || []).find((e) => e.id === selected.id) || null
    : selected.type === 'res' ? layout.resources.find((r) => r.id === selected.id) || null : null;
  const showOuterLabels = !compact && !layout.labelsHidden;
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const fontEdge = compact ? 30 : 21; const fontRes = 15;

  return (
    <div ref={wrapRef} style={{ minWidth: 0 }}>
      <style>{'@keyframes cmGlow{0%,100%{opacity:.55}50%{opacity:1}} .cm-node{cursor:pointer} .cm-node:hover circle{stroke:#fff}'}</style>
      {error && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>마지막 조회 실패: {String(error)} (직전 값을 표시 중)</div>}
      {note.text && <div style={{ background: TONE_BG[note.tone] || TONE_BG.muted, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 }}><BoldText text={note.text} /></div>}
      <div className="kpis" style={{ marginBottom: 10 }}>
        <Kpi label="엣지" value={data.counts?.edges ?? 0} meta={`마지막 조회 ${ageText(data.at, now)}`} />
        <Kpi label="정상" value={by.ok ?? 0} accent={STATE_COLOR.ok} />
        <Kpi label="주의" value={by.warn ?? 0} accent={by.warn ? STATE_COLOR.warn : undefined} />
        <Kpi label="장애" value={by.fail ?? 0} accent={by.fail ? STATE_COLOR.fail : undefined} />
        <Kpi label="확인 불가" value={by.unknown ?? 0} meta="기록 없음(재시작 직후 등)" />
        <Kpi label="위임 자원" value={data.counts?.resources ?? 0} meta={`중앙 직접 ${data.counts?.direct ?? 0} · 미배정 ${data.counts?.unassigned ?? 0}`} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: compact ? 'minmax(0,1fr)' : 'minmax(0,1fr) 380px', gap: 12, minWidth: 0 }}>
        <div className="card" style={{ padding: 8, minWidth: 0, background: 'radial-gradient(circle at 50% 50%, #0f1a33 0%, #0b1220 70%)' }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ display: 'block', maxHeight: compact ? 420 : 760 }} role="img" aria-label="중앙과 엣지의 통신 지도">
            <defs>
              <radialGradient id="cm-hub"><stop offset="0%" stopColor="#e0f2fe" /><stop offset="45%" stopColor="#22d3ee" stopOpacity="0.9" /><stop offset="100%" stopColor="#22d3ee" stopOpacity="0" /></radialGradient>
            </defs>
            <circle cx={layout.cx} cy={layout.cy} r={layout.rEdge} fill="none" stroke="#1e293b" strokeDasharray="4 8" />
            <circle cx={layout.cx} cy={layout.cy} r={layout.rRes} fill="none" stroke="#1e293b" strokeDasharray="4 8" />
            {/* 자원 → 엣지 가는 선 */}
            {layout.resources.map((r) => {
              const o = r.owner === '(central)' ? layout.hub : edgeById.get(r.owner);
              if (!o) return null;
              return <line key={`l|${r.id}`} x1={o.x} y1={o.y} x2={r.x} y2={r.y} stroke={RES_STATE_COLOR[r.state] || '#64748b'} strokeOpacity={0.35} strokeWidth={1.2} />;
            })}
            {layout.more.map((m) => { const o = m.owner === '(central)' ? layout.hub : edgeById.get(m.owner); return o ? <line key={`lm|${m.owner}`} x1={o.x} y1={o.y} x2={m.x} y2={m.y} stroke="#64748b" strokeOpacity={0.3} strokeDasharray="3 5" /> : null; })}
            {/* 허브 ↔ 엣지 두 가닥 */}
            {layout.edges.map((e) => {
              const raw = e.raw; const act = activity[e.id] || {};
              const pullId = `cm-pull-${e.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`; const pushId = `cm-push-${e.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
              const pullC = raw.enabled === false ? STATE_COLOR.disabled : (PULL_COLOR[raw.pull?.state] || STATE_COLOR.unknown);
              const pushC = raw.enabled === false ? STATE_COLOR.disabled : (PUSH_COLOR[raw.push?.state] || STATE_COLOR.unknown);
              return (
                <g key={`p|${e.id}`}>
                  <path id={pullId} d={arcPath(layout.hub.x, layout.hub.y, e.x, e.y, 0.07)} fill="none" stroke={pullC} strokeWidth={raw.pull?.state === 'none' ? 1 : 2} strokeOpacity={0.7} strokeDasharray={raw.pull?.state === 'none' ? '2 6' : undefined} />
                  <path id={pushId} d={arcPath(e.x, e.y, layout.hub.x, layout.hub.y, 0.07)} fill="none" stroke={pushC} strokeWidth={raw.push?.state === 'none' ? 1 : 2} strokeOpacity={0.7} strokeDasharray={raw.push?.state === 'none' ? '2 6' : undefined} />
                  {act.pull && <Particles pathId={pullId} color={pullC} />}
                  {act.push && <Particles pathId={pushId} color={pushC} />}
                </g>
              );
            })}
            {/* 허브 */}
            <g className="cm-node" onClick={() => setSelected({ type: 'hub', id: null })} role="button" tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') setSelected({ type: 'hub', id: null }); }}>
              <circle cx={layout.hub.x} cy={layout.hub.y} r={layout.hub.r * 1.9} fill="url(#cm-hub)" style={{ animation: 'cmGlow 3s ease-in-out infinite' }} />
              <circle cx={layout.hub.x} cy={layout.hub.y} r={layout.hub.r} fill="#0b1220" stroke={selected.type === 'hub' ? '#fff' : '#67e8f9'} strokeWidth={3} />
              <text x={layout.hub.x} y={layout.hub.y - 6} textAnchor="middle" fill="#e2e8f0" fontSize={26} fontWeight={700}>중앙</text>
              <text x={layout.hub.x} y={layout.hub.y + 22} textAnchor="middle" fill="#94a3b8" fontSize={17}>v{data.central?.version}</text>
              <title>중앙 포탈 v{data.central?.version} · 직접 수집 자원 {data.hub?.directTotal ?? 0}개 · 클릭하면 상세</title>
            </g>
            {layout.directSector && (
              <text x={layout.cx + Math.cos(layout.directSector.angle) * (layout.rRes - 46)} y={layout.cy + Math.sin(layout.directSector.angle) * (layout.rRes - 46)} textAnchor="middle" fill="#7dd3fc" fontSize={fontRes + 2}>중앙 직접 {layout.directSector.count}{layout.directSector.omitted ? `+${layout.directSector.omitted}` : ''}</text>
            )}
            {/* 바깥 링 자원 */}
            {layout.resources.map((r) => (
              <g key={r.id} className="cm-node" onClick={() => setSelected({ type: 'res', id: r.id })}>
                <circle cx={r.x} cy={r.y} r={selected.id === r.id ? 9 : 6.5} fill={RES_STATE_COLOR[r.state] || '#64748b'} stroke="#0b1220" strokeWidth={1.5} />
                {showOuterLabels && <text x={r.x + Math.cos(r.angle) * 14} y={r.y + Math.sin(r.angle) * 14 + 5} textAnchor={labelAnchor(r.angle)} fill="#cbd5e1" fontSize={fontRes}>{RES_KIND_ICON[r.kind]} {r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name}</text>}
                <title>{resourceSummary(r.raw, now)}</title>
              </g>
            ))}
            {layout.more.map((m) => (
              <g key={`m|${m.owner}`}>
                <circle cx={m.x} cy={m.y} r={9} fill="#334155" stroke="#94a3b8" />
                <text x={m.x} y={m.y + 4} textAnchor="middle" fill="#e2e8f0" fontSize={11}>+{m.count}</text>
                <title>표시 상한을 넘은 자원 {m.count}개 — 노드를 눌러 상세에서 개수를 보세요</title>
              </g>
            ))}
            {/* 안쪽 링 엣지 */}
            {layout.edges.map((e) => (
              <g key={e.id} className="cm-node" onClick={() => setSelected({ type: 'edge', id: e.id })} role="button" tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') setSelected({ type: 'edge', id: e.id }); }}>
                <circle cx={e.x} cy={e.y} r={selected.id === e.id ? 19 : 15} fill={STATE_COLOR[e.state] || STATE_COLOR.unknown} stroke={selected.id === e.id ? '#fff' : '#0b1220'} strokeWidth={3} />
                <text x={e.x + Math.cos(e.angle) * 26} y={e.y + Math.sin(e.angle) * 26 + 7} textAnchor={labelAnchor(e.angle)} fill="#f1f5f9" fontSize={fontEdge} fontWeight={600}>{e.name}</text>
                <title>{edgeSummary(e.raw, now)}</title>
              </g>
            ))}
          </svg>
          {(layout.labelsHidden || compact) && <div className="muted" style={{ fontSize: 11, padding: '4px 6px' }}>바깥 링 라벨은 {compact ? '좁은 화면이라 ' : `노드가 ${layout.outerCount}개라 겹쳐서`}숨겼습니다 — 노드를 누르거나 마우스를 올리면 이름이 보입니다.</div>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '6px 6px 2px', fontSize: 12 }}>
            {Object.keys(STATE_LABEL).map((k) => <span key={k}><span style={{ color: STATE_COLOR[k] }}>●</span> {STATE_LABEL[k]}</span>)}
            <span className="muted">|</span>
            {['vcenter', 'storage', 'sanswitch', 'pdu'].map((k) => <span key={k} className="muted">{RES_KIND_ICON[k]} {RES_KIND_LABEL[k]}</span>)}
          </div>
        </div>
        <div className="card" style={{ padding: 12, minWidth: 0, overflowX: 'auto' }}>
          {selected.type === 'edge' && sel ? <EdgeDetail e={sel} now={now} />
            : selected.type === 'res' && sel ? (
              <div>
                <b style={{ fontSize: 15 }}>{RES_KIND_LABEL[sel.kind]} · {sel.name}</b>
                <Row k="상태" v={<><span style={{ color: RES_STATE_COLOR[sel.state] }}>●</span> {RES_STATE_LABEL[sel.state] || sel.state}</>} />
                <Row k="담당" v={sel.owner === '(central)' ? '중앙 직접 수집' : `엣지 ${edgeById.get(sel.owner)?.name || sel.owner}`} />
                {sel.raw?.kind === 'vcenter' && <>
                  <Row k="마지막 수신" v={ageText(sel.raw.receivedAt, now)} />
                  <Row k="호스트 / VM" v={`${sel.raw.hosts ?? '—'} / ${sel.raw.vms ?? '—'}`} />
                  {sel.raw.error && <Row k="오류" v={sel.raw.error} />}
                  {sel.raw.agentMismatch && <Row k="담당 불일치" v={`등록 ‘${sel.raw.remoteAgent}’ · 실제 push ‘${sel.raw.collectedBy}’`} />}
                </>}
                {sel.raw?.type && <Row k="타입" v={sel.raw.type} />}
                {sel.raw?.kind !== 'vcenter' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>장비 상태는 등록부 기준입니다 — 수집 성패는 해당 모니터링 화면에서 보세요.</div>}
              </div>
            ) : <HubDetail data={data} now={now} />}
        </div>
      </div>
      {data.unassigned?.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>담당 엣지를 알 수 없는 자원 {data.unassigned.length}개</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>등록부의 어느 엣지와도 이름이 맞지 않거나 담당이 비어 있습니다. 그래프에 지어낸 노드를 붙이지 않았습니다.</div>
          <STable minWidth={520} className="v3-table">
            <thead><tr><th>종류</th><th>이름</th><th>기록된 담당</th><th>사유</th></tr></thead>
            <tbody>{data.unassigned.map((u) => <tr key={`${u.kind}|${u.id}`}><td>{RES_KIND_LABEL[u.kind] || u.kind}</td><td>{u.name}</td><td>{u.agent || '(비어 있음)'}</td><td>{u.reason === 'agent-empty' ? 'collectMode=site 인데 담당 엣지가 비어 있습니다' : '등록부에 없는 엣지 이름입니다(이름 변경·삭제)'}</td></tr>)}</tbody>
          </STable>
        </div>
      )}
      {data.sourceErrors?.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>읽지 못한 원천: {data.sourceErrors.map((s) => `${s.source}(${s.error})`).join(', ')}</div>}
      <ul className="muted" style={{ fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
        {LEGEND_NOTES.map((n, i) => <li key={i}><BoldText text={n} /></li>)}
      </ul>
    </div>
  );
}
