// IpamNet.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { DEVTYPE_LABEL, fmtDt, MGMT, MgmtBadge } from './ipamShared.jsx';
import { policySpecSize } from './ipmsRangeText.js';
import { Card } from './shared.jsx';
import { STable } from '../../components/STable.jsx';


// v2.691: 'vCenter별 IP 대역 저장 + 주기 스캔' 페이지(IpamRanges)는 지웠다 — 스캔 대역·설정(IpScanSettings)으로 합쳐졌다.

// 기간별 버킷 수/단위(v2.361, 사용자 요구) — '최근에 언제 사용했는지'를 직관적으로:
//  1일→24칸(1시간) · 7일→7칸(1일) · 30일→30칸(1일) · 90일→9칸(10일) · 365일→12칸(1개월).
// 서버 netmap 은 buckets 파라미터를 그대로 받아 span/N 로 균등 분할한다(추가 서버 변경 없음).
const BUCKETS_FOR = { 1: 24, 7: 7, 30: 30, 90: 9, 365: 12 };
const UNIT_FOR = { 1: '1시간', 7: '1일', 30: '1일', 90: '10일', 365: '1개월' };
const bucketsFor = (d) => BUCKETS_FOR[d] || 30;
const unitFor = (d) => UNIT_FOR[d] || '구간';

// 버킷 중앙시각 → 기간 granularity 에 맞춘 짧은 라벨.
function fmtBucketTick(ts, days) {
  if (!ts) return '';
  const d = new Date(ts);
  if (days <= 1) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });      // 시:분
  if (days <= 90) return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });         // 월/일
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'short' });                          // 년-월
}
// '오늘 기준 며칠 전' — 마지막 사용을 한눈에.
function agoLabel(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const day = 86_400_000;
  if (diff < day) { const h = Math.floor(diff / 3_600_000); return h <= 0 ? '방금' : `${h}시간 전`; }
  return `${Math.floor(diff / day)}일 전`;
}
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—');

/** 네트워크 맵 — 대역(/24) 선택 시 OS별(색) × 시간대별(타임 슬라이더) 사용/미사용 격자. */
export function IpamNetMap() {
  const [vcs, setVcs] = useState([]);
  const [vc, setVc] = useState('');
  const [base, setBase] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [bucket, setBucket] = useState(null); // null = 최신
  const [sel, setSel] = useState(null);
  useEffect(() => { fetchJson('/tools/ipam/vc-ranges').then((d) => setVcs(d.vcenters || [])).catch(() => {}); }, []);
  useEffect(() => {
    let active = true; // 필터 연타 시 늦은 응답이 최신 선택을 덮어쓰거나 stale base로 되돌리는 것 방지
    const qs = new URLSearchParams();
    if (vc) qs.set('vcenterId', vc); if (base) qs.set('base', base); qs.set('days', String(days)); qs.set('buckets', String(bucketsFor(days)));
    fetchJson(`/tools/ipam/netmap?${qs.toString()}`).then((d) => { if (!active) return; setData(d); setError(null); setSel(null); if (!base && d.base) setBase(d.base); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
    // eslint-disable-next-line
  }, [vc, base, days]);
  if (error && !data) return <ErrorBox message={error} />; // v2.478(감사 B15): 데이터 보유 중 일시 오류는 화면 유지(아래 배너)
  if (!data) return <Loading />;
  const N = data.buckets?.length || 0;
  const bi = bucket == null ? Math.max(0, N - 1) : Math.min(bucket, N - 1);
  const cellStyle = (cell) => {
    const st = cell.states?.[bi];
    if (!cell.present) return { background: 'rgba(148,163,184,.07)', border: '1px solid rgba(148,163,184,.13)' };
    const c = cell.color || '#64748b';
    if (st === 1) return { background: c, border: `1px solid ${c}` };
    if (st === 0) return { background: `${c}44`, border: `1px solid ${c}77` };
    return { background: 'transparent', border: `1px ${cell.guessed ? 'dashed' : 'solid'} ${c}66` };
  };
  const s = data.summary || {};
  return (
    <>
      {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>⚠ 최근 조회 실패: {error} — 이전 데이터를 표시 중입니다.</div>}
      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">vCenter</span>
          <select className="select" value={vc} onChange={(e) => { setVc(e.target.value); setBase(''); }}>
            <option value="">전체</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
          </select>
        </label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">대역(/24)</span>
          <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
            {(data.bases || []).map((b) => <option key={b} value={b}>{b}.0/24</option>)}
            {(!data.bases || data.bases.length === 0) && <option value="">(대역 없음)</option>}
          </select>
        </label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">기간</span>
          <select className="select" value={days} onChange={(e) => { setDays(Number(e.target.value)); setBucket(null); }}>
            {[1, 7, 30, 90, 365].map((d) => <option key={d} value={d}>최근 {d}일</option>)}
          </select>
        </label>
      </div>

      {!data.base ? (
        <div className="card"><span className="muted">표시할 대역이 없습니다. ‘🗂️ 대역·스캔’에서 vCenter 대역을 등록하거나 스캔을 실행하세요.</span></div>
      ) : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>
            <Card label="대역" value={data.cidr} meta={`${s.total}개 주소`} />
            <Card label="사용 이력 IP" value={(s.everUsed || 0).toLocaleString()} meta={`현재 응답 ${s.currentlyUp || 0}`} accent="var(--green)" />
            <Card label="빈 IP" value={(s.neverSeen || 0).toLocaleString()} meta="미관측" />
          </div>

          {/* 타임 슬라이더 */}
          <div className="card" style={{ marginBottom: 10, padding: '10px 14px' }}>
            <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>⏱ 시점: {fmtDt(data.buckets[bi])} {bucket == null && <span className="muted">(최신)</span>}</b>
              <div className="flex gap">
                <button className="tab" disabled={bi <= 0} onClick={() => setBucket(Math.max(0, bi - 1))}>◀</button>
                <button className="tab" disabled={bi >= N - 1} onClick={() => setBucket(Math.min(N - 1, bi + 1))}>▶</button>
                <button className="tab" onClick={() => setBucket(null)}>최신</button>
              </div>
            </div>
            <input type="range" min={0} max={Math.max(0, N - 1)} value={bi} onChange={(e) => setBucket(Number(e.target.value))} style={{ width: '100%' }} />
            <div className="flex between" style={{ fontSize: 11 }}><span className="muted">{fmtDt(data.buckets[0])}</span><span className="muted">{fmtDt(data.buckets[N - 1])}</span></div>
          </div>

          {/* 범례 */}
          <div className="flex gap wrap" style={{ marginBottom: 8, fontSize: 12, alignItems: 'center' }}>
            <span className="muted">OS:</span>
            {(data.osLegend || []).map((o) => <span key={o.key} className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: o.color, display: 'inline-block' }} /> {o.key} {o.count}</span>)}
            <span className="muted" style={{ marginLeft: 8 }}>· 상태:</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#16a34a', display: 'inline-block' }} /> 사용</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#16a34a44', display: 'inline-block' }} /> 미사용</span>
            <span className="flex gap" style={{ alignItems: 'center' }}><span style={{ width: 12, height: 12, borderRadius: 3, border: '1px dashed #16a34a66', display: 'inline-block' }} /> 미관측</span>
          </div>
          {/* 색 의미 설명(v2.361) */}
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.6 }}>
            칸 색: <b style={{ color: '#16a34a' }}>진한 색 = 그 시각에 사용(스캔 응답)</b> · <span style={{ color: '#16a34a' }}>연한 색 = 미사용(응답 없음)</span> · 회색·점선 = 미관측(그 시각에 스캔이 안 돎). 색상은 OS 종류를 나타냅니다(위 OS 범례).
          </div>

          {/* 격자 (.1 ~ .254) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(22px, 1fr))', gap: 3, marginBottom: 12 }}>
            {data.cells.map((cell) => (
              <div key={cell.ip} onClick={() => setSel(cell)} title={`${cell.ip}${cell.host ? ` · ${cell.host}` : ''}${cell.os ? ` · ${cell.os}` : ''} · ${cell.present ? (cell.states[bi] === 1 ? '사용' : cell.states[bi] === 0 ? '미사용' : '미관측') : '빈 IP'}`}
                style={{ aspectRatio: '1 / 1', borderRadius: 4, cursor: 'pointer', ...cellStyle(cell), outline: sel?.ip === cell.ip ? '2px solid var(--text)' : 'none', fontSize: 9, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {cell.present && cell.states[bi] === 1 ? Number(cell.ip.split('.')[3]) : ''}
              </div>
            ))}
          </div>

          {sel && (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="flex between"><b>{sel.ip}</b><button className="logout-btn" onClick={() => setSel(null)}>닫기</button></div>
              <div className="spec-grid" style={{ marginTop: 8, fontSize: 13 }}>
                <div><span className="muted">호스트명</span><div>{sel.host || '—'}</div></div>
                <div><span className="muted">OS</span><div>{sel.os || '—'} {sel.guessed && <span className="badge gray">추정</span>}</div></div>
                <div><span className="muted">vCenter</span><div>{sel.vcenterName || '—'}</div></div>
                <div><span className="muted">상태</span><div>{sel.status || '—'}</div></div>
                <div><span className="muted">최초 관측</span><div>{fmtDt(sel.firstSeen)}</div></div>
                <div><span className="muted">최근 관측</span><div>{fmtDt(sel.lastSeen)}</div></div>
              </div>
              {/* 처음/마지막 사용 강조(v2.361) */}
              <div className="flex gap wrap" style={{ marginTop: 10, fontSize: 12.5 }}>
                <span>🟢 <span className="muted">마지막 사용</span> <b>{fmtDate(sel.lastSeen)}</b>{sel.lastSeen && <span className="muted"> ({agoLabel(sel.lastSeen)})</span>}</span>
                <span style={{ marginLeft: 10 }}><span className="muted">처음 사용</span> <b>{fmtDate(sel.firstSeen)}</b></span>
              </div>
              {/* 미니 타임라인(v2.361 — 한 칸 = 선택 기간 단위, 왼쪽 과거 → 오른쪽 현재) */}
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>사용 추이 · 한 칸 = <b>{unitFor(days)}</b> (왼쪽=과거 → 오른쪽=현재)</div>
                <div style={{ display: 'flex', gap: 2 }}>
                  {sel.states.map((st, i) => (
                    <div key={i} title={`${fmtDt(data.buckets[i])} · ${st === 1 ? '사용' : st === 0 ? '미사용' : '미관측'}`}
                      style={{ flex: 1, height: 18, borderRadius: 2, background: st === 1 ? (sel.color || '#16a34a') : st === 0 ? `${sel.color || '#16a34a'}44` : 'rgba(148,163,184,.12)', outline: i === bi ? '2px solid var(--text)' : 'none' }} />
                  ))}
                </div>
                {/* 축 라벨: 칸이 적으면(≤12) 칸마다, 많으면 시작·중간·현재만 */}
                {N <= 12 ? (
                  <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
                    {sel.states.map((_, i) => <div key={i} className="muted" style={{ flex: 1, fontSize: 9, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>{fmtBucketTick(data.buckets[i], days)}</div>)}
                  </div>
                ) : (
                  <div className="flex between" style={{ marginTop: 3, fontSize: 10 }}>
                    <span className="muted">{fmtBucketTick(data.buckets[0], days)}</span>
                    <span className="muted">{fmtBucketTick(data.buckets[Math.floor(N / 2)], days)}</span>
                    <span className="muted">현재</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * 대역(subnet/range) 단위 정책 관리 — 한 대역을 통째로 예약/DHCP풀/폐기 등으로 지정한다.
 * 우선순위: IP 단위 수동(override) > 대역 정책 > 자동발견. 정책은 행을 만들지 않고 오버레이만 한다.
 */
export function RangePolicies({ scope, canManage, vcenters = [], onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // 편집/생성 대상
  const [busy, setBusy] = useState('');
  const load = () => fetchJson('/tools/ipam/policies').then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const vcName = {};
  for (const v of vcenters) vcName[v.vcenterId] = v.vcenterName;
  const remove = async (p) => {
    if (!window.confirm(`정책 '${p.spec}'을(를) 삭제할까요? 적용 IP(${p.specSize}개)가 자동발견 상태로 복귀합니다.`)) return;
    setBusy(p.id); setErr(null);
    // v2.613 WEB2613-10: api.js 를 우회한 직접 fetch 금지 — 401 전역 처리·403 안내(HttpError)·X-Request-Id 가 빠진다.
    const r = await delJson(`/tools/ipam/policies/${encodeURIComponent(p.id)}`).catch((e) => ({ ok: false, reason: e.message }));
    setBusy('');
    if (r.ok) { await load(); onChanged?.(); } else setErr(r.reason || '삭제 실패');
  };
  const toggle = async (p) => {
    setBusy(p.id);
    const r = await putJson(`/tools/ipam/policies/${encodeURIComponent(p.id)}`, { enabled: !(p.enabled !== false) }).catch((e) => ({ ok: false, reason: e.message }));
    setBusy('');
    if (r.ok) { await load(); onChanged?.(); } else setErr(r.reason || '변경 실패');
  };
  if (err && !data) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const policies = [...(data.policies || [])].sort((a, b) => (b.priority - a.priority) || (a.specLo - b.specLo));
  // 겹침 경고: 같은(또는 교차) 범위를 가진 다른 정책이 있는지(O(M^2), M 작음).
  const overlaps = (p) => policies.some((q) => q.id !== p.id && q.enabled !== false && p.enabled !== false && p.specLo <= q.specHi && q.specLo <= p.specHi && (!p.claimedVcenterId || !q.claimedVcenterId || p.claimedVcenterId === q.claimedVcenterId));
  const sm = data.summary || {};
  return (
    <>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="정책 수" value={sm.total || 0} meta={`활성 ${sm.enabled || 0}`} />
        <Card label="커버 IP(합)" value={(sm.coverageIps || 0).toLocaleString()} meta="정책이 덮는 IP 총합" />
        <Card label="상태 분포" value={Object.keys(sm.byStatus || {}).length} meta={Object.entries(sm.byStatus || {}).map(([k, v]) => `${MGMT[k]?.[0] || k} ${v}`).join(' · ') || '—'} />
      </div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="flex between" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="muted" style={{ fontSize: 12 }}>우선순위: <b>IP 수동(override)</b> &gt; <b>대역 정책</b> &gt; 자동발견. 좁은 대역·높은 priority가 겹침 시 우선.</div>
        {canManage && <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setEdit({ __new: true, priority: 100, enabled: true })}>＋ 새 정책</button>}
      </div>
      {policies.length === 0 ? (
        <div className="card"><span className="muted">등록된 대역 정책이 없습니다. ‘＋ 새 정책’으로 대역(예: 10.0.0.0/24)에 기본 관리상태를 지정하세요.</span></div>
      ) : (
        <div className="table-wrap">
          <STable minWidth={860} wrap={false}>
            <thead><tr><th>활성</th><th>대역(spec)</th><th>커버 IP</th><th>상태</th><th>vCenter</th><th>우선순위</th><th>담당/라벨</th><th>비고</th><th></th></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} style={{ opacity: p.enabled === false ? 0.5 : 1 }}>
                  <td>{canManage
                    ? <input type="checkbox" checked={p.enabled !== false} disabled={busy === p.id} onChange={() => toggle(p)} title="활성/비활성" />
                    : (p.enabled !== false ? '✓' : '—')}</td>
                  <td><b>{p.spec}</b>{overlaps(p) && <span className="badge amber" style={{ marginLeft: 6, fontSize: 10 }} title="다른 정책과 범위가 겹칩니다(좁은 대역·높은 priority 우선)">겹침</span>}</td>
                  <td className="muted">{(p.specSize || 0).toLocaleString()}</td>
                  <td>{p.status ? <MgmtBadge s={p.status} /> : <span className="muted">—</span>}{p.status === 'ignored' && <span className="muted" style={{ fontSize: 10 }} title="이 대역 전체가 대장에서 숨겨집니다(개별 override 제외)"> 숨김</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{p.claimedVcenterId ? (vcName[p.claimedVcenterId] || p.claimedVcenterId) : '전역'}</td>
                  <td className="muted">{p.priority ?? 100}</td>
                  <td style={{ fontSize: 12 }}>{p.label || p.owner ? <span>{p.label}{p.owner ? <span className="muted"> · 👤{p.owner}</span> : ''}</span> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.note || ''}>{p.note || ''}</td>
                  <td>{canManage && <span className="flex gap">
                    <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEdit(p)}>✎</button>
                    <button className="tab" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--red)' }} disabled={busy === p.id} onClick={() => remove(p)}>삭제</button>
                  </span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
      {edit && <PolicyForm policy={edit} vcenters={vcenters} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); onChanged?.(); }} />}
    </>
  );
}

function PolicyForm({ policy, vcenters = [], onClose, onSaved }) {
  const isNew = !!policy.__new;
  const [spec, setSpec] = useState(policy.spec || '');
  const [status, setStatus] = useState(policy.status || '');
  const [priority, setPriority] = useState(policy.priority ?? 100);
  const [claimedVcenterId, setClaimedVcenterId] = useState(policy.claimedVcenterId || '');
  const [owner, setOwner] = useState(policy.owner || '');
  const [label, setLabel] = useState(policy.label || '');
  const [deviceType, setDeviceType] = useState(policy.deviceType || '');
  const [note, setNote] = useState(policy.note || '');
  const [enabled, setEnabled] = useState(policy.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const size = policySpecSize(spec); // v2.639(D1): 서버 specToRange 와 같은 뜻 — 예전 사본은 `192.168.1.1-50` 을 음수(0)로 읽어 저장을 잠갔다
  const save = async () => {
    if (size <= 0) { setErr('유효한 대역(CIDR/범위/IP)이 아닙니다.'); return; }
    setBusy(true); setErr(null);
    const body = { spec, status, priority: Number(priority), claimedVcenterId, owner, label, deviceType, note, enabled };
    const r = isNew
      ? await postJson('/tools/ipam/policies', body).catch((e) => ({ ok: false, reason: e.message }))
      : await putJson(`/tools/ipam/policies/${encodeURIComponent(policy.id)}`, body).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '저장 실패');
  };
  const L = { fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' };
  return (
    <Modal title={isNew ? '새 대역 정책' : `대역 정책 — ${policy.spec}`} onClose={onClose} width={760} resizable minWidth={520} minHeight={460}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>대역 전체에 적용할 <b>기본 관리상태</b>입니다. 개별 IP를 다르게 두려면 그 IP에 수동(override)을 지정하세요(override 우선).</div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 14, alignItems: 'start' }}>
        <label style={L}>대역(spec)</label>
        <div>
          <input className="input" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="예: 10.0.0.0/24  ·  10.0.0.1-50  ·  10.0.0.5" style={{ width: '100%', boxSizing: 'border-box' }} />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{size > 0 ? `≈ ${size.toLocaleString()}개 IP 커버` : <span style={{ color: 'var(--red)' }}>유효한 대역이 아닙니다</span>}</div>
        </div>

        <label style={L}>관리상태</label>
        <div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: '100%' }}>
            <option value="">— 미지정(필드만 적용) —</option>
            {Object.keys(MGMT).map((s) => <option key={s} value={s}>{MGMT[s][0]}</option>)}
          </select>
          {status === 'ignored' && <div className="muted" style={{ fontSize: 11, marginTop: 4, color: 'var(--amber,#f59e0b)' }}>⚠ 이 대역 전체가 대장에서 숨겨집니다(개별 IP override 제외). 1024개 이하 대역만 허용됩니다.</div>}
        </div>

        <label style={L}>우선순위</label>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 120 }} />
          <span className="muted" style={{ fontSize: 11 }}>0~1000 (기본 100). 겹침 시 좁은 대역 우선, 같으면 priority 높은 쪽.</span>
        </div>

        <label style={L}>vCenter 귀속</label>
        <select className="select" value={claimedVcenterId} onChange={(e) => setClaimedVcenterId(e.target.value)} style={{ width: '100%' }}>
          <option value="">전역(모든 vCenter)</option>
          {vcenters.filter((v) => v.vcenterId).map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.vcenterName}</option>)}
        </select>

        <label style={L}>디바이스 종류</label>
        <select className="select" value={deviceType} onChange={(e) => setDeviceType(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 미지정 —</option>
          {Object.keys(DEVTYPE_LABEL).map((d) => <option key={d} value={d}>{DEVTYPE_LABEL[d]}</option>)}
        </select>

        <label style={L}>담당자/팀</label>
        <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="예: 인프라팀" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>라벨</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 사무실 DHCP 풀" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>비고</label>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="대역 용도/주의사항" style={{ resize: 'vertical', minHeight: 54, width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>활성</label>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 이 정책 적용</label>

        <div />
        <div className="flex gap" style={{ marginTop: 4 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || size <= 0} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
        </div>
      </div>
    </Modal>
  );
}
