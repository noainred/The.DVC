import React, { useState } from 'react';
import { downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import BoldText from '../../components/boldText.jsx';
import BulkDeviceIo from './BulkDeviceIo.jsx';
import {
  CVP_BULK_BASE, CVP_BULK_RESOURCE, cvpExportUrl, SECRET_EXPORT_WARNING, PLAIN_EXPORT_NOTE, IMPORT_NOTE, exportErrorText,
} from './cvpBulkText.js';

/**
 * views/tools/CvpBulkIo.jsx — CVP 서버 **CSV·자유텍스트 대량 등록 + 내보내기** 패널(v2.641).
 *
 * 공용 모달(`BulkDeviceIo` — 스토리지·SAN 스위치·Horizon 과 같은 것)을 **그대로** 쓰고, 이 파일은
 * CVP 에만 있는 **비밀번호·토큰 포함 내보내기** 버튼과 경고만 더한다(판정·문구 복제 금지 — v2.513).
 * 공용 모달의 비밀번호 포함 버튼(passwordExport)은 쓰지 않는다 — 그 버튼은 '비밀번호' 만 말하는데
 * CVP 파일에는 **토큰**도 담기고, 경고를 버튼 옆에 항상 보이게 하려면 모달 밖에 있어야 한다.
 *
 * @param {{ onDone?: () => void }} props onDone — 등록 뒤 목록 새로고침
 */
export default function CvpBulkIo({ onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);   // { tone:'ok'|'err', text }

  const dl = async (secrets) => {
    setBusy(secrets ? 'secrets' : 'plain'); setMsg(null);
    try {
      const name = await downloadFile(cvpExportUrl({ secrets }));
      setMsg({ tone: 'ok', text: `내려받았습니다: ${name}` });
    } catch (e) {
      setMsg({ tone: 'err', text: exportErrorText(e, { secrets }) });
    } finally { setBusy(''); }
  };

  const btn = { flex: 'none', padding: '6px 12px', fontSize: 12.5 };
  // v2.643: CSV 가져오기/내보내기는 관리자 이상 + data.csv 권한만 — 이 패널은 CSV 전용이라 안내 한 줄로 바꾼다(훅은 모두 위에).
  if (!canCsv()) return <div className="muted" style={{ fontSize: 12, minWidth: 0 }}>{CSV_DENIED_NOTE}</div>;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="tab" style={btn} onClick={() => setOpen(true)}>📥 CSV · 자유텍스트 대량 등록</button>
        <button className="tab" style={btn} disabled={!!busy} onClick={() => dl(false)}>
          {busy === 'plain' ? '내려받는 중…' : '⬇ 내보내기(CSV)'}
        </button>
        <button className="tab" style={{ ...btn, color: 'var(--amber)' }} disabled={!!busy} onClick={() => dl(true)}
          title="CVP 접속 비밀번호와 토큰을 평문으로 담습니다 — 설정 소유 계정만 가능하고 감사 로그에 남습니다.">
          {busy === 'secrets' ? '내려받는 중…' : '🔑 비밀번호·토큰 포함 내보내기'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
        <div><BoldText text={IMPORT_NOTE} /></div>
        <div style={{ marginTop: 4 }}><BoldText text={PLAIN_EXPORT_NOTE} /></div>
        <div style={{ marginTop: 4, color: 'var(--amber)' }}>⚠ <BoldText text={SECRET_EXPORT_WARNING} /></div>
      </div>
      {msg && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6, overflowWrap: 'anywhere', color: msg.tone === 'err' ? 'var(--red)' : undefined }}>
          <BoldText text={msg.text} />
        </div>
      )}
      {open && (
        <BulkDeviceIo base={CVP_BULK_BASE} resource={CVP_BULK_RESOURCE} unitLabel="CVP" typeCol={null}
          title="CVP 서버 대량 등록 — CSV · 자유텍스트" keyLabel="id 또는 주소+담당 엣지"
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); onDone?.(); }} />
      )}
    </div>
  );
}
