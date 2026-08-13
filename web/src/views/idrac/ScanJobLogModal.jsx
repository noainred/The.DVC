// ScanJobLogModal.jsx — IdracAdmin.jsx(구 1,309줄)에서 분리(v2.292). 본문은 원본 789~902행 그대로.
// 소비자: IdracScanJobs(스캔 현황 행의 [로그] 버튼) 하나뿐이라 같은 디렉터리에 둔다.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';

// ---- 스캔 잡 세부 로그창 ------------------------------------------------------
// '스캔 현황' 행의 [로그]를 누르면 열림. 잡의 이벤트 타임라인(생성→인출→진행→완료/오류) +
// 멈춤 진단(에이전트 폴링 두절/진행 보고 끊김)을 2.5초 주기로 갱신해 보여준다.
export function ScanJobLogModal({ reqId, dcName, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => fetchJson(`/admin/idrac/scan-job-log?reqId=${encodeURIComponent(reqId)}`)
      .then((r) => { if (active) { setD(r); setErr(null); } })
      .catch((e) => { if (active) setErr(e.message); });
    load();
    const t = setInterval(load, 2500);
    return () => { active = false; clearInterval(t); };
  }, [reqId]);
  // 잘못된 AGENT_NAME 등으로 영원히 '대기'하는 이 잡만 개별 취소.
  const cancelJob = async () => {
    if (!window.confirm('이 대기 잡을 취소할까요? (큐에서 제거되고 오류로 종결됩니다)')) return;
    setCanceling(true); setCancelMsg(null);
    try {
      const r = await postJson('/admin/idrac/scan-job/cancel', { reqId });
      setCancelMsg(r.ok ? { ok: true, text: '이 잡을 취소했습니다.' } : { ok: false, text: r.reason || '취소 실패' });
    } catch (e) { setCancelMsg({ ok: false, text: e.message }); }
    finally { setCanceling(false); }
  };
  const fmt = (ts) => (ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }) : '—');
  const dur = (a, b) => (a && b ? `${Math.max(0, Math.round((b - a) / 1000))}초` : '—');
  const lvColor = { info: 'var(--text-dim, #8b9bb4)', warn: '#fbbf24', error: '#f87171' };
  const stateLabel = { pending: '대기(에이전트 인출 전)', running: '진행 중', done: '완료', error: '오류' };
  const now = Date.now();
  return (
    <Modal title={`스캔 세부 로그 — ${reqId}`} onClose={onClose} width={860} resizable minWidth={560} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          {/* 요약 헤더 */}
          <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 8, alignItems: 'center' }}>
            <span className="badge blue">{d.action === 'register' ? '등록' : '스캔'}</span>
            <span><b>{stateLabel[d.state] || d.state}</b></span>
            <span className="muted">에이전트 <b style={{ color: '#a78bfa' }}>{d.agent}</b></span>
            {d.datacenterId && <span className="muted">법인 <b>{dcName ? dcName(d.datacenterId) : d.datacenterId}</b></span>}
            {d.progress?.total ? <span className="muted">진행 <b>{d.progress.scanned}/{d.progress.total}</b>{d.progress.found ? ` · 발견 ${d.progress.found}` : ''}</span> : null}
            <span className="muted">경과 {dur(d.createdAt, d.doneAt || now)}</span>
            {d.state === 'pending' && (
              <button className="logout-btn" style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12, color: '#f87171', borderColor: 'rgba(239,68,68,.4)' }}
                disabled={canceling} onClick={cancelJob} title="이 대기 잡을 큐에서 제거">
                {canceling ? '취소 중…' : '이 잡 취소'}
              </button>
            )}
          </div>
          {cancelMsg && (
            <div style={{ marginBottom: 8, padding: '7px 11px', borderRadius: 8, fontSize: 12.5,
              background: cancelMsg.ok ? 'rgba(34,197,94,.14)' : 'rgba(239,68,68,.14)', color: cancelMsg.ok ? '#4ade80' : '#f87171' }}>
              {cancelMsg.text}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            생성 {fmt(d.createdAt)} · 인출 {fmt(d.takenAt)}{d.doneAt ? ` · 종료 ${fmt(d.doneAt)}` : ''}
            {' '}· 에이전트 최근 폴링 {d.agentLastPoll ? `${Math.max(0, Math.round((now - d.agentLastPoll) / 1000))}초 전` : '기록 없음'}
            {' '}· 최근 진행보고 {d.progress?.at ? `${Math.max(0, Math.round((now - d.progress.at) / 1000))}초 전` : '—'}
            {d.ips ? <> · 대역 <span style={{ fontFamily: 'ui-monospace, monospace' }}>{String(d.ips).slice(0, 120)}</span></> : null}
          </div>
          {/* 멈춤 진단 */}
          {(d.hints || []).map((h, i) => (
            <div key={i} style={{ marginBottom: 6, padding: '7px 11px', borderRadius: 8, fontSize: 12.5,
              background: h.level === 'error' ? 'rgba(239,68,68,.14)' : h.level === 'warn' ? 'rgba(245,158,11,.14)' : 'rgba(96,165,250,.12)',
              color: h.level === 'error' ? '#f87171' : h.level === 'warn' ? '#fbbf24' : '#93c5fd' }}>
              {h.level === 'error' ? '⛔ ' : h.level === 'warn' ? '⚠ ' : 'ℹ️ '}{h.msg}
            </div>
          ))}
          {/* 이벤트 타임라인(최신 위) */}
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table>
              <thead><tr><th style={{ width: 90 }}>시각</th><th>내용</th></tr></thead>
              <tbody>
                {(d.events || []).length === 0 && <tr><td colSpan={2} className="muted" style={{ padding: 14 }}>이벤트가 없습니다.</td></tr>}
                {[...(d.events || [])].reverse().map((e, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmt(e.ts)}</td>
                    <td style={{ fontSize: 12.5, color: lvColor[e.level] || undefined }}>{e.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.result?.error && <div style={{ marginTop: 8, fontSize: 12.5, color: '#f87171' }}>오류: {d.result.error}</div>}
          {d.result?.authFailed > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: '#fbbf24' }}>
              ⚠ 인증실패 {d.result.authFailed}건{d.result.authFailReason ? ` — ${d.result.authFailReason}` : ''}
              <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                계정이 맞는데 실패하면: iDRAC이 Redfish Basic 인증을 막았을 수 있습니다(자동으로 Digest·세션 토큰 재시도함) · 로그인 실패 임계로 계정이 잠겼는지 · Redfish/로그인 권한 설정을 확인하세요.
              </div>
              {Array.isArray(d.result.authFailedIps) && d.result.authFailedIps.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div className="flex" style={{ alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <b style={{ fontSize: 12 }}>인증 거부된 IP ({d.result.authFailedIps.length}{d.result.authFailedIpsTruncated ? '+' : ''}개)</b>
                    <button className="logout-btn" style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => { try { navigator.clipboard?.writeText(d.result.authFailedIps.join('\n')); } catch { /* */ } }}
                      title="IP 목록을 클립보드로 복사">복사</button>
                  </div>
                  <textarea readOnly value={d.result.authFailedIps.join('\n')}
                    onFocus={(e) => e.target.select()}
                    style={{ width: '100%', minHeight: 88, maxHeight: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: '6px 8px', background: 'rgba(0,0,0,.25)', color: '#e2e8f0', border: '1px solid rgba(148,163,184,.25)', borderRadius: 6, resize: 'vertical' }} />
                  {d.result.authFailedIpsTruncated && <div className="muted" style={{ fontSize: 11 }}>※ 인증실패가 목록보다 많습니다(상위 {d.result.authFailedIps.length}개만 표시).</div>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
