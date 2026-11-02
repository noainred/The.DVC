/**
 * GpuAllocExportModal — GPU 할당 계층 '엑셀로 내보내기' 창(v2.855 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB
 *   '계층 표 엑셀 내보내기' · 사용자 요청 "만들어줘").
 *
 * 범위는 화면 그대로(scope · 고른 법인) — 창에서 바꾸지 않는다. 고르는 것은 계층 표에 넣을 단계와 시트뿐이다.
 * 범위 글자 · 호스트·GPU 수 · 파일 이름은 서버 /tools/gpu/alloc/export-meta 가 준다(내려받기와 같은 함수 — 이름을 화면에서 지어내지 않는다).
 * 실패(409 동시 내보내기 · 403 · 400)는 파일로 저장하지 않고 창 안에 말한다(downloadFailText).
 */
import React, { useEffect, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { Modal, ErrorBox } from '../../components/ui.jsx';
import { EXPORT_DEPTHS, EXPORT_SHEETS, allocExportQuery } from './gpuAllocText.js';

const FORMATS = [
  '맨 위 요약 칸(전체 · 할당 · 예비 · 할당률 · 꺼진 VM)',
  '머리글 고정 · 평면 표 자동 필터',
  '단계별 색 띠 · 할당률 막대(90% 이상 주황)',
  '숫자는 숫자 서식 — 합계·피벗을 바로 낼 수 있음',
  '인쇄: A4 가로 한 쪽 너비 맞춤 · 머리글 반복',
];

export function GpuAllocExportModal({ scope = '', vcSel = null, onClose }) {
  const run = useLatest();
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  const [depth, setDepth] = useState('vm');
  const [sheets, setSheets] = useState(() => EXPORT_SHEETS.map((s) => s.key));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const rangeQ = allocExportQuery({ scope, vcSel });
  // 파일 내보내기는 data.csv 권한(v2.643 — 소스 스윕 csvGate2643 가 이 파일에도 요구한다). 부모도 막지만 창 스스로 한 번 더 막는다.
  const allowed = canCsv();
  useEffect(() => { if (!allowed) return; setMeta(null); setMetaErr(null); run(fetchJson(`/tools/gpu/alloc/export-meta${rangeQ}`), setMeta, setMetaErr); }, [rangeQ, run, allowed]);
  const toggleSheet = (k) => setSheets((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const noSheet = sheets.length === 0;
  const fileName = meta?.fileNames?.[depth] || '';
  const download = async () => {
    setMsg(''); setBusy(true);
    try { await downloadFile(`/tools/gpu/alloc.xlsx${allocExportQuery({ scope, vcSel, depth, sheets })}`); onClose?.(); }
    catch (e) { setMsg(downloadFailText(e)); }
    finally { setBusy(false); }
  };
  if (!allowed) return null;   // 훅 아래 — 조기 return 이 훅 개수를 바꾸지 않게
  return (
    <Modal title="계층 표 엑셀로 내보내기" onClose={onClose} width={560}>
      <div className="gpu-alloc-export">
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
          화면의 법인 선택을 그대로 따릅니다. 지금 범위: {metaErr ? <span>—</span> : meta ? <b style={{ color: 'var(--text)' }}>{meta.scopeText} · 호스트 {meta.hosts}대 · GPU {meta.gpus}장</b> : '불러오는 중…'}
        </div>
        {metaErr && <ErrorBox error={metaErr} />}

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">행을 어디까지 넣을까요</div>
          <div className="flex gap wrap" role="group" aria-label="넣을 단계">
            {EXPORT_DEPTHS.map((d) => (
              <button key={d.key} type="button" className={`qn-btn${depth === d.key ? ' on' : ''}`} aria-pressed={depth === d.key} onClick={() => setDepth(d.key)}>{d.label}</button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>고른 단계까지 계층 표 행을 만들고 엑셀의 <b>행 그룹(개요)</b>으로 묶습니다. 파일을 연 뒤 왼쪽 위 숫자 단추로 접고 펼 수 있습니다. 평면 표는 단계와 무관하게 GPU·VM 한 줄씩입니다.</div>
        </section>

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">시트</div>
          {EXPORT_SHEETS.map((s) => (
            <label key={s.key} className="gpu-alloc-export-chk">
              <input type="checkbox" checked={sheets.includes(s.key)} onChange={() => toggleSheet(s.key)} />
              <span><b>{s.label}</b> <span className="muted">— {s.sub}</span></span>
            </label>
          ))}
          {noSheet && <div className="gpu-alloc-export-warn">시트를 하나 이상 고르세요.</div>}
        </section>

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">파일에 들어가는 서식</div>
          <ul className="gpu-alloc-export-list">{FORMATS.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>

        <div className="gpu-alloc-export-file" title="내려받을 파일 이름">{fileName || '—'}</div>
        {msg && <div className="error-box">{msg}</div>}
        <div className="flex gap wrap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="logout-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={onClose}>닫기</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || noSheet || !!metaErr} onClick={download}>{busy ? '만드는 중…' : '⬇ 엑셀 내려받기'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default GpuAllocExportModal;
