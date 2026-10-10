// IpamScanStatus.jsx — IP관리 › 스캔 진행 막대 · 완료된 스캔 이력 표 · 스캔 상태 페이지. v2.639 에 IpamSettings.jsx(853줄)에서 나눴다.
// v2.639(U2): 완료된 스캔 이력 표는 `ScanRunsTable` 하나다 — 예전에는 IpamRanges(대역·스캔 페이지)와 ScanStatusModal 이 같은
//   runs 를 다른 형식(시각·소요 포매터 2벌)으로 그렸다. 시각·소요는 ipamShared 의 fmtDt·fmtDur.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { numOrNull } from '../../numOrNull.js';
import { agentLabel, fmtDt, fmtDur, Frame } from './ipamShared.jsx';

/*
 * v2.733(점검 3회차 C1-02): 스캔이 시한을 넘기거나 실패하면 서버가 그 에이전트의 '스캔 미완료' 를 기록하고(reports[이름].incomplete),
 *   해제(down) 판정은 완료된 스캔이 해제 기준 시간 안에 올 때까지 보류한다(status.releaseHold). 이 두 줄이 그 사실을 짧게 말한다 —
 *   말하지 않으면 사용자는 '스캔 실패' 와 'IP 가 그대로 사용 중' 을 이어 보지 못한다. 판정은 서버가 했다(여기서는 문장만).
 */
const HOLD_REASON_TEXT = { 'scan-incomplete': '마지막 스캔 미완료', 'no-recent-scan': '완료 보고 없음' };
const LIST_MAX = 8;

/** 스캔 미완료 줄(이 포탈 + 엣지) — 마지막 완료보다 새 미완료 기록만. 모르는 값은 '—'. */
export function scanIncompleteLines(reports) {
  const rows = [];
  for (const [name, rep] of Object.entries(reports && typeof reports === 'object' ? reports : {})) {
    const inc = rep?.incomplete;
    if (!inc || typeof inc !== 'object') continue;
    const at = numOrNull(inc.at); const doneAt = numOrNull(rep.at);
    if (at == null || (doneAt != null && doneAt > at)) continue;
    rows.push({ name, at, doneAt, inc });
  }
  rows.sort((a, b) => b.at - a.at);
  const out = rows.slice(0, LIST_MAX).map(({ name, at, doneAt, inc }) => {
    const why = inc.code === 'SCAN_DEADLINE' ? '시한 초과' : '실패';
    const d = numOrNull(inc.done); const t = numOrNull(inc.total); const p = numOrNull(inc.partial); const k = numOrNull(inc.streak);
    const bits = [why, d != null && t != null ? `${d.toLocaleString()}/${t.toLocaleString()} 스캔` : '', p != null ? `생존 ${p.toLocaleString()}개만 확인` : '', k != null && k > 1 ? `연속 ${k}회` : ''].filter(Boolean);
    return `**${agentLabel(name)}** 스캔 미완료(${bits.join(' · ')}) · ${fmtDt(at)} · 마지막 완료 ${doneAt != null && doneAt > 0 ? fmtDt(doneAt) : '—'}`;
  });
  if (rows.length > LIST_MAX) out.push(`외 ${rows.length - LIST_MAX}곳`);
  return out;
}

/** 해제 판정 보류 줄 — 보류 개수·에이전트별 사유·보류 시한 · 시한이 지나 미확인 해제로 기록한 개수. */
export function releaseHoldLines(h) {
  if (!h || typeof h !== 'object') return [];
  const out = [];
  const held = numOrNull(h.held);
  if (held != null && held > 0) {
    out.push(`**해제 판정 보류 ${held.toLocaleString()}개** — 완료된 스캔이 해제 기준 시간 안에 없어 사용 중 상태를 유지합니다(보지 못한 것을 반납으로 세지 않습니다)`);
    const agents = (Array.isArray(h.agents) ? h.agents : []).filter((a) => numOrNull(a?.held) > 0);
    for (const a of agents.slice(0, LIST_MAX)) {
      const until = numOrNull(a.holdUntil);
      out.push(`${agentLabel(a.agent)}: ${numOrNull(a.held).toLocaleString()}개 · ${HOLD_REASON_TEXT[a.reason] || '사유 미상'} · 보류 시한 ${until != null ? fmtDt(until) : '—'}(지나면 미확인 해제로 기록)`);
    }
    if (agents.length > LIST_MAX) out.push(`외 ${agents.length - LIST_MAX}곳`);
  }
  const expired = numOrNull(h.expired);
  if (expired != null && expired > 0) out.push(`보류 시한이 지나 **미확인 해제**로 기록한 IP ${expired.toLocaleString()}개(서버 시작 이후)`);
  return out;
}

/** 진행 중 스캔 진행률 막대(스캔한 IP 수 / 전체 + %). progress 없으면 렌더 안 함. */
export function ScanProgressBar({ progress }) {
  if (!progress || !progress.total) return null;
  const pct = progress.pct ?? (progress.total ? Math.round((progress.done / progress.total) * 100) : 0); // total=0 시 NaN% 방지
  const elapsed = progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 4 }}>
        <span className="muted">진행 {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · 응답 <b style={{ color: 'var(--green)' }}>{progress.alive}</b> · {elapsed}초 경과</span>
        <b className="tabular" style={{ color: 'var(--amber)' }}>{pct}%</b>
      </div>
      <div className="usage-bar" style={{ height: 10 }}><span style={{ width: `${Math.min(pct, 100)}%`, background: 'var(--amber)' }} /></div>
    </div>
  );
}

/**
 * 완료된 스캔 이력 표(포탈/에이전트 통합). 못 읽은 수치(null)는 0 이 아니라 '—'.
 * @param {{ runs: object[], emptyText?: string, maxHeight?: string|number }} props
 */
export function ScanRunsTable({ runs = [], emptyText = '완료된 스캔 이력이 없습니다.', maxHeight = '46vh' }) {
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  return (
    <div className="table-wrap" style={{ maxHeight }}>
      <STable minWidth={520} wrap={false}>
        <thead><tr><th>완료 시각</th><th>에이전트</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th style={{ textAlign: 'right' }}>소요</th></tr></thead>
        <tbody>
          {runs.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 20, whiteSpace: 'normal' }}>{emptyText}</td></tr>}
          {runs.map((r, i) => (
            <tr key={i}>
              <td style={{ whiteSpace: 'nowrap' }} data-sort={r.at ?? ''}>{fmtDt(r.at)}</td>
              <td><b>{agentLabel(r.agent)}</b></td>
              <td style={{ textAlign: 'right' }} className="tabular" data-sort={r.scanned ?? ''}>{n(r.scanned)} / <b style={{ color: 'var(--green)' }}>{n(r.alive)}</b></td>
              <td style={{ textAlign: 'right' }} className="muted" data-sort={r.durationMs ?? ''}>{fmtDur(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </STable>
    </div>
  );
}

/** 대장 상단 '스캔 상태' 버튼이 여는 모달(v2.636 부터는 서브메뉴 페이지): 진행 중 스캔 + 완료된 스캔 이력. */
export function ScanStatusModal({ onClose, asPage = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const deniedRef = useRef(false); // v2.611 LEFT2611-07: 403 은 다시 물어도 같다 — 폴링을 멈춘다
  const load = () => { if (deniedRef.current) return; fetchJson('/admin/ipam/scan/status').then((r) => { setD(r); setErr(null); }).catch((e) => { setErr(e); if (e?.status === 403) deniedRef.current = true; }); }; // v2.636: HttpError 그대로 — 403 은 권한 안내
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  const st = d?.status; const runs = d?.runs || [];
  return (
    <Frame asPage={asPage} title="📡 IP 스캔 상태 — 진행 중 · 이력" onClose={onClose} width={720} resizable minWidth={480} minHeight={400}>
      {/* v2.639(D6): 조회 실패(403 등)면 끝나지 않는 '불러오는 중' 을 함께 그리지 않는다 — 데이터가 있으면 배너로 사유만. */}
      {err && !d && <ErrorBox message={err} />}
      {err && d && <div className="banner warn" style={{ marginBottom: 8, whiteSpace: 'normal' }}>상태를 다시 읽지 못했습니다 — 아래는 마지막으로 받은 값입니다: {String(err?.message || err)}</div>}
      {!d ? (!err && <Loading />) : (
        <>
          <div className="card" style={{ padding: 12, marginBottom: 14 }}>
            <div className="flex between" style={{ alignItems: 'center' }}>
              <b style={{ fontSize: 14 }}>{st?.running ? '🔄 스캔 진행 중' : '대기 중(진행 중인 스캔 없음)'}</b>
              <span className="muted" style={{ fontSize: 12 }}>저장된 결과 {d.info?.count ?? 0}개</span>
            </div>
            {st?.running && <ScanProgressBar progress={st.progress} />}
            {!st?.running && st?.lastRun && !st.lastRun.error && !st.lastRun.skipped && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최근(포탈): {st.lastRun.scanned}개 중 {st.lastRun.alive}개 응답 · {fmtDur(st.lastRun.durationMs)} · {fmtDt(st.lastRun.at)}</div>
            )}
          </div>
          {(() => {
            // v2.733 C1-02: 스캔 미완료 · 해제 판정 보류 — 있을 때만(없으면 아무것도 그리지 않는다).
            const lines = [...scanIncompleteLines(d.reports), ...releaseHoldLines(st?.releaseHold)];
            return lines.length > 0 && (
              <div className="banner warn" style={{ marginBottom: 14, whiteSpace: 'normal', fontSize: 12 }}>
                {lines.map((t, i) => <div key={i}><BoldText text={t} /></div>)}
              </div>
            );
          })()}

          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>완료된 스캔 이력 (최근 {runs.length}건 · 포탈/에이전트 통합)</div>
          <ScanRunsTable runs={runs} />
        </>
      )}
    </Frame>
  );
}
