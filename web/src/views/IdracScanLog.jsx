import React, { useEffect, useState } from 'react';
import { usePolling, fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 → 수집 서버 → 스캔 로그 — 주기/수동 iDRAC 스캔의 법인(DataCenter)별 실행 이력.
 * 전체 통합 보기 또는 법인별 필터로 조회한다(서버 영속 저장 — 재시작 후에도 유지).
 * 위임 스캔은 '요청'과 '결과'가 2건으로 남는다(에이전트 회신 시 결과 1건 추가, reqId로 짝).
 */
export default function IdracScanLog() {
  const [dc, setDc] = useState('');            // '' = 전체 통합
  const [trigger, setTrigger] = useState('');  // '' | periodic | manual
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [datacenters, setDatacenters] = useState([]); // 법인 id → 이름 표시용
  const { data, error, loading } = usePolling('/admin/idrac/scan-log', { datacenterId: dc, limit: 500 }, 30_000);

  useEffect(() => {
    fetchJson('/admin/datacenters').then((d) => setDatacenters(d.datacenters || [])).catch(() => {});
  }, []);
  const dcName = (id) => (datacenters.find((d) => d.id === id)?.name || id || '');

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const all = data?.entries || [];
  // 법인 필터는 서버에서 적용(법인별 최대 500건 보장). 구분/오류 필터는 클라이언트에서.
  const rows = all.filter((e) => (!trigger || e.trigger === trigger) && (!errorsOnly || e.error));
  // 필터 옵션: 로그에 등장한 법인 전체(서버 집계 — 현재 필터와 무관하게 항상 전체 목록).
  const dcOptions = data?.datacenters || [];
  const errCount = rows.filter((e) => e.error).length;

  const fmtDur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}초`);
  const resultCell = (e) => {
    if (e.error) return <span style={{ color: '#f87171' }} title={e.error}>오류: {e.error.slice(0, 80)}</span>;
    if (e.phase === 'dispatch') return <span style={{ color: '#fbbf24' }}>위임 요청됨 — 에이전트 결과 대기(결과는 별도 행)</span>;
    if (e.stopped) return <span style={{ color: '#fbbf24' }}>중단됨(부분 결과)</span>;
    return <span style={{ color: '#4ade80' }}>성공</span>;
  };
  const kindCell = (e) => (e.kind === 'delegated'
    ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }} title={`위임 전달 방식: ${e.dispatch === 'push' ? '중앙→엣지 직접(PUSH)' : '에이전트 폴링(poll)'}`}>위임 {e.agent || ''}{e.dispatch === 'push' ? ' ·push' : ''}</span>
    : <span className="muted">중앙 직접</span>);

  return (
    <div className="card">
      <div className="section-title" style={{ margin: '6px 0' }}>📜 iDRAC 스캔 로그 — 주기/수동 스캔 실행 이력 (관리자)</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        주기 스캐너와 수동 스캔이 법인(DataCenter)별로 남긴 실행 기록입니다(서버 저장 — 재시작 후에도 유지, 최근 2,000건 보관).
        <b> 전체(통합)</b>로 모든 법인을 한 번에 보거나, 법인을 선택해 그 법인의 이력만 볼 수 있습니다.
      </div>
      {error && <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8, fontSize: 12, background: 'rgba(245,158,11,.14)', color: '#fbbf24' }}>일시적 갱신 오류: {String(error)} — 직전 데이터를 표시 중입니다.</div>}

      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="select" value={dc} onChange={(e) => setDc(e.target.value)} title="법인 필터 — 전체(통합) 또는 특정 법인만">
          <option value="">전체 (통합)</option>
          {dcOptions.map((id) => <option key={id} value={id}>{dcName(id)} ({id})</option>)}
        </select>
        <select className="select" value={trigger} onChange={(e) => setTrigger(e.target.value)} title="실행 구분 필터">
          <option value="">주기+수동 전체</option>
          <option value="periodic">주기 스캔만</option>
          <option value="manual">수동 스캔만</option>
        </select>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> 오류만
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {rows.length.toLocaleString()}건 표시{errCount ? <span style={{ color: '#f87171' }}> · 오류 {errCount}건</span> : ''} · 30초마다 자동 갱신
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: '12px 0' }}>
          표시할 로그가 없습니다. 스캔이 실행되면(주기 스캐너 또는 ‘지금 스캔’) 여기에 실행 기록이 쌓입니다.
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: '62vh' }}>
          <table>
            <thead><tr>
              <th>시각</th><th>법인</th><th>서비스</th><th>구분</th><th>방식</th>
              <th style={{ textAlign: 'right' }}>스캔</th><th style={{ textAlign: 'right' }}>발견</th><th style={{ textAlign: 'right' }}>등록</th>
              <th>소요</th><th>결과</th>
            </tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.at}-${e.reqId || ''}-${i}`}>
                  <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{e.at ? new Date(e.at).toLocaleString('ko-KR') : '—'}</td>
                  <td>{e.datacenterId ? <b>{dcName(e.datacenterId)}</b> : <span className="muted">(직접 스캔)</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{e.service || '—'}</td>
                  <td><span className="badge" style={e.trigger === 'periodic'
                    ? { background: 'rgba(96,165,250,.18)', color: '#93c5fd' }
                    : { background: 'rgba(52,211,153,.16)', color: '#34d399' }}>{e.trigger === 'periodic' ? '주기' : '수동'}</span></td>
                  <td>{kindCell(e)}</td>
                  <td style={{ textAlign: 'right' }}>{e.scanned != null ? e.scanned.toLocaleString() : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{e.found != null ? <b>{e.found.toLocaleString()}</b> : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{e.registered != null ? e.registered.toLocaleString() : '—'}</td>
                  <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDur(e.durationMs)}</td>
                  <td style={{ fontSize: 12 }}>{resultCell(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
