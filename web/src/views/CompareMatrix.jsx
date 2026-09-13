import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, usePolling } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';
// 공용 표 컴포넌트 규약(CLAUDE.md): 새 표는 <table> 대신 <STable>. 이 표는 th 에 onClick 이 있어
// STable 이 '자체 정렬 표' 로 보고 손대지 않는다 — 규약을 지키면서 동작은 그대로다.
import { STable } from '../components/STable.jsx';
import {
  cellText, cellColor, metricStats, sortRows, vcenterRows, truncatedNote, cellTitle, sparsityNote,
} from './compareMatrixText.js';

/**
 * CompareMatrix.jsx — 비교 매트릭스 모달(v2.499).
 *
 * 사용자 요구: "비교하기 누르면 vCenter 별 비교·클러스터별 비교·스토리지별 비교로 보여주는 방식은,
 * 이런 매트릭스로 **가로축은 vCenter, 세로축은 클러스터**인 상태를 보여주는 기능"(서비스 허브의
 * 저장소 비교표 형식). 예전 '비교하기' 는 vCenter 2개만 나란히 놓는 표였다 — 28개 사이트에서
 * 'PROD 클러스터가 어느 법인에서 위험한가' 를 보려면 14번을 눌러야 했다. 매트릭스는 한 화면이다.
 *
 * 축 3종:
 *  · vCenter — 지표(행) × vCenter(열). `/vcenters` 의 metrics 를 전치해 쓴다(서버 재계산 없음).
 *  · 클러스터 · 스토리지 — `/compare/matrix?axis=` (스냅샷 집계, vCenter 왕복 0).
 *
 * 표시 규약(정직):
 *  · 그 vCenter 에 그 이름이 없으면 **'—'**. 0 으로 채우지 않는다(없는 것과 0 은 다르다).
 *  · 색은 비교 대상 안에서의 **상대 위치**(+ 퍼센트 지표는 절대 90/75% 기준 병행) — 절대 임계만
 *    쓰면 전 사이트가 한가한 날엔 아무것도 안 보이고, 다 바쁜 날엔 전부 빨개져 비교가 안 된다.
 *  · 행 상한에 걸리면 모집단·생략 수를 문구로 밝힌다. 판정·문구는 순수 모듈에 두고 테스트로 고정.
 */
const AXES = [
  { k: 'vcenter', label: 'vCenter 별', help: 'vCenter 전체 지표를 나란히 비교합니다(행=지표, 열=vCenter).' },
  { k: 'cluster', label: '클러스터별', help: '같은 이름의 클러스터를 사이트별로 비교합니다(행=클러스터, 열=vCenter).' },
  { k: 'datastore', label: '스토리지별', help: '같은 이름의 데이터스토어를 사이트별로 비교합니다(행=데이터스토어, 열=vCenter).' },
];

// vCenter 축에서 쓸 지표(= /vcenters metrics 키). 서버 축 지표는 API 가 함께 내려준다.
const VC_METRICS = [
  { key: 'cpuUsagePct', label: 'CPU 사용률', unit: '%', higher: 'bad' },
  { key: 'memUsagePct', label: '메모리 사용률', unit: '%', higher: 'bad' },
  { key: 'storageUsagePct', label: '스토리지 사용률', unit: '%', higher: 'bad' },
  { key: 'alarmsCritical', label: '심각 알람', higher: 'bad' },
  { key: 'alarmsWarning', label: '경고 알람', higher: 'bad' },
  { key: 'hosts', label: '호스트', higher: 'neutral' },
  { key: 'vms', label: 'VM', higher: 'neutral' },
  { key: 'vmsPoweredOn', label: 'VM(On)', higher: 'neutral' },
  { key: 'cpuTotalGhz', label: 'CPU 총량', unit: ' GHz', higher: 'neutral' },
  { key: 'memTotalGB', label: '메모리 총량', unit: ' GB', higher: 'neutral' },
  { key: 'storageTotalTB', label: '스토리지 총량', unit: ' TB', higher: 'neutral' },
  { key: 'powerKw', label: '소비전력', unit: ' kW', higher: 'neutral' },
];

const HEAT = { red: 'rgba(248,113,113,.22)', amber: 'rgba(251,191,36,.20)', green: 'rgba(74,222,128,.16)' };
const TEXT = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)' };

export default function CompareMatrix({ onClose, initialAxis = 'cluster' }) {
  const [axis, setAxis] = useState(AXES.some((a) => a.k === initialAxis) ? initialAxis : 'cluster');
  const [metricKey, setMetricKey] = useState('cpuUsagePct');
  const [normalize, setNormalize] = useState(false); // 이름의 사이트 접두 제거(휴리스틱)
  const [sortBy, setSortBy] = useState('total');   // 'total' | vCenter id | 'name'
  const [sortDir, setSortDir] = useState('desc');
  // vCenter 목록은 폴링(30초) — 축이 vCenter 일 때 데이터 원본이고, 다른 축에서는 열 이름에 쓴다.
  const { data: vcList, error: vcErr } = usePolling('/vcenters', {}, 30_000);
  const [srv, setSrv] = useState(null);            // /compare/matrix 응답
  const [srvErr, setSrvErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (axis === 'vcenter') return undefined;
    let alive = true;
    setLoading(true); setSrvErr('');
    fetchJson('/compare/matrix', { axis, ...(normalize ? { normalize: 1 } : {}) })
      .then((r) => { if (alive) { setSrv(r); setSrvErr(''); } })
      .catch((e) => { if (alive) { setSrv(null); setSrvErr(e.message || String(e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [axis, normalize]);

  // 축이 바뀌면 그 축의 첫 지표로 맞춘다(없는 지표를 들고 있으면 표가 전부 '—' 가 된다).
  // useMemo 로 안정화한다 — 매 렌더 새 배열이면 아래 useEffect 가 매번 돈다.
  const metrics = useMemo(() => (axis === 'vcenter' ? VC_METRICS : (srv?.metrics || [])), [axis, srv]);
  useEffect(() => {
    if (!metrics.length) return;
    if (!metrics.some((m) => m.key === metricKey)) setMetricKey(metrics[0].key);
  }, [axis, metrics, metricKey]);

  const built = useMemo(() => {
    if (axis === 'vcenter') return vcenterRows(vcList || [], VC_METRICS);
    return { vcenters: srv?.vcenters || [], rows: srv?.rows || [] };
  }, [axis, vcList, srv]);

  const metric = metrics.find((m) => m.key === metricKey) || metrics[0] || null;
  // vCenter 축은 행마다 지표가 달라 표 전체 모수가 무의미하다 → 행 단위 모수.
  const perRowStats = axis === 'vcenter';
  const tableStats = useMemo(
    () => (perRowStats || !metric ? null : metricStats(built.rows, metric.key)),
    [perRowStats, built.rows, metric],
  );

  const rows = useMemo(() => {
    if (axis === 'vcenter') return built.rows;     // 지표 순서 고정(사용자가 찾는 순서)
    if (!metric) return built.rows;
    if (sortBy === 'name') {
      const s = [...built.rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return sortDir === 'asc' ? s : s.reverse();
    }
    return sortRows(built.rows, metric.key, { by: sortBy, dir: sortDir });
  }, [axis, built.rows, metric, sortBy, sortDir]);

  const clickHeader = (by) => {
    if (axis === 'vcenter') return;                // 행이 지표라 열 정렬이 의미 없다
    if (sortBy === by) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(by); setSortDir('desc'); }
  };
  const arrow = (by) => (axis === 'vcenter' || sortBy !== by ? '' : (sortDir === 'desc' ? ' ▼' : ' ▲'));

  const axisInfo = AXES.find((a) => a.k === axis);
  const axisLabel = axis === 'datastore' ? '데이터스토어' : axis === 'cluster' ? '클러스터' : 'vCenter';
  const note = axis === 'vcenter' ? '' : truncatedNote({ ...srv, rows: built.rows }, axisLabel);
  const sparse = axis === 'vcenter' ? null : sparsityNote(built.rows, axisLabel);
  const err = axis === 'vcenter' ? (vcErr && !vcList ? vcErr : '') : (srvErr && !srv ? srvErr : '');

  const cellFor = (row, vcId) => {
    const cell = row.cells?.[vcId];
    const mk = axis === 'vcenter' ? (row.metric?.key || metric?.key) : metric?.key;
    const mt = axis === 'vcenter' ? row.metric : metric;
    const value = cell ? cell[mk] : null;
    const stats = perRowStats ? metricStats([row], mk) : tableStats;
    const color = cellColor(value, mt, stats);
    return { value, mt, color, title: cellTitle({ rowName: row.name, vcName: (built.vcenters.find((v) => v.id === vcId) || {}).name || vcId, metric: mt, value, cell }) };
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 1440, width: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex between wrap" style={{ marginBottom: 10, alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 15, minWidth: 0 }}>⇄ 비교 매트릭스</b>
          <span className="flex gap wrap" style={{ alignItems: 'center', gap: 6 }}>
            {AXES.map((a) => (
              <button key={a.k} className={axis === a.k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }}
                onClick={() => setAxis(a.k)} title={a.help}>{a.label}</button>
            ))}
            {axis !== 'vcenter' && (
              <label className="muted flex gap" style={{ alignItems: 'center', gap: 5, fontSize: 12, flex: 'none', cursor: 'pointer' }}
                title={'이름 앞의 사이트 접두(첫 - 앞)를 떼어 같은 역할끼리 한 행으로 묶습니다. 예: Ashburn-CL1 · Dublin-CL1 → CL1.\n이름 규약이 다르면 잘못 묶일 수 있는 휴리스틱이며, 합쳐진 원래 이름은 행 툴팁에 표시됩니다.'}>
                <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> 접두 제거
              </label>
            )}
            {axis !== 'vcenter' && metrics.length > 0 && (
              <select className="select" style={{ width: 168 }} value={metricKey} onChange={(e) => setMetricKey(e.target.value)}
                title="표의 셀에 표시할 지표">
                {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            )}
            <button className="logout-btn" style={{ flex: 'none' }} onClick={onClose}>닫기</button>
          </span>
        </div>

        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
          {axisInfo?.help}
          {axis !== 'vcenter' && <> 셀 색은 <b>이 표 안에서의 상대 위치</b>이며 사용률 지표는 90%↑ 빨강·75%↑ 주황을 함께 적용합니다.
            그 vCenter 에 그 {axisLabel} 이 없으면 <b>—</b> 로 두고 0 으로 채우지 않습니다.</>}
          {axis === 'vcenter' && <> 행마다 지표가 다르므로 색은 <b>그 행 안에서의</b> 상대 위치입니다. 규모 지표(호스트·VM·총량·전력)는 색을 칠하지 않습니다.</>}
          {note && <> {note}</>}
          {srv?.source === 'mock' && <> · 데모(mock) 데이터입니다.</>}
        </div>
        {sparse && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8, color: 'var(--amber)', overflowWrap: 'anywhere' }}>
            ⚠ {sparse}
            {!normalize && <> 이름이 <code>사이트-역할</code> 형태라면 위 <b>접두 제거</b> 를 켜 보세요(휴리스틱).</>}
          </div>
        )}

        {err ? <ErrorBox message={err} /> : (loading && !built.rows.length) ? <Loading /> : (
          <div style={{ overflow: 'auto', flex: 1, minHeight: 120 }}>
            <STable className="data-table" style={{ width: '100%', fontSize: 12.5, borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--card, #0f172a)', cursor: axis === 'vcenter' ? 'default' : 'pointer', minWidth: 190 }}
                    onClick={() => clickHeader('name')} title={axis === 'vcenter' ? '' : '이름순 정렬'}>
                    {axis === 'vcenter' ? '지표' : axisLabel}{arrow('name')}
                  </th>
                  {built.vcenters.map((v) => (
                    <th key={v.id} style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--card, #0f172a)', cursor: axis === 'vcenter' ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                      onClick={() => clickHeader(v.id)} title={axis === 'vcenter' ? v.name : `${v.name} 기준 정렬`}>
                      {v.name}{arrow(v.id)}
                    </th>
                  ))}
                  {axis !== 'vcenter' && (
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--card, #0f172a)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      onClick={() => clickHeader('total')} title="전 vCenter 합계 기준 정렬">합계{arrow('total')}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--card, #0f172a)', overflowWrap: 'anywhere' }}
                      title={axis === 'vcenter' ? (row.metric?.help || '')
                        : `${row.name} · ${row.vcenters}개 vCenter 에 존재${row.origNames?.length ? `\n합쳐진 원래 이름: ${row.origNames.join(', ')}` : ''}`}>
                      {row.name}
                      {axis !== 'vcenter' && <span className="muted" style={{ fontSize: 11 }}> ({row.vcenters})</span>}
                      {row.origNames?.length ? <span className="muted" style={{ fontSize: 11 }}> ·묶음 {row.origNames.length}</span> : null}
                    </td>
                    {built.vcenters.map((v) => {
                      const c = cellFor(row, v.id);
                      return (
                        <td key={v.id} title={c.title}
                          style={{ textAlign: 'right', background: c.color ? HEAT[c.color] : undefined, color: c.color ? TEXT[c.color] : undefined, fontWeight: c.color === 'red' ? 700 : 500, whiteSpace: 'nowrap' }}>
                          {cellText(c.value, c.mt)}
                        </td>
                      );
                    })}
                    {axis !== 'vcenter' && (
                      <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}
                        title={`${row.name} 전 vCenter 합계`}>{cellText(row.total?.[metric?.key], metric)}</td>
                    )}
                  </tr>
                ))}
                {axis !== 'vcenter' && srv?.colTotals && (
                  <tr>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--card, #0f172a)', fontWeight: 700 }}>합계</td>
                    {built.vcenters.map((v) => (
                      <td key={v.id} style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}
                        title={`${v.name} 전체(표시된 행 기준)`}>{cellText(srv.colTotals[v.id]?.[metric?.key], metric)}</td>
                    ))}
                    <td />
                  </tr>
                )}
                {!rows.length && (
                  <tr><td colSpan={built.vcenters.length + 2} className="muted" style={{ padding: 14 }}>
                    표시할 {axisLabel} 이 없습니다{axis !== 'vcenter' ? ' — 스냅샷에 해당 자원이 없거나 접근 범위 밖입니다.' : '.'}
                  </td></tr>
                )}
              </tbody>
            </STable>
          </div>
        )}

        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          {axis !== 'vcenter' && <>행의 <b>(n)</b> 은 그 이름이 존재하는 vCenter 수입니다. 열 <b>합계</b> 는 표시된 행만 합산합니다.
            같은 이름의 데이터스토어가 한 vCenter 에 여러 개면 합산하고 개수를 툴팁에 밝힙니다. </>}
          수치는 마지막 수집 스냅샷 기준이며({srv?.generatedAt ? new Date(srv.generatedAt).toLocaleString('ko-KR') : '조회 시점'}) 이 화면은 vCenter 를 다시 조회하지 않습니다.
          사용률은 순간값이라 감축·증설 판단에는 기간 추이를 함께 보세요.
        </div>
      </div>
    </div>
  );
}
