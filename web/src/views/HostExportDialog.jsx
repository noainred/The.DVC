// views/HostExportDialog.jsx — vCenter 화면 '호스트 및 클러스터' 탭의 '호스트 · 클러스터 엑셀' 창(v2.802 — 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX).
// 사용자 요청: "호스트 및 클러스터 정보로 VM 처럼 멋지게 · 호스트 1개에 엑셀 sheet 1개 · 최대한 자세하고 많은 정보".
// 클러스터 목록·출처 상태·묶음 권한은 서버(GET /tools/host-export/status)가 준다. 권한 없는 묶음은 잠그고 사유를 보인다(서버도 같은 판정으로 뺀다).
// 무거운 내려받기라 폴링하지 않는다(창을 열 때 1회 + 내려받기 버튼).
import React, { useEffect, useState } from 'react';
import { fetchJson, postDownload, canCsv, CSV_DENIED_NOTE } from '../api.js';
import { Modal } from '../components/Modal.jsx';
import { ErrorBox } from '../components/primitives.jsx';
import { downloadFailText } from './downloadFailText.js';
import { initialState, partRows, sheetLine, exportBody, sourceTiles } from './hostExportText.js';

const TONE = { ok: ['#86efac', '#14532d'], info: ['#93c5fd', '#1e3a8a'], warn: ['#fcd34d', '#713f12'], none: ['var(--text-dim)', 'var(--border-soft)'] };
const chip = (on) => ({ flex: 'none', minHeight: 34, borderRadius: 99, padding: '0 14px', ...(on ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 600 } : {}) });

/** @param {{ vcenterId:string, vcName:string, onClose:()=>void }} p */
export default function HostExportDialog({ vcenterId, vcName, onClose }) {
  // 버튼은 호출부(VCenterDetail)가 canCsv 로 가린다 — 창도 같은 판정으로 한 번 더(서버 data.csv 게이트와 같은 키 · VmExport 와 같은 방식).
  const csvOk = canCsv();
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!csvOk) return undefined;
    let alive = true;
    fetchJson(`/tools/host-export/status?vcenterId=${encodeURIComponent(vcenterId)}`)
      .then((r) => { if (!alive) return; setStatus(r); setSt(initialState(r)); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [vcenterId, csvOk]);

  const title = `호스트 · 클러스터 엑셀 — ${vcName || vcenterId}`;
  if (!csvOk) return <Modal title={title} onClose={onClose} width={880}><div className="muted">{CSV_DENIED_NOTE}</div></Modal>;
  if (err) return <Modal title={title} onClose={onClose} width={880}><ErrorBox error={err} /></Modal>;
  if (!status || !st) return <Modal title={title} onClose={onClose} width={880}><div className="muted">클러스터 목록을 불러오는 중…</div></Modal>;

  const rows = partRows(status, st);
  const line = sheetLine(status, st);
  const tiles = sourceTiles(status);
  const clusters = status.clusters || [];
  const canDownload = line.ok && !busy;
  const setPart = (k) => setSt((s) => ({ ...s, parts: { ...s.parts, [k]: !s.parts[k] } }));
  const download = async () => {
    if (!canDownload) return;
    setBusy(true); setMsg(null);
    try { await postDownload(`/tools/host-export.xlsx?vcenterId=${encodeURIComponent(vcenterId)}`, exportBody(status, st)); }
    catch (e) { setMsg(downloadFailText(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={title} onClose={onClose} width={880}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        {status.initial && <div className="muted" style={{ fontSize: 12.5 }}>포탈이 막 시작해 첫 수집 중입니다 — 지금 내려받으면 빈 값이 많을 수 있습니다.</div>}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <b>대상</b>
          <div className="flex gap" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="tab" style={chip(st.mode !== 'pick')} onClick={() => setSt((s) => ({ ...s, mode: 'all' }))}>
              이 vCenter 전체 (호스트 {Number(status.hosts || 0).toLocaleString()}대)
            </button>
            <button type="button" className="tab" style={chip(st.mode === 'pick')} disabled={!clusters.length} onClick={() => setSt((s) => ({ ...s, mode: 'pick' }))}>클러스터 고르기</button>
          </div>
          {st.mode === 'pick' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 12px', padding: '10px 12px', background: 'var(--bg-soft, rgba(255,255,255,0.03))', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              {clusters.map((c) => (
                <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, cursor: 'pointer', minWidth: 0 }}>
                  <input type="checkbox" checked={!!st.picked[c.key]} onChange={() => setSt((s) => ({ ...s, picked: { ...s.picked, [c.key]: !s.picked[c.key] } }))} style={{ width: 16, height: 16, flex: 'none' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={c.name}>{c.name}</span>
                  <span className="muted" style={{ fontSize: 12, flex: 'none' }}>호스트 {c.hosts}</span>
                </label>
              ))}
            </div>
          )}
        </section>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <b>호스트 시트에 넣을 내용 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— 호스트 1대 = 시트 1장</span></b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '2px 18px' }}>
            {rows.map((r) => (
              <label key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '6px 4px', cursor: r.disabled ? 'default' : 'pointer', opacity: r.denied ? 0.6 : 1, minWidth: 0 }}>
                <input type="checkbox" checked={r.on} disabled={r.disabled} onChange={() => setPart(r.key)} style={{ width: 16, height: 16, marginTop: 2, flex: 'none' }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{r.label}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{r.src}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
          {tiles.map((t) => (
            <div key={t.key} style={{ padding: '9px 11px', border: `1px solid ${TONE[t.tone][1]}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>{t.label}</span>
              <b style={{ color: TONE[t.tone][0] }}>{t.value}</b>
              {t.sub && <span className="muted" style={{ fontSize: 11.5 }}>{t.sub}</span>}
            </div>
          ))}
        </section>
        {msg && <div role="alert" style={{ color: '#fca5a5', fontSize: 13 }}>{msg}</div>}
        <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
          <span style={{ minWidth: 0 }}>
            <b style={{ color: line.ok ? undefined : '#fcd34d' }}>{line.text}</b>
            {line.ok && <span className="muted"> · 요약 · 클러스터 · 호스트 목록 · 호스트 {line.n.toLocaleString()}장 · 읽는 법</span>}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!canDownload} onClick={download}>
            {busy ? '만드는 중…' : '⤓ 엑셀 내려받기'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
