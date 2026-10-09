/**
 * 수집 서버 화면 — 중앙 ↔ 엣지 전송 보호(HTTPS) 요약(2026-10-09 검토 S-09 · 그룹 J).
 * 문장은 transportText.js 가 만들고 여기서는 그리기만 한다. 말할 것이 없으면(전부 https · TLS 리스닝) 그리지 않는다.
 * 거부 기록은 '예외로 등록' 버튼으로 등록 폼을 미리 채워 연다(토큰은 엣지의 COLLECTOR_TOKEN 을 관리자가 넣는다 — 중앙은 기록하지 않았다).
 */
import React from 'react';
import { STable } from '../../components/STable.jsx';
import { transportBannerLines, rejectedText, REJECTED_HELP } from './transportText.js';

const TONE = {
  red: { fg: '#f87171', mark: '⛔' },
  amber: { fg: '#fbbf24', mark: '⚠' },
  info: { fg: 'var(--text-dim)', mark: '·' },
};

export default function TransportPanel({ transport, onApprove }) {
  const lines = transportBannerLines(transport);
  const rejected = Array.isArray(transport?.rejected) ? transport.rejected : [];
  if (!lines.length && !rejected.length) return null;
  const worst = lines.some((l) => l.tone === 'red') ? 'red' : lines.some((l) => l.tone === 'amber') || rejected.length ? 'amber' : 'info';
  return (
    <div className="card" style={{ marginBottom: 12, padding: '10px 14px', minWidth: 0, borderColor: worst === 'red' ? 'rgba(239,68,68,.45)' : worst === 'amber' ? 'rgba(245,158,11,.35)' : undefined }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>🔒 중앙↔엣지 전송 보호(HTTPS)</div>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6, color: TONE[l.tone]?.fg, overflowWrap: 'anywhere' }}>
            {TONE[l.tone]?.mark} {l.text}
          </div>
        ))}
      </div>
      {rejected.length > 0 && (
        <details style={{ marginTop: 8 }} open>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#fbbf24' }}>
            평문 HTTP 로 등록하려다 거부된 엣지 {rejected.length}곳
          </summary>
          <div className="muted" style={{ fontSize: 12, margin: '6px 0', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{REJECTED_HELP}</div>
          <STable minWidth={560}>
            <thead><tr><th>엣지</th><th>주소</th><th>경로·횟수·시각</th><th data-nosort className="right">조치</th></tr></thead>
            <tbody>
              {rejected.map((r) => (
                <tr key={`${r.source}|${r.name}`}>
                  <td><b>{r.name || '—'}</b></td>
                  <td className="muted">{r.url || '—'}</td>
                  <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{rejectedText(r)}</td>
                  <td className="right nowrap">
                    <button type="button" className="tab" title="등록 폼을 이 이름·주소로 미리 채워 엽니다 — 사유와 엣지의 COLLECTOR_TOKEN 을 넣고 저장하세요"
                      onClick={() => onApprove?.(r)}>예외로 등록</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        </details>
      )}
    </div>
  );
}
