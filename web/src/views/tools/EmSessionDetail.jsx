/**
 * Veeam 백업 현황 › EM — 실패·경고 상세(v2.788.1 — 사용자 요청 '실패에서 세부 작업 내용' · '경고 누르면 왜 경고인지').
 * 펼칠 때 한 번 읽는다(GET /api/tools/backup-em/session — 서버가 EM 에서 그 세션의 VM 별 결과·사유를 읽는다 · 5분 캐시).
 * 늦게 온 응답은 버린다 · 403 등은 ErrorBox · 사유는 EM 이 준 문구 그대로(줄바꿈 유지).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { JOB_LABEL, TONE, BADGE_BG, shortTs, fmtBytes, fmtDur, detailSummary } from './backupEmText.js';

export default function EmSessionDetail({ emId, uid, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => {
    const my = ++gen.current;
    setD(null); setErr(null);
    fetchJson('/tools/backup-em/session', { em: emId, uid })
      .then((r) => { if (my === gen.current) setD(r); })
      .catch((e) => { if (my === gen.current) setErr(e); });
    return () => { gen.current++; };
  }, [emId, uid]);
  const sum = d ? detailSummary(d) : null;
  return (
    <div data-em-session-detail="" style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel-deep)', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 4 }}>
        <b style={{ fontSize: 14 }}>세션 상세</b>
        {sum && <span className="muted" style={{ fontSize: 12 }}>{sum.line}</span>}
        {d?.demo && <span className="muted" style={{ fontSize: 12 }}>· 데모 값</span>}
        <button type="button" className="tab" style={{ marginLeft: 'auto', padding: '2px 10px' }} onClick={onClose}>닫기</button>
      </div>
      {!d && !err && <div className="muted" style={{ fontSize: 13 }}>Enterprise Manager 에서 읽는 중…</div>}
      {err && <ErrorBox error={err} />}
      {d?.head?.reason && (
        <div style={{ padding: '8px 10px', borderRadius: 8, background: BADGE_BG[d.head.result] || 'var(--panel)', color: TONE[d.head.result] || 'var(--text)', fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{d.head.reason}</div>
      )}
      {d && d.tasks && (
        d.tasks.length ? (
          <STable minWidth={720} limit={300} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '6px 6px 6px 0' }}>VM</th><th style={{ padding: '6px' }}>결과</th><th style={{ padding: '6px', width: '50%' }}>사유</th>
              <th style={{ padding: '6px' }}>끝남</th><th style={{ padding: '6px' }}>소요</th><th style={{ padding: '6px 0 6px 6px', textAlign: 'right' }}>크기</th>
            </tr></thead>
            <tbody>
              {sum.tasks.map((t, i) => (
                <tr key={`${t.vm}|${i}`} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '7px 6px 7px 0' }}><b style={{ overflowWrap: 'anywhere' }}>{t.vm || '—'}</b></td>
                  <td data-sort={t.order} style={{ padding: '7px 6px' }}><span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', background: BADGE_BG[t.result] || 'var(--panel)', color: TONE[t.result] || 'var(--text-dim)' }}>{JOB_LABEL[t.result] || t.state || '—'}</span></td>
                  <td style={{ padding: '7px 6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: t.reason ? 'var(--text)' : 'var(--text-dim)' }}>{t.reason || '—'}</td>
                  <td data-sort={t.end ?? ''} style={{ padding: '7px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(t.end)}</td>
                  <td data-sort={t.durSec ?? ''} style={{ padding: '7px 6px', whiteSpace: 'nowrap' }}>{fmtDur(t.durSec)}</td>
                  <td data-sort={t.size ?? ''} style={{ padding: '7px 0 7px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtBytes(t.size)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : <div className="muted" style={{ fontSize: 13 }}>이 세션의 VM 별 결과가 비어 있습니다.</div>
      )}
      {d && !d.tasks && <div className="muted" style={{ fontSize: 13 }}>VM 별 결과를 읽지 못했습니다{d.errors?.tasks ? ` — ${d.errors.tasks}` : ''}.</div>}
      {d && !d.head && d.errors?.head && <div className="muted" style={{ fontSize: 12 }}>세션 정보를 읽지 못했습니다 — {d.errors.head}</div>}
    </div>
  );
}
