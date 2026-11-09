/**
 * BmSanCompare.jsx — 베어메탈 스토리지 › SAN 비교 탭(v2.915 — 시안 docs/design/bm-san-compare ①②③⑤⑥ · 컨펌 2026-11-09 '진행해').
 *
 * 베어메탈(그룹 · 전체 · 서버)의 용량 사용률 + 디스크 I/O 표본 ↔ SAN 어레이(VMAX · PowerMax 기본)의 용량 사용률 + 포트 전송 속도를
 * 같은 표 · 같은 요약에서 숫자로 비교한다. 두 값의 뜻 · 시각이 다르므로 '기준 · 신선도' 칸과 각주가 그것을 말한다.
 *  · 데이터: GET /tools/bm-storage/compare — 마운트 1회 + 버튼 + 필터 변경 + '지금 측정' 뒤(무거운 API 15초 폴링 금지).
 *  · 법인 · SAN 종류 칩은 공용 DeviceFacetBar(스토리지 모니터링과 같은 부품). 법인 키는 표시 이름이고 id 로 바꿔 보낸다.
 *  · 못 읽은 값은 '—' · 부분 합은 호박색 · 사유 코드는 bmSanCompareText 가 문장으로.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, canCsv } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import DeviceFacetBar from './DeviceFacetBar.jsx';
import BmIoChart from './BmIoChart.jsx';
import { fmtAgo } from '../../util/fmt.js';
import { dayStamp } from '../../dayStamp.js';
import {
  NONE_DC, fmtBps, pctTone, deltaText, ratioText, reasonText, reasonBadge, kindTag, SAN_TYPE_CHIPS, typesQuery,
  measuredText, bmBasisText, sanBasisText, compareRows, chipMeta, statusLine, latestCapAt, bytesText, pctText,
} from './bmSanCompareText.js';

const HOURS = [{ h: 1, label: '최근 1시간' }, { h: 24, label: '24시간' }, { h: 168, label: '7일' }];
const toneColor = (p) => { const t = pctTone(p); return t === 'red' ? 'var(--red)' : t === 'amber' ? 'var(--amber)' : t === 'green' ? 'var(--green)' : 'var(--text-dim)'; };
const PctCell = ({ p }) => (p == null ? <span className="muted">—</span> : (
  <span style={{ whiteSpace: 'nowrap' }}>
    <span className="bmc-pbar"><span style={{ width: `${Math.min(100, p)}%`, background: toneColor(p) }} /></span>
    <b style={{ fontSize: 12, color: toneColor(p), fontFamily: 'var(--mono)' }}>{pctText(p)}</b>
  </span>
));

export default function BmSanCompare() {
  const [dcSel, setDcSel] = useState(() => new Set());
  const [typeSel, setTypeSel] = useState(() => new Set(['vmax,powermax']));
  const [query, setQuery] = useState('');
  const [hours, setHours] = useState(1);
  const [peak, setPeak] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [ioOpen, setIoOpen] = useState(true);
  const reqRef = useRef(0);
  const chipsRef = useRef([]);   // 마지막으로 받은 법인 칩(필터 전 전체) — 선택 이름 → id

  const types = typesQuery(typeSel);
  const dcParam = useMemo(() => {
    const byName = new Map(chipsRef.current.map((c) => [c.name, c.id]));
    return [...dcSel].map((n) => byName.get(n)).filter(Boolean).join(',');
  }, [dcSel, data]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = ++reqRef.current;
    const ac = new AbortController();
    setLoading(true);
    fetchJson('/tools/bm-storage/compare', { hours, types, datacenterId: dcParam }, ac.signal, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (key !== reqRef.current) return; chipsRef.current = d.datacenters || []; setData(d); setError(null); setLoading(false); })
      .catch((e) => { if (key !== reqRef.current || ac.signal.aborted) return; setError(e); setLoading(false); });
    return () => ac.abort();
  }, [hours, types, dcParam, refreshKey]);

  const collectNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-storage/collect', {});
      if (!r.ok) setMsg(r.reason || '측정이 이미 진행 중입니다.');
      else setMsg(`측정 완료 — 성공 ${r.okCount} · 오류 ${r.errors}${r.queued ? ` · 폴링 위임 대기 ${r.queued}(엣지 회신 후 반영)` : ''} (${Math.round(r.ms / 1000)}초)`);
      setRefreshKey((k) => k + 1);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  // ── 파생값(훅은 조기 return 위에) ──
  const chips = data?.datacenters || chipsRef.current;
  const dcNames = useMemo(() => [...dcSel], [dcSel]);
  const dcChips = useMemo(() => chips.map((c) => ({ dc: c.name, list: [c], count: chipMeta(c).count })), [chips]);
  const typeChips = useMemo(() => SAN_TYPE_CHIPS.map((c) => ({ type: c.key, count: c.types.reduce((a, t) => a + (Number(data?.sanTypeCounts?.[t]) || 0), 0) })), [data]);
  const table = useMemo(() => (data ? compareRows({ bm: data.bm, san: data.san, hours, peak, dcNames, groupTotals: data.groupTotals }) : { rows: [], totals: [] }), [data, hours, peak, dcNames]);
  const ql = query.trim().toLowerCase();
  const shownRows = useMemo(() => (ql ? table.rows.filter((r) => [r.name, r.where, r.sub].some((v) => String(v || '').toLowerCase().includes(ql))) : table.rows), [table, ql]);
  const glanceMax = useMemo(() => Math.max(0, ...shownRows.map((r) => r.bps ?? 0)), [shownRows]);
  const servers = useMemo(() => (data?.bm?.servers || []).filter((s) => s.enabled !== false).filter((s) => (ql ? [s.name, s.datacenterName, ...(s.groups || [])].some((v) => String(v || '').toLowerCase().includes(ql)) : true))
    .sort((a, b) => (b.io?.totalBps ?? -1) - (a.io?.totalBps ?? -1)), [data, ql]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const { bm, san, summary } = data;
  const bmAgo = bm.status?.lastRunAt ? fmtAgo(bm.status.lastRunAt) : '';
  const sanPerfAgo = san.lastSampleAt ? fmtAgo(san.lastSampleAt) : '';
  const capAt = latestCapAt(san.arrays);
  const sanCapAgo = capAt ? fmtAgo(capAt) : '';
  const sampleSec = bm.status?.ioSampleSec ?? 2;
  const hoursLabel = HOURS.find((x) => x.h === hours)?.label || `${hours}시간`;
  const dotColor = bm.total.errors ? 'var(--red)' : bm.total.pending ? 'var(--amber)' : 'var(--green)';
  const sanTypesLabel = SAN_TYPE_CHIPS.filter((c) => typeSel.has(c.key)).map((c) => c.label).join(' · ') || 'VMAX · PowerMax';

  const toggleIn = (set, v) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const exportCsv = () => {
    const head = ['구분', '이름', '법인·그룹', '총 용량(B)', '사용량(B)', '사용률(%)', `전송 속도(B/s · ${peak ? '피크 평균' : '평균'})`, '피크(B/s)', '측정', '사유'];
    const line = (r) => [kindTag(r.kind === 'bm' ? 'bm' : r.type).label, r.name, r.where, r.totalBytes ?? '', r.usedBytes ?? '', r.pct ?? '', r.bps ?? '', r.peakBps ?? '', r.measured || '', r.reason ? reasonBadge(r.reason) : '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    const csv = `﻿${[head.join(','), ...table.totals.map(line), ...shownRows.map(line)].join('\r\n')}\r\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `bm-san-compare-${dayStamp()}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="bmc">
      <div className="flex between wrap" style={{ alignItems: 'flex-start', gap: '10px 16px', marginBottom: 12 }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            베어메탈 서버의 디스크 <b style={{ color: 'var(--text)' }}>용량 사용률</b>과 <b style={{ color: 'var(--text)' }}>전송 속도</b>를 SAN 어레이({sanTypesLabel})의 용량 사용률 · 포트 전송 속도와 <b style={{ color: 'var(--text)' }}>같은 표에서 숫자로</b> 비교합니다. 두 값의 뜻과 측정 시각이 다르므로 기준을 함께 보여 줍니다.
          </div>
          <div className="bm2-status"><span style={{ color: dotColor }}>●</span> {statusLine({ bm, san, bmAgo, sanPerfAgo, sanCapAgo })}{loading ? ' · 읽는 중' : ''}</div>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || bm.status?.running} onClick={collectNow}>{busy || bm.status?.running ? '측정 중…' : '지금 측정'}</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={loading} onClick={() => setRefreshKey((k) => k + 1)}>새로 고침</button>
          {canCsv() && <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={exportCsv} title="지금 보이는 비교 표를 CSV 로 내려받기">CSV</button>}
        </div>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, color: '#93c5fd' }}>{msg}</div>}
      {error && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>⚠ 일시 조회 오류: {String(error?.message || error)}</div>}

      {/* 법인 · SAN 종류 · 검색 — 공용 칩 바(스토리지 모니터링과 같은 부품). 숫자 = 그 법인의 비교 대상(베어메탈 서버 + 어레이) · 점 = 최고 사용률 색 */}
      <DeviceFacetBar
        dcChips={dcChips} typeChips={typeChips} dcSel={dcSel} typeSel={typeSel}
        onToggleDc={(dc) => setDcSel((s) => toggleIn(s, dc))} onToggleType={(t) => setTypeSel((s) => toggleIn(s, t))}
        onClear={() => { setDcSel(new Set()); setTypeSel(new Set(['vmax,powermax'])); setQuery(''); }}
        query={query} onQuery={setQuery} typeLabel={(k) => SAN_TYPE_CHIPS.find((c) => c.key === k)?.label || k}
        dcMeta={(list) => chipMeta(list[0])} typeTitle="🗄 SAN 종류" placeholder="장비 · 그룹 · 법인 찾기 (표 필터)" />
      <div className="muted" style={{ fontSize: 11.5, marginTop: -10, marginBottom: 12 }}>법인 칩의 숫자 = 그 법인의 비교 대상(베어메탈 서버 + 어레이) · 점 = 그 법인에서 가장 높은 사용률 색 · 여러 개 선택 가능. 베어메탈 서버의 법인은 서버 폼의 ‘법인’ 값이고, 비우면 엣지의 법인으로 추정합니다.</div>

      <div className="flex between wrap" style={{ alignItems: 'center', gap: '8px 16px', marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>SAN 전송 속도 범위</span>
        <span className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="bmc-seg">{HOURS.map((x) => <button key={x.h} type="button" className={hours === x.h ? 'on' : ''} onClick={() => setHours(x.h)}>{x.label}</button>)}</span>
          <span className="bmc-seg"><button type="button" className={!peak ? 'on' : ''} onClick={() => setPeak(false)}>평균</button><button type="button" className={peak ? 'on' : ''} onClick={() => setPeak(true)}>피크</button></span>
          <span className="muted" style={{ fontSize: 11.5 }}>베어메탈 전송 속도는 수집 시점 표본이라 범위와 무관합니다</span>
        </span>
      </div>

      {/* 비교 요약 */}
      <div className="card bm2-card bmc-sum">
        <div>
          <div className="bm2-label">▸ 용량 사용률</div>
          <div className="bmc-who"><span className="bmc-sw" style={{ background: 'var(--mint)' }} />베어메탈{dcNames.length ? ` · ${dcNames.join(', ')}` : ' 전체'} · {bm.total.servers}대 합산</div>
          <div className="bmc-big"><span className="v" style={{ color: toneColor(summary.capacity.bmPct) }}>{summary.capacity.bmPct == null ? '—' : summary.capacity.bmPct.toFixed(1)}<small>{summary.capacity.bmPct == null ? '' : '%'}</small></span><span className="s">{bytesText(summary.capacity.bmUsedBytes)} / {bytesText(summary.capacity.bmTotalBytes)}</span></div>
          <span className="bmc-bar">{summary.capacity.bmPct != null && <span style={{ width: `${Math.min(100, summary.capacity.bmPct)}%`, background: 'var(--mint)' }} />}</span>
          <div className="bmc-who"><span className="bmc-sw" style={{ background: 'var(--accent)' }} />SAN 어레이 · {sanTypesLabel} {summary.capacity.sanTotal}대{summary.capacity.sanMeasured < summary.capacity.sanTotal ? <span style={{ color: 'var(--amber)' }}> · 용량 읽음 {summary.capacity.sanMeasured}대</span> : ''}</div>
          <div className="bmc-big"><span className="v" style={{ color: toneColor(summary.capacity.sanPct) }}>{summary.capacity.sanPct == null ? '—' : summary.capacity.sanPct.toFixed(1)}<small>{summary.capacity.sanPct == null ? '' : '%'}</small></span><span className="s">{bytesText(summary.capacity.sanUsedBytes)} / {bytesText(summary.capacity.sanTotalBytes)}</span></div>
          <span className="bmc-bar">{summary.capacity.sanPct != null && <span style={{ width: `${Math.min(100, summary.capacity.sanPct)}%`, background: 'var(--accent)' }} />}</span>
          <div className="bmc-delta">차이 <b>{deltaText(summary.capacity.deltaPp)}</b><span className="muted"> · 전체 합 기준 · 그룹 겹침 없음</span></div>
        </div>
        <div>
          <div className="bm2-label">▸ 전송 속도 (읽기 + 쓰기)</div>
          <div className="bmc-who"><span className="bmc-sw" style={{ background: 'var(--mint)' }} />베어메탈 · {summary.throughput.bmMeasured}대 측정 합</div>
          <div className="bmc-big"><span className="v">{fmtBps(summary.throughput.bmBps)}</span><span className="s">읽기 {fmtBps(summary.throughput.bmReadBps)} · 쓰기 {fmtBps(summary.throughput.bmWriteBps)}</span></div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>수집 시점 {sampleSec}초 표본 · 서버 전체 물리 디스크 합{summary.throughput.bmTotal > summary.throughput.bmMeasured ? <span style={{ color: 'var(--amber)' }}> · 측정 불가 {summary.throughput.bmTotal - summary.throughput.bmMeasured}대는 합에 없음</span> : ''}</div>
          <div className="bmc-who"><span className="bmc-sw" style={{ background: 'var(--accent)' }} />SAN · {summary.throughput.sanMeasured}대 측정 합 ({hoursLabel} 평균)</div>
          <div className="bmc-big"><span className="v">{fmtBps(summary.throughput.sanBps)}</span><span className="s">피크 합 상한 {fmtBps(summary.throughput.sanPeakSumBps)}</span></div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>스위치 포트 트래픽 합(어레이 FC 포트){summary.throughput.sanTotal > summary.throughput.sanMeasured ? <span style={{ color: 'var(--amber)' }}> · 전송 측정 없음 {summary.throughput.sanTotal - summary.throughput.sanMeasured}대는 합에 없음</span> : ''}</div>
          <div className="bmc-delta">배율 <b>{ratioText(summary.throughput.ratio)}</b><span className="muted"> · 표본 방식이 달라 ‘지금 크기’ 비교입니다</span></div>
        </div>
        <div>
          <div className="bm2-label">▸ 기준 · 신선도</div>
          <dl className="bmc-kv">
            <dt>베어메탈 용량</dt><dd>df · used / (used + avail)<small>{bmAgo ? `${bmAgo} · ` : ''}주기 {bm.settings?.intervalMinutes}분 · 마운트 지정분만</small></dd>
            <dt>베어메탈 전송</dt><dd>/proc/diskstats {sampleSec}초 표본<small>{bmAgo ? `${bmAgo} · ` : ''}서버 전체 물리 디스크(마운트별 아님)</small></dd>
            <dt>SAN 용량</dt><dd>Unisphere 데이터 감축 후 실사용<small>{sanCapAgo || '스냅샷 없음'} · 구독(씬) 아님</small></dd>
            <dt>SAN 전송</dt><dd>SAN 스위치 포트 사용량 합<small>{sanPerfAgo || '표본 없음'}{san.perfIntervalMs ? ` · 주기 ${Math.round(san.perfIntervalMs / 60000)}분` : ''} · {hoursLabel} {peak ? '피크' : '평균'} · 시리얼로 어레이 대조</small></dd>
          </dl>
          <div className="bmc-delta"><span className="muted">기준이 다른 값을 한 표에 둔 것이므로 <b style={{ fontFamily: 'inherit' }}>배율 · 차이는 참고치</b>입니다. 어레이 자체 성능 API 는 수집하지 않습니다.</span></div>
          {!san.perfEnabled && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 8 }}>{reasonText('perf-disabled')}</div>}
          {san.perfEnabled && !san.switches && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 8 }}>{reasonText('no-switches')}</div>}
          {san.perfError && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 8 }}>포트 사용량 집계 오류 — {san.perfError}</div>}
        </div>
      </div>

      {/* 비교 표 */}
      <div className="card bm2-card">
        <div className="flex between wrap" style={{ alignItems: 'baseline', gap: '6px 12px', marginBottom: 10 }}>
          <div className="bm2-label">▸ 비교 표 <span style={{ letterSpacing: 0 }}>· 베어메탈 그룹 {(bm.groups || []).length} + SAN 어레이 {(san.arrays || []).length} · 사용률 높은 순{ql ? ` · 검색 ${shownRows.length}행` : ''}</span></div>
          <span className="muted" style={{ fontSize: 11.5 }}>열 제목을 누르면 정렬 · ‘—’ 는 항상 뒤 · 합계 행은 맨 아래 고정</span>
        </div>
        {san.arrays.length === 0 && (
          <div className="bmc-empty">비교할 SAN 어레이가 없습니다 — 스토리지 모니터링에 {sanTypesLabel} 가 등록돼 있지 않거나 고른 법인에 없습니다. SAN 종류 칩에서 다른 종류를 고르거나 <a href="#/tools/storage-mon">스토리지 모니터링</a>에서 등록하세요. 베어메탈 행만 보입니다.</div>
        )}
        {shownRows.length === 0 && table.totals.length === 0
          ? <div className="muted" style={{ fontSize: 13 }}>비교할 대상이 없습니다 — 현황 탭에서 베어메탈 서버를 등록하세요.</div>
          : <STable minWidth={960}>
            <thead><tr><th>구분</th><th>이름</th><th>법인 · 그룹</th><th style={{ textAlign: 'right' }}>총 용량</th><th style={{ textAlign: 'right' }}>사용량</th><th>사용률</th><th style={{ textAlign: 'right' }}>전송 속도 · 피크</th><th data-nosort>측정 기준</th><th>상태</th></tr></thead>
            <tbody>
              {[...shownRows, ...table.totals].map((r) => {
                const tag = kindTag(r.kind === 'bm' ? 'bm' : r.type);
                const basis = r.kind === 'bm' ? bmBasisText({ ago: bmAgo, sampleSec, ioMeasured: r.bps != null }) : sanBasisText({ capAgo: r.capAt ? fmtAgo(r.capAt) : '', ports: r.ports, switches: r.switches, hours });
                return (
                  <tr key={r.key} data-pin={r.pin ? '' : undefined} style={r.pin ? { fontWeight: 700, background: 'var(--panel-deep)' } : undefined}>
                    <td data-sort={tag.label}><span className={`badge ${tag.cls}`}>{tag.label}</span></td>
                    <td data-sort={r.name}><b>{r.name}</b>{r.sub ? <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{r.sub}</div> : null}</td>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 108, lineHeight: 1.35 }} data-sort={r.where}>{r.where}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }} data-sort={r.totalBytes ?? ''}>{bytesText(r.totalBytes)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }} data-sort={r.usedBytes ?? ''}>{bytesText(r.usedBytes)}</td>
                    <td data-sort={r.pct ?? ''}><PctCell p={r.pct} /></td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: r.partial ? 'var(--amber)' : undefined, whiteSpace: 'nowrap' }} data-sort={r.bps ?? ''}>
                      {fmtBps(r.bps)}
                      {r.measured ? <div style={{ fontSize: 11, fontWeight: 400, color: r.partial ? 'var(--amber)' : 'var(--text-dim)' }}>{r.measured}{r.kind === 'san' && r.pin ? ` · ${hoursLabel} ${peak ? '피크' : '평균'}` : ''}</div> : null}
                      {r.peakBps != null ? <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>피크 {fmtBps(r.peakBps)}{r.peakNote ? ` (${r.peakNote})` : ''}</div> : null}
                    </td>
                    <td className="muted" style={{ fontSize: 11, whiteSpace: 'normal', minWidth: 110, maxWidth: 138, lineHeight: 1.35 }}>{basis}</td>
                    <td>
                      {r.reason ? <span className="badge amber" style={{ fontSize: 11 }} title={reasonText(r.reason)}>{reasonBadge(r.reason)}</span>
                        : r.kind === 'bm' && (r.errors || r.pending) ? <span className="badge amber" style={{ fontSize: 11 }}>{r.errors ? `오류 ${r.errors}` : ''}{r.errors && r.pending ? ' · ' : ''}{r.pending ? `미수집 ${r.pending}` : ''}</span>
                          : r.partial ? <span className="badge amber" style={{ fontSize: 11 }}>부분 합</span>
                            : <span className="badge green" style={{ fontSize: 11 }}>정상</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>}
        <div className="bm2-foot">베어메탈 그룹은 서버가 여러 그룹(최대 3개)에 속할 수 있어 그룹 행의 합이 전체보다 클 수 있습니다. 부분 합(측정 불가 서버가 섞인 그룹)은 호박색으로 따로 표시하고 전체 합에는 측정된 서버만 넣습니다.{dcNames.length ? ' 법인을 골라 베어메탈 그룹은 그 법인 서버만으로 다시 합산했고 어레이는 그 법인 것만 남겼습니다.' : ''}</div>
      </div>

      {/* 한눈에 — 사용률(0~100) · 전송 속도(표 최댓값 대비) */}
      {shownRows.length > 0 && (
        <div className="card bm2-card">
          <div className="flex between wrap" style={{ alignItems: 'baseline', gap: '6px 12px', marginBottom: 10 }}>
            <div className="bm2-label">▸ 한눈에 <span style={{ letterSpacing: 0 }}>· 왼쪽 사용률(0~100%, 노란 선 = 75% 주의) · 오른쪽 전송 속도(표 최댓값 {fmtBps(glanceMax || null)} 대비)</span></div>
            <span className="muted" style={{ fontSize: 11.5 }}>같은 순서(사용률 높은 순) · 민트 = 베어메탈 · 파랑 = SAN</span>
          </div>
          <div className="bmc-glance">
            <div className="bmc-bars-h">이름</div><div className="bmc-bars-h">구분</div><div className="bmc-bars-h">사용률</div><div className="bmc-bars-h" style={{ textAlign: 'right' }}>%</div><div className="bmc-bars-h">전송 속도</div><div className="bmc-bars-h" style={{ textAlign: 'right' }}>값</div>
            {shownRows.map((r) => {
              const tag = kindTag(r.kind === 'bm' ? 'bm' : r.type);
              const color = r.kind === 'bm' ? 'var(--mint)' : 'var(--accent)';
              return (
                <React.Fragment key={r.key}>
                  <div className="bmc-gname"><b>{r.name}</b><small>{r.where}</small></div>
                  <span><span className={`badge ${tag.cls}`}>{tag.label}</span></span>
                  <div className="bmc-gbar">{r.pct != null && <span style={{ width: `${Math.min(100, r.pct)}%`, background: color }} />}<span className="bmc-mark" /></div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>{r.pct == null ? <span className="muted">—</span> : r.pct.toFixed(1)}</div>
                  <div className="bmc-gbar">{r.bps != null && glanceMax > 0 && <span style={{ width: `${Math.min(100, (r.bps / glanceMax) * 100)}%`, background: r.partial ? 'var(--amber)' : color }} />}</div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: r.partial ? 'var(--amber)' : undefined }}>{r.bps == null ? <span className="muted">— {r.reason ? reasonBadge(r.reason) : ''}</span> : fmtBps(r.bps)}</div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* 장비별 디스크 성능 차트(평균 · 피크 · 실시간 · 트렌드) */}
      <BmIoChart dcParam={dcParam} types={types} dcNames={dcNames} refreshKey={refreshKey} />

      {/* 베어메탈 서버별 디스크 I/O */}
      <div className="card bm2-card">
        <div className="flex between wrap" style={{ alignItems: 'center', gap: '6px 12px', marginBottom: ioOpen ? 10 : 0 }}>
          <div className="bm2-label">▸ 베어메탈 서버별 디스크 I/O <span style={{ letterSpacing: 0 }}>· {servers.length}대 · 수집 시점 {sampleSec}초 표본</span></div>
          <span className="flex wrap" style={{ alignItems: 'center', gap: 10 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>서버 전체 물리 디스크(sd · nvme · vd) 합 · dm · md · 파티션은 중복이라 세지 않음 · ‘바쁨’ 은 가장 바쁜 디스크 하나의 값</span>
            <button type="button" className="bm2-chip" onClick={() => setIoOpen((v) => !v)}>{ioOpen ? '접기' : '펼치기'}</button>
          </span>
        </div>
        {ioOpen && (servers.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>표시할 서버가 없습니다.</div> : (
          <STable minWidth={960}>
            <thead><tr><th>서버</th><th>법인</th><th>그룹</th><th style={{ textAlign: 'right' }}>물리 디스크</th><th style={{ textAlign: 'right' }}>읽기</th><th style={{ textAlign: 'right' }}>쓰기</th><th style={{ textAlign: 'right' }}>합계</th><th>바쁨 (가장 바쁜 디스크)</th><th>표본</th><th>상태</th></tr></thead>
            <tbody>
              {servers.map((s) => {
                const io = s.ok ? s.io : null;
                return (
                  <tr key={s.id}>
                    <td data-sort={s.name}><b>{s.name}</b></td>
                    <td className="muted" style={{ fontSize: 12 }} data-sort={s.datacenterName || ''}>{s.datacenterName || '(법인 미지정)'}{s.datacenterSource === 'edge' ? <span className="badge gray" style={{ fontSize: 10, marginLeft: 6 }} title="서버 폼에 법인이 없어 엣지의 법인으로 추정">엣지로 추정</span> : null}</td>
                    <td className="muted" style={{ fontSize: 12 }} data-sort={(s.groups || []).join(', ')}>{(s.groups || []).join(' · ') || '—'}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }} data-sort={io?.disks ?? ''}>{io ? io.disks : '—'}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }} data-sort={io?.readBps ?? ''}>{fmtBps(io?.readBps)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }} data-sort={io?.writeBps ?? ''}>{fmtBps(io?.writeBps)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600 }} data-sort={io?.totalBps ?? ''}>{fmtBps(io?.totalBps)}</td>
                    <td data-sort={io?.busyPct ?? ''}>{io && io.busyPct != null ? <><PctCell p={io.busyPct} /> <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{io.busiestDev}</span></> : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 11.5 }} data-sort={s.at || ''}>{s.at ? fmtAgo(s.at) : '—'}{io?.sampleMs ? ` · ${(io.sampleMs / 1000).toFixed(1)}초` : ''}</td>
                    <td>
                      {!s.ok ? <span className="badge red" style={{ fontSize: 11 }} title={s.error || ''}>{s.authStopped ? '인증 실패 정지' : s.error ? '수집 오류' : '수집 대기'}</span>
                        : io ? <span className="badge green" style={{ fontSize: 11 }}>측정 완료</span>
                          : <span className="badge amber" style={{ fontSize: 11 }} title={reasonText(s.ioError)}>측정 불가</span>}
                      {s.ok && !io && s.ioError ? <div className="muted" style={{ fontSize: 11, maxWidth: 280, whiteSpace: 'normal' }}>{reasonText(s.ioError)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        ))}
      </div>

      {/* 알아 둘 것 */}
      <div className="card bm2-card" style={{ padding: '16px 22px' }}>
        <div className="bm2-label">▸ 숫자를 비교할 때 알아 둘 것</div>
        <ul className="bmc-note">
          <li><b>용량의 뜻이 다릅니다.</b> 베어메탈은 df 의 used / (used + avail)(지정 마운트만, ext4 예약 블록 제외). SAN 은 Unisphere 가 보고한 <b>데이터 감축 후 실사용</b>이며 호스트에 약속한 씬 구독량이 아닙니다.</li>
          <li><b>전송 속도의 출처가 다릅니다.</b> 베어메탈은 서버에서 /proc/diskstats 를 {sampleSec}초 간격 두 번 읽은 <b>그 순간의 표본</b>(서버 전체 물리 디스크 합 — 마운트별이 아님). SAN 은 <b>SAN 스위치 포트 트래픽</b>을 어레이 시리얼로 묶은 {hoursLabel} 평균(또는 피크)이고, 어레이 자체 성능 API 는 수집하지 않습니다.</li>
          <li><b>시각이 다릅니다.</b> 베어메탈은 수집 주기(지금 {bm.settings?.intervalMinutes}분 · 현황 탭에서 1분까지)마다, ‘지금 측정’ 을 누르면 즉시 다시 잽니다. SAN 포트 표본은 {san.perfIntervalMs ? `${Math.round(san.perfIntervalMs / 60000)}분` : '포트 수집'} 주기, 용량 스냅샷은 스토리지 수집 주기입니다. 표의 ‘측정 기준’ 열이 각 값의 시각을 말합니다.</li>
          <li><b>못 읽은 값은 0 이 아닙니다.</b> 측정 불가 서버 · 시리얼 미대조 어레이는 ‘—’ 로 두고 합에서 빼며 몇 대가 빠졌는지 씁니다. 부분 합은 호박색입니다.</li>
        </ul>
      </div>
    </div>
  );
}

export { NONE_DC, measuredText };
