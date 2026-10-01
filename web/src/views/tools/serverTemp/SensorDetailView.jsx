/**
 * 서버 온도 › 센서 상세(v2.659) — iDRAC 이 수집하는 전 센서를 서버별로 본다.
 *
 * 쓰임새(사용자 요청): 흡기 → 전산실 온도(법인별) · CPU 온도 + CPU 사용률 → CPU 부하 · GPU 온도 → GPU 동작 근거.
 * 판정은 서버(`/tools/esxi-temp/sensors`)가 한다 — 이 화면은 `sensorDetailText.js` 로 읽기만 한다.
 * 폴링하지 않는다(마운트 1회 + 새로고침 버튼) — 캐시만 읽는 API 지만 서버 1천 대 × 센서 수백 개라 응답이 크다.
 * 훅은 전부 조기 return 위에 둔다(React #310).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { DataTable, Loading, ErrorBox, Modal, Kpi, SearchBox } from '../../../components/ui.jsx';
import { STable } from '../../../components/STable.jsx';
import { agoText } from '../relTime.js';
import {
  STATE_TEXT, STATE_BADGE, ROLE_TEXT, FILTERS, filterRows, filterCounts, groupSensors, readingText, thresholdText,
  tempText, cpuCell, detailStateText, collectionNote, ROLE_NOTE, GPU_NOTE, CPU_NOTE, detailSortValue, cpuSortValue,
} from './sensorDetailText.js';

const int = (v) => Number(v || 0).toLocaleString();

function SensorModal({ id, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    setD(null); setErr(null);
    fetchJson(`/tools/esxi-temp/sensors/${encodeURIComponent(id)}`)
      .then((r) => { if (active) setD(r); })
      .catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [id]);
  const groups = useMemo(() => groupSensors(d?.sensors || []), [d]);
  const s = d?.summary;
  const notes = d ? collectionNote(d) : [];
  return (
    <Modal title={`센서 상세 — ${d?.server?.name || ''}`} onClose={onClose} width={1100}>
      {err ? <ErrorBox error={err} /> : !d ? <Loading /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
            {[d.server.serviceTag && `서비스태그 ${d.server.serviceTag}`, d.server.model, d.server.remote ? '엣지 위임' : '중앙 직접 수집',
              `온도·팬 ${agoText(d.thermalAt)}`, `전체 센서 ${agoText(d.collection?.sensorsAt)}`].filter(Boolean).join(' · ')}
            {d.synthesized && <span className="badge amber" style={{ marginLeft: 8 }}>데모 합성</span>}
          </div>
          {s ? (
            <div className="kpis">
              <Kpi label="흡기(전산실)" value={tempText(s.inletC)} meta={s.inletCount > 1 ? `흡기 센서 ${s.inletCount}개 중 최고` : (s.inletCount ? '흡기 센서 1개' : '흡기 센서 없음')} />
              <Kpi label="CPU 온도" value={tempText(s.cpuTempMaxC)} meta={s.cpuTempCount ? `${s.cpuTempCount}개 · 평균 ${tempText(s.cpuTempAvgC)}` : '센서 없음'} />
              <Kpi label="GPU 온도" value={tempText(s.gpuTempMaxC)} meta={s.gpuTempCount ? `${s.gpuTempCount}개 · 평균 ${tempText(s.gpuTempAvgC)}` : 'GPU 온도 센서 없음'} />
              <Kpi label="센서 상태" value={`${int(s.counts.crit)} / ${int(s.counts.warn)}`} meta={`위험 / 경고 · 전체 ${int(s.total)} · 판정 불가 ${int(s.counts.unknown)}`}
                accent={s.counts.crit ? 'var(--red)' : s.counts.warn ? 'var(--amber)' : undefined} />
            </div>
          ) : <div className="muted">이 서버의 센서 상세가 아직 없습니다(첫 수집 전이거나 엣지가 2.659 이전입니다).</div>}
          {notes.map((n) => <div key={n} className="muted" style={{ fontSize: 12, color: 'var(--amber)', overflowWrap: 'anywhere' }}>{n}</div>)}
          {groups.map((g) => (
            <div key={g.kind} style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, margin: '4px 0 6px' }}>{g.label} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{g.rows.length}개</span></div>
              <STable className="table" minWidth={880}>
                <thead>
                  <tr><th>상태</th><th>센서</th><th>역할</th><th>값</th><th>경고 최소</th><th>경고 최대</th><th>위험 최소</th><th>위험 최대</th></tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={`${r.kind}|${r.name}`}>
                      <td data-sort={r.state}><span className={`badge ${STATE_BADGE[r.state] || 'gray'}`} title={r.health ? `장비 Health: ${r.health}` : '장비가 준 임계값으로 판정'}>{STATE_TEXT[r.state] || r.state}</span></td>
                      <td>{r.name}</td>
                      <td className="muted">{ROLE_TEXT[r.role] || '—'}</td>
                      <td data-sort={r.reading ?? ''}><b>{readingText(r)}</b></td>
                      <td data-sort={r.thresholds?.warnMin ?? ''}>{thresholdText(r.thresholds?.warnMin, r.unit)}</td>
                      <td data-sort={r.thresholds?.warnMax ?? ''}>{thresholdText(r.thresholds?.warnMax, r.unit)}</td>
                      <td data-sort={r.thresholds?.critMin ?? ''}>{thresholdText(r.thresholds?.critMin, r.unit)}</td>
                      <td data-sort={r.thresholds?.critMax ?? ''}>{thresholdText(r.thresholds?.critMax, r.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11.5 }}>{ROLE_NOTE} 임계값 '—' 는 장비가 값을 주지 않은 것입니다(포탈이 임계를 정하지 않습니다).</div>
        </div>
      )}
    </Modal>
  );
}

export default function SensorDetailView({ scope }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [gen, setGen] = useState(0);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson(`/tools/esxi-temp/sensors${scope ? `?vcenterId=${encodeURIComponent(scope)}` : ''}`)
      .then((r) => { if (active) setData(r); })
      .catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [scope, gen]);
  const rows = useMemo(() => filterRows(data?.rows || [], { filter, q }), [data, filter, q]);
  const counts = useMemo(() => filterCounts(data?.rows || []), [data]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const S = data.summary || {};
  const columns = [
    { key: 'name', label: '서버', render: (r) => <button className="cell-link" onClick={() => setOpen(r.id)} title="전 센서 보기">{r.name}</button> },
    { key: 'dcLabel', label: '법인', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.dcLabel}</span> },
    { key: 'inlet', label: '흡기 ℃', align: 'right', sortValue: (r) => detailSortValue(r, 'inletC'), render: (r) => tempText(r.detailState === 'ok' ? r.summary?.inletC : null) },
    { key: 'exhaust', label: '배기 ℃', align: 'right', sortValue: (r) => detailSortValue(r, 'exhaustC'), render: (r) => tempText(r.detailState === 'ok' ? r.summary?.exhaustC : null) },
    { key: 'cpuT', label: 'CPU 온도', align: 'right', sortValue: (r) => detailSortValue(r, 'cpuTempMaxC'), render: (r) => tempText(r.detailState === 'ok' ? r.summary?.cpuTempMaxC : null) },
    {
      key: 'cpu', label: 'CPU 사용률', align: 'right', sortValue: (r) => cpuSortValue(r),
      render: (r) => { const c = cpuCell(r.cpu); return <span title={c.title}><b style={c.stale ? { color: 'var(--text-dim)' } : undefined}>{c.text}</b>{c.sub && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{c.sub}</span>}</span>; },
    },
    {
      key: 'gpu', label: 'GPU 온도', align: 'right', sortValue: (r) => detailSortValue(r, 'gpuTempMaxC'),
      render: (r) => (r.detailState === 'ok' && r.summary?.gpuTempCount
        ? <span title={`GPU 온도 센서 ${r.summary.gpuTempCount}개 · 평균 ${tempText(r.summary.gpuTempAvgC)}`}>{tempText(r.summary.gpuTempMaxC)}<span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>×{r.summary.gpuTempCount}</span></span>
        : <span className="muted">—</span>),
    },
    {
      key: 'state', label: '상태', sortValue: (r) => (r.detailState !== 'ok' ? 9 : ({ crit: 0, warn: 1, unknown: 2, ok: 3 }[r.summary?.worst] ?? 5)),
      render: (r) => { const t = detailStateText(r); return <span className={`badge ${t.badge}`} title={t.title}>{t.text}</span>; },
    },
    { key: 'total', label: '센서', align: 'right', sortValue: (r) => r.summary?.total ?? 0, render: (r) => (r.summary ? int(r.summary.total) : '—') },
    { key: 'at', label: '수집', align: 'right', sortValue: (r) => r.at ?? 0, render: (r) => <span className="muted" style={{ fontSize: 12 }}>{agoText(r.at)}</span> },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {data.synthesized && <div className="card" style={{ borderColor: 'var(--amber)' }}><span className="muted">데모(mock) 환경입니다 — iDRAC 센서는 합성값입니다.</span></div>}
      <div className="kpis">
        <Kpi label="전산실 온도(흡기)" value={tempText(S.inletAvgC)} meta={S.inletCount ? `평균 · 최고 ${tempText(S.inletMaxC)} · ${int(S.inletCount)}대` : '흡기 값을 읽은 서버 없음'} />
        <Kpi label="CPU 온도 최고" value={tempText(S.cpuTempMaxC)} meta={`CPU 사용률 수집 ${int(S.cpuRead)}대`} />
        <Kpi label="GPU 온도 최고" value={tempText(S.gpuTempMaxC)} meta={S.gpuServers ? `GPU 센서가 있는 서버 ${int(S.gpuServers)}대` : 'GPU 온도 센서 없음'} />
        <Kpi label="경고·위험 서버" value={`${int(S.serversCrit)} / ${int(S.serversWarn)}`} meta={`위험 / 경고 · 센서 ${int(S.critSensors)} / ${int(S.warnSensors)}`}
          accent={S.serversCrit ? 'var(--red)' : S.serversWarn ? 'var(--amber)' : undefined} onClick={() => setFilter('alert')} title="경고·위험 서버만 보기" />
        <Kpi label="상세 수집" value={`${int(S.withDetail)} / ${int(S.servers)}`} meta={`수집 전 ${int(S.none)} · 오래됨 ${int(S.stale)}`} onClick={S.none || S.stale ? () => setFilter('nodetail') : undefined} />
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>법인별 전산실 온도 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>흡기 센서 기준 · 신선한 값만</span></div>
        <STable className="table" minWidth={760}>
          <thead><tr><th>법인</th><th>서버</th><th>흡기 평균</th><th>흡기 최고</th><th>흡기 못 읽음</th><th>CPU 온도 최고</th><th>GPU 온도 최고</th><th>위험 / 경고 센서</th></tr></thead>
          <tbody>
            {(data.byDatacenter || []).map((g) => (
              <tr key={g.datacenterId || '(none)'}>
                <td>{g.label}</td>
                <td data-sort={g.servers}>{int(g.servers)}</td>
                <td data-sort={g.inletAvgC ?? ''}><b>{tempText(g.inletAvgC)}</b></td>
                <td data-sort={g.inletMaxC ?? ''}>{tempText(g.inletMaxC)}</td>
                <td data-sort={g.noInlet}>{g.noInlet ? int(g.noInlet) : '—'}</td>
                <td data-sort={g.cpuTempMaxC ?? ''}>{tempText(g.cpuTempMaxC)}</td>
                <td data-sort={g.gpuTempMaxC ?? ''}>{tempText(g.gpuTempMaxC)}</td>
                <td data-sort={g.critSensors * 1000 + g.warnSensors}>{g.critSensors || g.warnSensors ? `${int(g.critSensors)} / ${int(g.warnSensors)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          {FILTERS.map(([k, l]) => (
            <button key={k} className={filter === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => { setFilter(k); setLimit(100); }}>
              {l} {int(counts[k])}
            </button>
          ))}
          <SearchBox value={q} onChange={setQ} placeholder="서버·서비스태그·법인·모델" style={{ minWidth: 0, width: 240, maxWidth: '100%' }} />
          <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setGen((g) => g + 1)} title="다시 불러오기(장비에 접속하지 않습니다 — 수집된 값을 다시 읽습니다)">새로고침</button>
        </div>
        <DataTable
          rows={rows} columns={columns} initialSort={{ key: 'inlet', dir: 'desc' }}
          className="sd-table" maxHeight="64vh" limit={limit}
          emptyText="조건에 맞는 서버가 없습니다."
          footer={rows.length > limit ? (
            <div className="muted" style={{ fontSize: 12, padding: '8px 12px' }}>
              {int(rows.length)}대 중 {int(limit)}대 표시 <button className="tab" style={{ marginLeft: 8, padding: '3px 10px', fontSize: 12 }} onClick={() => setLimit((n) => n + 200)}>200대 더</button>
            </div>
          ) : null} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span>{ROLE_NOTE}</span><span>{CPU_NOTE}</span><span>{GPU_NOTE}</span>
          {data.addressHidden && <span>관리 주소는 관리자에게만 보입니다(IP 로 등록된 서버 이름은 가렸습니다).</span>}
          {data.cpuSource?.bmEnabled === false && <span>베어메탈 사용률 수집이 꺼져 있습니다 — CPU 사용률은 iDRAC 텔레메트리·센서 값이 있는 서버만 나옵니다.</span>}
        </div>
      </div>

      {open && <SensorModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
