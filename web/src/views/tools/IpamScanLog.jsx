// IpamScanLog.jsx — IP관리 › 스캔 로그(v2.636). 스캔 시작·종료·실패·건너뜀·엣지 보고·보고 거부·설정 변경 기록.
// 폴링은 usePolling(10초) — 403(범위 제한 계정)이면 usePolling 이 스스로 멈춘다(정책 거부는 다시 물어도 같다).
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { agentText, countsText, durationText, emptyText, eventText, EVENT_TEXT, levelBadge, listHeadText, rangesText, repeatText, triggerText } from './ipamScanLogText.js';

const LIMITS = [100, 300, 1000];

export function IpamScanLog() {
  const [level, setLevel] = useState('');
  const [event, setEvent] = useState('');
  const [agent, setAgent] = useState('');
  const [limit, setLimit] = useState(300);
  const params = { limit, ...(level ? { level } : {}), ...(event ? { event } : {}), ...(agent.trim() ? { agent: agent.trim() } : {}) };
  const { data, error, errorInfo, loading } = usePolling('/admin/ipam/scan/log', params, 10_000);
  const filtered = !!(level || event || agent.trim());
  if (error && !data) return <ErrorBox message={errorInfo || error} />; // 403 은 HttpError 로 넘겨 권한 안내가 되게
  const rows = data?.entries || [];
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 15 }}>🧾 IP 스캔 로그</b>
        <span className="muted" style={{ fontSize: 12 }}>10초마다 새로 읽습니다</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        이 포탈의 스캔(수동·주기) 시작·종료·실패, 주기 스캔을 건너뛴 사유, 엣지 에이전트의 스캔 보고와 거부, 스캔 설정·대역 변경을 기록합니다.
        같은 사유로 연속 건너뛴 기록은 한 줄로 합치고 반복 횟수를 적습니다.
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="수준">
          <option value="">전체 수준</option>
          <option value="error">오류</option>
          <option value="warn">주의</option>
          <option value="info">정보</option>
        </select>
        <select className="select" value={event} onChange={(e) => setEvent(e.target.value)} aria-label="종류">
          <option value="">전체 종류</option>
          {Object.entries(EVENT_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" style={{ width: 180 }} placeholder="에이전트 이름(__local__ = 이 포탈)" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="에이전트" />
        <select className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="표시 개수">
          {LIMITS.map((n) => <option key={n} value={n}>최근 {n}건</option>)}
        </select>
      </div>
      {error && data && <div className="banner warn" style={{ marginBottom: 8 }}>로그를 다시 읽지 못했습니다 — 아래는 마지막으로 받은 기록입니다: {String(error?.message || error)}</div>}
      {loading && !data ? <Loading /> : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{listHeadText(data)}</div>
          <STable minWidth={980}>
            <thead><tr><th>시각</th><th>종류</th><th>수준</th><th>에이전트</th><th>계기</th><th>대역</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th style={{ textAlign: 'right' }}>소요</th><th>사용자</th><th>내용</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 20, whiteSpace: 'normal' }}>{emptyText(filtered)}</td></tr>}
              {rows.map((e, i) => {
                const [lv, tone] = levelBadge(e.level);
                return (
                  <tr key={`${e.at}-${i}`}>
                    <td data-sort={e.at} style={{ whiteSpace: 'nowrap' }}>{e.at ? new Date(e.at).toLocaleString('ko-KR') : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{eventText(e.event)}</td>
                    <td><span className={`badge ${tone}`}>{lv}</span></td>
                    <td>{agentText(e.agent)}</td>
                    <td>{triggerText(e.trigger)}</td>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 260 }}>{rangesText(e)}</td>
                    <td style={{ textAlign: 'right' }} data-sort={e.scanned ?? ''}>{countsText(e)}</td>
                    <td style={{ textAlign: 'right' }} className="muted" data-sort={e.durationMs ?? ''}>{durationText(e.durationMs)}</td>
                    <td className="muted">{e.user || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 220 }}>
                      {e.message || '—'}
                      {e.dropped ? <span className="muted"> · 받지 않은 항목 {Number(e.dropped).toLocaleString()}</span> : null}
                      {repeatText(e) && <div className="muted" style={{ fontSize: 11 }}>{repeatText(e)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </>
      )}
    </div>
  );
}
