/**
 * DiskTrend.jsx — 용량 리포트 › 디스크 트렌드(v2.446).
 *
 * 사용자 요구: "할당된 디스크·사용된 디스크·사용하지 않은 회수 가능한 용량을 차트로 보여 트렌드를
 * 분석 — 레퍼런스를 많이 찾아 근거와 함께". 정의·판정·인용은 서버 순수 모듈(tools/diskTrend.js)이
 * 만들고 여기서는 표시만 한다. 시계열은 샘플러가 vCenter 별 DB 에 쌓은 집계(수집 시작 이후만).
 */
import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox, VmLink } from '../../components/ui.jsx';
import { Card, tb } from './shared.jsx';
import BoldText from '../../components/boldText.jsx'; // 서버 판정 문구의 **강조** 를 별표 노출 없이 렌더(v2.440 규약)

const DAYS = [7, 30, 90, 365];
const tip = { background: 'var(--panel, #0f172a)', border: '1px solid var(--border, #334155)', borderRadius: 8, fontSize: 12 };
const gb = (x) => (x == null ? '—' : tb(Math.round(x)));
const gb1 = (x) => (x == null ? '—' : x >= 1024 ? `${(x / 1024).toFixed(2)} TB` : `${Number(x).toFixed(1)} GB`);
const n = (x, unit = '') => (x == null ? '—' : `${x}${unit}`);
const LEVEL = {
  crit: { icon: '🔴', color: '#f87171', label: '위험' },
  warn: { icon: '🟠', color: '#fbbf24', label: '경고' },
  insufficient: { icon: '⛔', color: '#f87171', label: '근거 부족' },
  info: { icon: 'ℹ️', color: '#93c5fd', label: '참고' },
  ok: { icon: '✅', color: 'var(--green)', label: '정상' },
};
const fmtTs = (t, days) => { const d = new Date(t); return days <= 7 ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시` : `${d.getMonth() + 1}/${d.getDate()}`; };
const dayLabel = (d) => (d == null ? '—' : d === 0 ? '이미 도달' : `${d}일`);

export default function DiskTrend({ scope }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fetchJson('/tools/capacity/disk-history', { days: String(days), ...(scope ? { vcenterId: scope } : {}) })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [scope, days]);

  const periodBar = (
    <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
      <span className="muted" style={{ fontSize: 12 }}>기간</span>
      {DAYS.map((d) => (
        <button key={d} className={days === d ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '5px 11px' }} onClick={() => setDays(d)}>최근 {d}일</button>
      ))}
      {data?.synthesized && <span className="badge amber" title="DATA_SOURCE=mock — 현재 구성에서 되감은 합성 추이입니다">데모(mock) 합성 데이터</span>}
      {data && !data.synthesized && data.collectedSince?.vm && (
        <span className="muted" style={{ fontSize: 11.5 }}>수집 시작: 용량/사용 {data.collectedSince.ds ? new Date(data.collectedSince.ds).toLocaleDateString('ko-KR') : '—'} · 할당/회수 {new Date(data.collectedSince.vm).toLocaleDateString('ko-KR')}</span>
      )}
    </div>
  );
  if (error && !data) return <>{periodBar}<ErrorBox message={error} /></>;
  if (!data) return <>{periodBar}<Loading /></>;
  const b = data.breakdown; const a = data.analysis;
  if (!b) return <>{periodBar}<div className="card muted">표시할 데이터가 없습니다(범위 밖 vCenter 이거나 인벤토리가 비어 있음).</div></>;
  const pts = data.points || [];
  const worst = LEVEL[a?.worst] || LEVEL.ok;
  const policy = a?.policy || b.policy;

  return (
    <div>
      {periodBar}

      {/* KPI */}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="데이터스토어 용량 / 사용" value={`${gb(b.ds.capGB)} / ${gb(b.ds.usedGB)}`} meta={`사용률 ${n(b.ds.usagePct, '%')} · 여유 ${gb(b.ds.freeGB)} · DS ${b.ds.count}개`}
          accent={b.ds.usagePct >= policy.critPct ? 'var(--red)' : b.ds.usagePct >= policy.warnPct ? '#fbbf24' : undefined} />
        <Card label="VM 할당(프로비저닝) / 커밋" value={`${gb(b.vm.provGB)} / ${gb(b.vm.committedGB)}`} meta={`할당 ÷ 용량 ${n(b.vm.overcommitPct, '%')} · thin ${b.vm.thinCount}대 · 미커밋 ${gb(b.vm.uncommittedGB)}`}
          accent={b.vm.overcommitPct > 100 ? '#fbbf24' : undefined} />
        <Card label="회수 가능 (정지 VM + 스냅샷)" value={gb1(b.reclaim.totalGB)} meta={`정지 ${b.reclaim.off.count}대 ${gb1(b.reclaim.off.gb)} · 스냅샷 ${b.reclaim.snap.count}대 ${gb1(b.reclaim.snap.gb)} · 사용의 ${n(b.reclaim.pctOfUsed, '%')}`}
          accent={b.reclaim.totalGB > 0 ? 'var(--green)' : undefined} />
        <Card label="증가율 / 위험선 도달" value={a?.growth?.usedGBperDay == null ? '근거 부족' : `${a.growth.usedGBperDay} GB/일`} meta={a?.growth?.usedGBperDay == null ? a?.growth?.reason : `위험선(${policy.critPct}%) ${dayLabel(a.eta.daysToCrit)} · 가득 참 ${dayLabel(a.eta.daysToFull)}`}
          accent={a?.eta?.daysToCrit != null && a.eta.daysToCrit <= policy.etaCritDays ? 'var(--red)' : a?.eta?.daysToCrit != null && a.eta.daysToCrit <= policy.etaWarnDays ? '#fbbf24' : undefined} />
      </div>

      {/* 판정 */}
      <div className="card" style={{ borderLeft: `4px solid ${worst.color}`, marginBottom: 12 }}>
        <b>{worst.icon} 판정 — 최악 등급 {worst.label}</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          {(a?.verdicts || []).map((v) => {
            const L = LEVEL[v.level] || LEVEL.info;
            return (
              <li key={v.key} style={{ marginBottom: 6 }}>
                <span style={{ color: L.color, fontWeight: 700 }}>{L.icon} {v.title}</span>
                <div className="muted" style={{ fontSize: 12.5 }}><BoldText text={v.detail} />{v.cite?.length ? <span style={{ opacity: .7 }}> [근거: {v.cite.map((c) => (a.citations.findIndex((x) => x.id === c) + 1)).filter((i) => i > 0).map((i) => `#${i}`).join(', ')}]</span> : null}</div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 추이 차트 1: 용량·할당·사용·회수 가능 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <b>추이 — 용량 · 할당(프로비저닝) · 사용 · 회수 가능</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>
          점선 = 데이터스토어 용량, 굵은 실선 = 할당(VM 이 최대로 커밋할 수 있는 양), 면 = 실제 사용(데이터스토어 점유) 과 VM 커밋, 초록 면 = 회수 가능(정지 VM + 스냅샷). 할당이 용량 점선을 넘으면 thin 오버서브스크립션입니다.
        </div>
        {pts.length < 2 ? (
          <div className="muted" style={{ fontSize: 13, padding: 20, textAlign: 'center' }}>
            표시할 추이 데이터가 아직 없습니다. 할당/회수 계열은 <b>이 버전(v2.446)부터</b> 샘플러가 쌓기 시작하며, 업그레이드 직후에는 몇 시간 뒤부터 그래프가 보입니다. 아래 현재 구성·판정은 지금 스냅샷 기준입니다.
          </div>
        ) : (
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={pts} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,.15)" />
                <XAxis dataKey="ts" tickFormatter={(t) => fmtTs(t, days)} tick={{ fontSize: 11 }} minTickGap={28} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}T` : `${v}G`)} width={64} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v, name) => [gb1(v), name]} contentStyle={tip} />
                <Legend />
                <Area type="monotone" dataKey="dsUsedGB" name="사용(데이터스토어 점유)" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.18} dot={false} connectNulls={false} />
                <Area type="monotone" dataKey="usedGB" name="VM 커밋" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.12} dot={false} connectNulls={false} />
                <Area type="monotone" dataKey="reclaimGB" name="회수 가능(정지 VM+스냅샷)" stroke="#4ade80" fill="#4ade80" fillOpacity={0.25} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="provGB" name="할당(프로비저닝)" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="dsCapGB" name="용량" stroke="#e2e8f0" strokeDasharray="5 4" dot={false} connectNulls={false} />
                {b.ds.capGB > 0 && <ReferenceLine y={b.ds.capGB * policy.critPct / 100} stroke="#ef4444" strokeDasharray="2 2" label={{ value: `위험 ${policy.critPct}%`, fill: '#ef4444', fontSize: 10, position: 'insideTopRight' }} />}
                {b.ds.capGB > 0 && <ReferenceLine y={b.ds.capGB * policy.warnPct / 100} stroke="#fbbf24" strokeDasharray="2 2" label={{ value: `경고 ${policy.warnPct}%`, fill: '#fbbf24', fontSize: 10, position: 'insideTopRight' }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {pts.length >= 2 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            집계 단위 {data.bucketMs >= 86_400_000 ? `${Math.round(data.bucketMs / 86_400_000)}일` : `${Math.round(data.bucketMs / 3_600_000)}시간`} 평균 · 표본 {pts.length}점
            {a?.growth?.provGBperDay != null ? ` · 할당 증가율 ${a.growth.provGBperDay} GB/일` : ''}
            {a?.growth?.reclaimGBperDay != null ? ` · 회수 가능 증감 ${a.growth.reclaimGBperDay} GB/일` : ''}
          </div>
        )}
      </div>

      {/* 추이 차트 2: 회수 가능 구성 */}
      {pts.length >= 2 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>회수 가능 구성 추이 — 정지 VM · 스냅샷</b>
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <ComposedChart data={pts} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,.15)" />
                <XAxis dataKey="ts" tickFormatter={(t) => fmtTs(t, days)} tick={{ fontSize: 11 }} minTickGap={28} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}T` : `${v}G`)} width={64} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')} formatter={(v, name) => [gb1(v), name]} contentStyle={tip} />
                <Legend />
                <Area type="monotone" dataKey="offGB" stackId="r" name="정지 VM 커밋" stroke="#22c55e" fill="#22c55e" fillOpacity={0.35} dot={false} connectNulls={false} />
                <Area type="monotone" dataKey="snapGB" stackId="r" name="스냅샷" stroke="#f472b6" fill="#f472b6" fillOpacity={0.35} dot={false} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 현재 구성 표 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <b>현재 구성 (스냅샷 기준)</b>
        <div className="table-wrap" style={{ marginTop: 6 }}>
          <STable>
            <thead><tr><th>항목</th><th>값</th><th>정의 · 해석</th></tr></thead>
            <tbody>
              <tr><td>용량</td><td data-sort={b.ds.capGB}>{gb1(b.ds.capGB)}</td><td className="muted">데이터스토어 capacity 합 ({b.ds.count}개, 용량 미상 제외)</td></tr>
              <tr><td>사용</td><td data-sort={b.ds.usedGB}>{gb1(b.ds.usedGB)} ({n(b.ds.usagePct, '%')})</td><td className="muted">capacity − freeSpace 합. VM 외 파일(ISO·템플릿·고아 디스크·스왑)까지 포함한 실제 점유. 경고 {policy.warnPct}% · 위험 {policy.critPct}% (vCenter 기본 알람) — 개별 DS 경고 {b.ds.warnCount} · 위험 {b.ds.critCount}</td></tr>
              <tr><td>할당(프로비저닝)</td><td data-sort={b.vm.provGB}>{gb1(b.vm.provGB)} ({n(b.vm.overcommitPct, '%')} of 용량)</td><td className="muted">VM committed + uncommitted 합 = VM 이 최대로 커밋할 수 있는 양. 100% 초과 = thin 오버서브스크립션</td></tr>
              <tr><td>VM 커밋</td><td data-sort={b.vm.committedGB}>{gb1(b.vm.committedGB)} ({n(b.vm.committedPctOfCap, '%')} of 용량)</td><td className="muted">VM 이 지금 실제로 점유한 양(스냅샷·스왑 포함). VM {b.vm.count}대(On {b.vm.on} · Off {b.vm.off})</td></tr>
              <tr><td>미커밋(thin 여유)</td><td data-sort={b.vm.uncommittedGB}>{gb1(b.vm.uncommittedGB)}</td><td className="muted">thin {b.vm.thinCount}대가 아직 쓰지 않은 약속량 — <b>회수 가능이 아닙니다</b>(채워질 수 있는 부채)</td></tr>
              <tr><td>회수 가능 ① 정지 VM</td><td data-sort={b.reclaim.off.gb}>{gb1(b.reclaim.off.gb)}</td><td className="muted">전원 OFF VM {b.reclaim.off.count}대의 커밋 용량. 삭제·아카이브 시 회수(Aria Reclaim 의 Powered-off VMs)</td></tr>
              <tr><td>회수 가능 ② 스냅샷</td><td data-sort={b.reclaim.snap.gb}>{gb1(b.reclaim.snap.gb)}</td><td className="muted">스냅샷 보유 VM {b.reclaim.snap.count}대의 스냅샷 크기. {policy.snapshotMaxHours}시간 초과 {b.reclaim.snapOld.count}대 {gb1(b.reclaim.snapOld.gb)}{b.reclaim.snapOld.unknownAge ? ` · 생성시각 미상 ${b.reclaim.snapOld.unknownAge}대` : ''}</td></tr>
              <tr data-pin><td><b>회수 가능 합계</b></td><td data-sort={b.reclaim.totalGB}><b>{gb1(b.reclaim.totalGB)}</b></td><td className="muted">사용의 {n(b.reclaim.pctOfUsed, '%')} · 전부 회수 시 사용률 {n(b.ds.usagePct, '%')} → {n(b.reclaim.afterReclaimUsagePct, '%')}{a?.eta?.daysGainedByReclaim != null ? ` · 약 ${a.eta.daysGainedByReclaim}일치 여유` : ''}</td></tr>
              <tr><td>VM 외 사용량</td><td data-sort={b.other.gb ?? -1}>{b.other.gb == null ? '— (산정 불가)' : gb1(b.other.gb)}</td><td className="muted">사용 − (VM 커밋 + 템플릿 {gb1(b.vm.templateGB)}). ISO·오버헤드·범위 밖 VM·<b>고아 디스크</b> 후보. 음수면 범위 밖 VM 이 그 DS 를 쓰는 것이라 표시하지 않음</td></tr>
            </tbody>
          </STable>
        </div>
      </div>

      {/* 회수 후보 목록 */}
      {(b.topOff.length > 0 || b.topSnap.length > 0) && (
        <div className="grid2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 12, marginBottom: 12 }}>
          {b.topOff.length > 0 && (
            <div className="card">
              <b>정지 VM 상위 {b.topOff.length} (커밋 용량 순)</b>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <STable>
                  <thead><tr><th>VM</th><th>vCenter</th><th>OS</th><th>커밋</th></tr></thead>
                  <tbody>{b.topOff.map((v) => <tr key={v.id}><td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /></td><td className="muted">{v.vcenterId}</td><td className="muted">{v.guestOS}</td><td data-sort={v.storageGB}>{gb1(v.storageGB)}</td></tr>)}</tbody>
                </STable>
              </div>
            </div>
          )}
          {b.topSnap.length > 0 && (
            <div className="card">
              <b>스냅샷 상위 {b.topSnap.length} (크기 순)</b>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <STable>
                  <thead><tr><th>VM</th><th>vCenter</th><th>개수</th><th>크기</th><th>가장 오래된</th></tr></thead>
                  <tbody>{b.topSnap.map((v) => <tr key={v.id}><td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} /></td><td className="muted">{v.vcenterId}</td><td>{v.snapshotCount}</td><td data-sort={v.snapshotSizeGB}>{gb1(v.snapshotSizeGB)}</td><td data-sort={v.ageDays ?? -1} style={{ color: v.ageDays != null && v.ageDays * 24 > policy.snapshotMaxHours ? '#fbbf24' : undefined }}>{v.ageDays == null ? '—' : `${v.ageDays}일`}</td></tr>)}</tbody>
                </STable>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 방법론 + 참고 문서 */}
      <div className="card">
        <b>판정 방법 · 참고한 공식 문서</b>
        <ol style={{ margin: '6px 0 10px', paddingLeft: 20, fontSize: 12.5, lineHeight: 1.7 }}>
          {(a?.methodology || []).map((m, i) => <li key={i}>{m}</li>)}
        </ol>
        <div className="table-wrap">
          <STable>
            <thead><tr><th>#</th><th>문서</th><th>이 리포트에서 쓴 곳</th></tr></thead>
            <tbody>
              {(a?.citations || []).map((c, i) => (
                <tr key={c.id}>
                  <td data-sort={i + 1}>{i + 1}</td>
                  <td style={{ whiteSpace: 'normal', lineHeight: 1.5 }}><a href={c.url} target="_blank" rel="noreferrer" style={{ color: '#93c5fd' }}>{c.title}</a></td>
                  <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal', lineHeight: 1.5 }}>{c.usedFor}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
          ※ 시계열은 포탈 샘플러 집계이며 수집 시작 이전은 결측입니다(소급 추정 없음). 회수 가능은 관측 가능한 두 분류(정지 VM·스냅샷)만 더한 값이고 유휴 VM·고아 디스크는 포함되지 않습니다. 회수 조치 뒤 배열 여유가 실제로 늘려면 UNMAP 이 동작해야 합니다. 참고 문서 링크는 Broadcom 이관 이후 주소가 바뀔 수 있으니 열리지 않으면 제목으로 검색하세요.
        </div>
      </div>
    </div>
  );
}
