/**
 * 물리서버 펌웨어 보안 권고 표 올리기(v3.50 · 시안 ④) — 전체 범위 관리자(서버 게이트와 같은 표지 canFleet). 자산 원장 창(AssetLedger)과 같은 틀.
 *  · 포탈은 인터넷에서 권고를 가져오지 않는다 — 사람이 제조사 권고를 확인해 CSV 로 올린다. 올리기는 **표를 파일로 바꾼다**.
 *  · 검증(dryRun) → 적용(expect = 미리본 표) · 오류 행이 하나라도 있으면 적용을 잠근다 · 적용 뒤 · 적용 실패 뒤에는 다시 검증해야 열린다.
 *  · 머리글만 있는 파일(권고 0줄)은 ‘표 비우기’ — 묻고 적용한다(v3.50 반증 B14).
 *  · 파일은 UTF-8 · 한국어 엑셀 저장(EUC-KR) 모두 읽는다(csvDecode).
 */
import React, { useRef, useState } from 'react';
import { Modal } from '../../../components/Modal.jsx';
import { STable } from '../../../components/STable.jsx';
import { postJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { ledgerApplyState } from './opsText.js';
import { decodeCsvBytes } from '../csvDecode.js';

const FILE_MAX = 1024 * 1024;
const sigOf = (t) => { let h = 0; for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0; return `${t.length}:${h}`; };

export default function AdvisoryLedger({ meta, onClose, onChanged }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [msg, setMsg] = useState(null);
  const sig = text ? sigOf(text) : '';
  const checked = !!res && res.sig === sig;
  const csvOk = canCsv();
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > FILE_MAX) { setMsg({ ok: false, text: `파일이 ${Math.round(f.size / 1024)}KB 입니다 — ${Math.round(FILE_MAX / 1024)}KB 이하로 올리십시오.` }); return; }
    try {
      const { text: t } = decodeCsvBytes(await f.arrayBuffer());
      if (t.includes('�')) { setText(''); setName(f.name); setRes(null); setMsg({ ok: false, text: '파일의 글자를 읽지 못했습니다(깨진 글자가 있습니다) — UTF-8 또는 한국어 엑셀의 ‘CSV(쉼표로 분리)’ 로 저장해 다시 올리십시오.' }); return; }
      setText(t); setName(f.name); setRes(null); setMsg(null);
    } catch (ex) { setMsg({ ok: false, text: `파일을 읽지 못했습니다: ${ex?.message || ex}` }); }
  };
  const run = async (dryRun) => {
    // 0줄 적용 = 표 비우기(모든 서버가 ‘대조 안 함’ 으로) — 되돌리기 어려우니 묻는다(반증 B14 · A11: 한 번 올린 표를 비울 길이 화면에 없었다)
    if (!dryRun && !res?.rows && !window.confirm('권고 표를 비웁니다 — 모든 서버가 ‘대조 안 함’ 으로 바뀝니다. 계속할까요?')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/bm-advisories/import', { csv: text, dryRun, ...(dryRun ? {} : { expect: res?.base }) });
      if (!r || r.ok === false) throw new Error(r?.reason || '요청을 처리하지 못했습니다.');
      if (dryRun) setRes({ ...r, sig });
      else { setRes({ ...r, sig: '', applied: true }); setMsg({ ok: true, text: r.rows ? `권고 표를 ${r.rows}줄로 바꿨습니다.` : '권고 표를 비웠습니다 — 이제 대조하지 않습니다.' }); onChanged?.(); }
    } catch (e) {
      // 적용이 실패하면(409 — 그 사이 표가 바뀜 등) 검증 결과를 버린다: 다시 검증해야 적용이 열린다(반증 B14)
      if (!dryRun) setRes(null);
      setMsg({ ok: false, text: opErrorText(e) });
    } finally { setBusy(false); }
  };
  const dl = (path, file) => downloadFile(path, file).catch((e) => setMsg({ ok: false, text: opErrorText(e) }));
  const errs = res?.errors || [];
  const ap = ledgerApplyState({ checked, errors: errs.length, rows: res?.rows ?? 0, csvOk, busy });
  return (
    <Modal title="펌웨어 보안 권고 표 올리기" onClose={onClose} width={720}>
      <div className="bmd-al">
        <div className="muted bmd-note">
          제조사가 낸 보안 권고(권고 번호 · 종류 · 모델 · 구성요소 · 고친 버전)를 확인해 CSV 로 올립니다. 포탈은 인터넷에서 권고를 가져오지 않습니다 — 올린 표로만 대조합니다.
          설치 버전이 고친 버전보다 낮은 서버가 ‘걸림’ 으로 보입니다. 올리면 표 전체가 이 파일로 바뀝니다.
        </div>
        <div className="muted bmd-note">
          지금 표: {meta?.unreadable ? '파일을 읽지 못했습니다(서비스 점검에서 확인 — 올리기가 막힙니다)' : `${meta?.n ?? 0}줄${meta?.at ? ` · ${new Date(meta.at).toLocaleString()} 갱신` : ' · 아직 올린 적 없음'}`}
        </div>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={pick} />
          <button type="button" className="logout-btn" disabled={busy || !csvOk} onClick={() => fileRef.current?.click()}>파일 고르기</button>
          <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name || '고른 파일 없음'}</span>
          <span style={{ flex: 1 }} />
          {csvOk ? <button type="button" className="logout-btn" disabled={busy} onClick={() => dl('/admin/bm-advisories/sample.csv', 'bm-advisories-sample.csv')}>빈 양식</button> : null}
          {csvOk ? <button type="button" className="logout-btn" disabled={busy || !!meta?.unreadable} onClick={() => dl('/admin/bm-advisories.csv', 'bm-advisories.csv')}>지금 표 내려받기</button> : null}
        </div>
        {csvOk ? null : <div className="muted bmd-note" role="status">{CSV_DENIED_NOTE}</div>}
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <button type="button" className="login-btn bmd-btn" disabled={busy || !text || !csvOk} onClick={() => run(true)}>검증</button>
          <button type="button" className="login-btn bmd-btn" disabled={ap.disabled} onClick={() => run(false)} title={ap.title}>{ap.label}</button>
          {res && (checked || res.applied) ? <span className="muted">권고 {res.rows}줄 · 오류 {errs.length}행{ap.empty ? ' — 머리글만 있는 파일은 표를 비웁니다' : ''}</span> : null}
        </div>
        {msg ? <div className={`bmd-opnote ${msg.ok ? 'ok' : 'bad'}`} role={msg.ok ? 'status' : 'alert'} style={{ borderRadius: 8, borderBottom: 0 }}>{msg.text}</div> : null}
        {errs.length && checked ? (
          <STable className="table bmd-ct" minWidth={300} limit={200}>
            <thead><tr><th title="표의 행 번호(머리글 = 1) — 칸 안에 줄바꿈이 있으면 파일의 줄 번호와 다를 수 있습니다">행</th><th>오류</th></tr></thead>
            <tbody>{errs.map((x, i) => <tr key={`${x.line}:${i}`}><td data-sort={x.line ?? ''}>{x.line || '—'}</td><td data-sort={x.reason} style={{ overflowWrap: 'anywhere' }}>{x.reason}</td></tr>)}</tbody>
          </STable>
        ) : null}
      </div>
    </Modal>
  );
}
