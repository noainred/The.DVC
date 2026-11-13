// IpamExportModal.jsx — IP 대장 엑셀 내보내기 창(v3.5.0 재설계 묶음 나 · 시안 docs/design/ipam-redesign ⑨ Export.dc.html).
// 고른 시트만 만든다(서버 ?sheets= — server/src/ipam/excelExtra.js EXPORT_SHEETS 와 같은 키). 범위는 화면 위 범위(vCenter) 그대로.
// 대장 시트는 전체 법인도 대역마다 하나(사용자 결정 2026-11-13). 열 고르기는 하지 않는다 — 열은 예전 9개 + 용도 · 요청자 · 할당자.
import React, { useState } from 'react';
import { Modal } from '../../components/Modal.jsx';
import { downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { dayStamp } from '../../dayStamp.js';

export const EXPORT_SHEET_OPTS = Object.freeze([
  ['summary', '요약', '전체 주소 · 대장 주소 · 예약 · DHCP · 빈 주소 · 상태별 수'],
  ['nets', '대역 목록', '대역 · 용도 · 사용률 · 빈 주소 · 설명'],
  ['ledger', 'IP 대장 — 대역마다 시트 하나', '주소 하나가 한 행 · 용도 · 요청자 · 할당자 포함'],
  ['issues', '조치 필요', '충돌 · 중복 · 충돌 의심 · 예약 만료/임박 · DNS 불일치'],
  ['info', '안내', '범위 · 기준 시각 · 열 · 색 · 계산 방법'],
]);

/** 고른 시트 → 내려받기 주소(순수 — 테스트 고정). 하나도 안 골랐으면 null. */
export function exportUrl(picked, vcenterId = '') {
  const keys = EXPORT_SHEET_OPTS.map(([k]) => k).filter((k) => picked?.[k]);
  if (!keys.length) return null;
  const q = new URLSearchParams();
  if (vcenterId) q.set('vcenterId', vcenterId);
  q.set('sheets', keys.join(','));
  return `/tools/ipam.xlsx?${q.toString()}`;
}

export function IpamExportModal({ scope, scopeName, subnetCount, onClose }) {
  const [picked, setPicked] = useState(() => Object.fromEntries(EXPORT_SHEET_OPTS.map(([k]) => [k, true])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const allowed = canCsv(); // v2.643 CSV 권한(관리자 이상 + data.csv) — 서버 csvPerm 이 집행하고 화면은 안내한다
  const url = allowed ? exportUrl(picked, scope) : null;
  const stamp = dayStamp().replace(/-/g, ''); // 브라우저 현지 날짜(toISOString 은 UTC — 한국 오전 9시 전엔 하루 전 날짜)
  const file = `ip-ledger_${scope ? (scopeName || scope).replace(/[^\w.-]+/g, '_') : 'all'}_${stamp}.xlsx`;
  const go = async () => {
    if (!url) return;
    setBusy(true); setMsg('');
    try { await downloadFile(url, file); onClose(); } catch (e) { setMsg(e?.status === 409 ? '다른 내보내기가 진행 중입니다 — 끝난 뒤 다시 누르세요.' : (e?.message || '내려받지 못했습니다.')); }
    setBusy(false);
  };
  return (
    <Modal title="엑셀로 내보내기" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>범위 <b style={{ color: 'var(--text)' }}>{scope ? (scopeName || scope) : '전체 vCenter'}</b>{Number.isFinite(subnetCount) ? ` · 대역 ${subnetCount.toLocaleString()}개` : ''} — 범위는 화면 위 고르기를 따릅니다.</div>
        <div role="group" aria-label="시트 구성" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {EXPORT_SHEET_OPTS.map(([k, label, sub]) => (
            <label key={k} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: '2px 9px', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!picked[k]} onChange={(e) => setPicked((p) => ({ ...p, [k]: e.target.checked }))} style={{ marginTop: 3 }} />
              <b style={{ fontWeight: 600 }}>{label}</b>
              <span className="muted" style={{ gridColumn: 2, fontSize: 11.5 }}>{sub}</span>
            </label>
          ))}
        </div>
        {picked.ledger && Number.isFinite(subnetCount) && subnetCount > 100 && <div style={{ fontSize: 12, color: 'var(--amber)' }}>대장 시트가 {subnetCount.toLocaleString()}장입니다 — 만드는 데 시간이 걸립니다(한 번에 한 건만 만듭니다).</div>}
        <div className="muted" style={{ fontSize: 12 }}>파일 이름 <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{file}</span></div>
        {!allowed && <div className="banner warn">{CSV_DENIED_NOTE}</div>}
        {msg && <div className="banner warn">{msg}</div>}
        <div className="flex gap" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="logout-btn" style={{ padding: '7px 14px' }} onClick={onClose}>취소</button>
          <button type="button" className="login-btn" style={{ padding: '7px 14px' }} disabled={!url || busy} onClick={go}>{busy ? '만드는 중…' : url ? '엑셀 내려받기' : '시트를 하나 이상 고르세요'}</button>
        </div>
      </div>
    </Modal>
  );
}
