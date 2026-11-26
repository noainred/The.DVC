/**
 * 물리서버 자산 원장(보증 · 계약) 올리기 창(v3.45 · 시안 docs/design/bm-feature-proposals ①).
 * 흐름: 파일 고르기 → **검증(드라이런)** → 결과 표(오류 줄이 먼저) → 적용. 판정은 서버(bmcheck/assetCsv.js — 드라이런과 커밋이 같은 함수).
 *  · 검증한 글자와 적용할 글자가 같을 때만 적용 단추가 열린다(검증 뒤 파일을 바꿨으면 다시 검증).
 *  · ‘원장을 파일로 바꾸기’ 는 파일에 없는 서버를 원장에서 지운다 — 지워지는 줄 수를 검증 결과에 밝히고, 오류 줄이 있으면 서버가 전부 멈춘다.
 *  · 전체 범위 관리자만 연다(호출부가 canFleet 일 때만 단추를 그린다 · 집행은 서버 게이트).
 */
import React, { useRef, useState } from 'react';
import { Modal } from '../../../components/Modal.jsx';
import { STable } from '../../../components/STable.jsx';
import { postJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { importSummaryText, importRowNote, IMPORT_ACTION } from './checkText.js';
import { decodeCsvBytes } from '../csvDecode.js';   // UTF-8 로 못 읽으면 EUC-KR(한국어 엑셀의 ‘CSV(쉼표로 분리)’) · UTF-16

const FILE_MAX = 900 * 1024;   // 서버 본문 한도(1MB) 안 — 일곱 열을 채운 줄로 약 1만 줄(서버 줄 상한과 같은 크기)
const ENC_TEXT = { 'euc-kr': 'EUC-KR(CP949 — 한국어 엑셀 저장본)', 'utf-16': 'UTF-16(엑셀 ‘유니코드 텍스트’)' };
const sigOf = (s, replace) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return `${s.length}:${h >>> 0}:${replace ? 1 : 0}`; };

export default function AssetLedger({ meta, onClose, onChanged }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [enc, setEnc] = useState('');       // 파일을 읽은 글자 인코딩(utf-8 이 아니면 화면에 밝힌다)
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);     // 드라이런 결과 + 그때의 지문
  const [msg, setMsg] = useState(null);     // { ok, text }
  const sig = text ? sigOf(text, replace) : '';
  const checked = !!res && res.sig === sig;
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > FILE_MAX) { setMsg({ ok: false, text: `파일이 ${Math.round(f.size / 1024)}KB 입니다 — ${Math.round(FILE_MAX / 1024)}KB 이하로 나눠 올리십시오.` }); return; }
    try {
      // f.text() 는 UTF-8 로만 읽는다 — 한국어 엑셀 기본 저장(CP949)의 한글이 깨진 채 원장에 저장됐다(반증 B3). 바이트로 받아 판별한다
      const { text: t, encoding } = decodeCsvBytes(await f.arrayBuffer());
      if (t.includes('\uFFFD')) { setText(''); setName(f.name); setEnc(''); setRes(null); setMsg({ ok: false, text: '파일의 글자를 읽지 못했습니다(깨진 글자가 있습니다) — UTF-8 또는 한국어 엑셀의 ‘CSV(쉼표로 분리)’ 로 저장해 다시 고르십시오.' }); return; }
      setText(t); setName(f.name); setEnc(encoding); setRes(null); setMsg(null);
    } catch (ex) { setMsg({ ok: false, text: `파일을 읽지 못했습니다: ${ex?.message || ex}` }); }
  };
  const run = async (dryRun) => {
    setBusy(true); setMsg(null);
    try {
      // 적용은 미리본 원장(base)을 함께 보낸다 — 그 사이 원장이 바뀌었으면 서버가 409 로 멈춘다(지워지는 줄이 미리보기와 달라지지 않게)
      const r = await postJson('/admin/bm-assets/import', { csv: text, dryRun, replace, ...(dryRun ? {} : { expect: res?.base }) });
      if (!r || r.ok === false) throw new Error(r?.reason || '요청을 처리하지 못했습니다.');
      if (dryRun) setRes({ ...r, sig });
      else {
        // 적용이 끝나면 다시 검증해야 적용이 열린다(sig '' — 같은 미리보기로 두 번 적용하지 않게: 반증 B11 — 둘째 누름은 ‘원장이 바뀌었습니다’ 가 됐다). 결과 표는 남긴다
        setRes({ ...r, sig: '', applied: true });
        setMsg({ ok: true, text: r.changed ? `원장에 적용했습니다 — ${importSummaryText(r.summary, { replace })}.` : '바뀐 것이 없어 쓰지 않았습니다.' });
        if (r.changed) onChanged?.();
      }
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); }
    finally { setBusy(false); }
  };
  const dl = (path, file) => downloadFile(path, file).catch((e) => setMsg({ ok: false, text: opErrorText(e) }));
  const s = res?.summary;
  const blocked = replace && s && s.error > 0;
  const csvOk = canCsv();   // 올리기 · 내려받기 · 샘플은 CSV 권한(data.csv)도 본다 — 없으면 단추를 잠그고 이유를 쓴다(눌러서 403 을 보게 하지 않는다)
  return (
    <Modal title="자산 원장(보증 · 계약) 올리기" onClose={() => { if (!busy) onClose(); }} width={720}>
      <div className="bmd-al">
        <div className="muted bmd-note">
          서비스 태그마다 보증 만료일 · 보증 종류 · 구매일 · 계약 번호 · 지원 종료일을 CSV 로 올립니다. 포탈은 제조사에 조회하지 않습니다 — 값은 이 파일에서만 옵니다.
          원장에 없는 서버는 ‘모름’ 으로 따로 셉니다(끝남에도 정상에도 넣지 않습니다).
          파일에 없는 열은 원장의 값을 그대로 두고, 열이 있는데 칸이 비어 있으면 그 값을 지웁니다(검증 결과에 바뀌는 칸을 밝힙니다).
        </div>
        <div className="muted bmd-note">
          지금 원장: {meta?.unreadable ? '파일을 읽지 못했습니다(서비스 점검에서 확인 — 올리기가 막힙니다)' : `${meta?.n ?? 0}줄${meta?.at ? ` · ${new Date(meta.at).toLocaleString()} 갱신` : ' · 아직 올린 적 없음'}${meta?.by ? ` · ${meta.by}` : ''}`}
        </div>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={pick} />
          <button type="button" className="logout-btn" disabled={busy || !csvOk} onClick={() => fileRef.current?.click()}>파일 고르기</button>
          <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name || '고른 파일 없음'}{ENC_TEXT[enc] ? ` · ${ENC_TEXT[enc]} 로 읽음` : ''}</span>
          <span style={{ flex: 1 }} />
          {csvOk ? <button type="button" className="logout-btn" disabled={busy} onClick={() => dl('/admin/bm-assets/sample.csv', 'bm-assets-sample.csv')}>샘플 CSV</button> : null}
          {csvOk ? <button type="button" className="logout-btn" disabled={busy || !!meta?.unreadable} onClick={() => dl('/admin/bm-assets.csv', 'bm-assets.csv')}>지금 원장 내려받기</button> : null}
        </div>
        {csvOk ? null : <div className="muted bmd-note" role="status">{CSV_DENIED_NOTE}</div>}
        <label className="bmd-al-chk">
          <input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.target.checked)} />
          <span>원장을 이 파일로 바꾸기 — 파일에 없는 서버를 원장에서 지웁니다(끄면 파일의 줄만 더하고 바꿉니다)</span>
        </label>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <button type="button" className="login-btn bmd-btn" disabled={busy || !text || !csvOk} onClick={() => run(true)}>검증</button>
          <button type="button" className="login-btn bmd-btn" disabled={busy || !csvOk || !checked || blocked || !s || (!s.add && !s.update && !(replace && s.remove))} onClick={() => run(false)}
            title={!checked ? '먼저 검증하십시오(검증 뒤 파일 · 바꾸기 선택을 바꿨으면 다시 검증)' : blocked ? '오류 줄이 있으면 ‘파일로 바꾸기’ 를 할 수 없습니다' : undefined}>적용</button>
          {s && (checked || res.applied) ? <span className="muted">{res.total}줄 — {importSummaryText(s, { replace })}</span> : null}
        </div>
        {blocked && checked ? <div className="bmd-note" style={{ color: 'var(--red)' }} role="alert">오류 줄이 {s.error}개 있어 ‘원장을 파일로 바꾸기’ 를 할 수 없습니다 — 오류 줄의 서버가 원장에서 사라지지 않게 전부 멈춥니다. 오류를 고치거나 바꾸기를 끄십시오.</div> : null}
        {msg ? <div className={`bmd-opnote ${msg.ok ? 'ok' : 'bad'}`} role={msg.ok ? 'status' : 'alert'} style={{ borderRadius: 8, borderBottom: 0 }}>{msg.text}</div> : null}
        {res?.report?.length && (checked || res.applied) ? (
          <>
            {/* 최소 폭을 작게 — 400px 화면에서 사유 열이 가로 스크롤 뒤로 가지 않게(칸은 줄바꿈된다) */}
            <STable className="table bmd-ct" minWidth={300} limit={200}>
              <thead><tr><th>줄</th><th>서비스 태그</th><th>결과</th><th>사유 · 바뀌는 칸</th></tr></thead>
              <tbody>
                {res.report.map((x, i) => {
                  const a = IMPORT_ACTION[x.action] || IMPORT_ACTION.error;
                  return (
                    <tr key={`${x.line}:${i}`}>
                      <td data-sort={x.line ?? ''}>{x.line ?? '—'}</td>
                      <td className="mono" data-sort={x.tag || ''}>{x.tag || '—'}</td>
                      <td data-sort={a.label}><span className={`badge ${a.badge}`}>{a.label}</span></td>
                      <td data-sort={importRowNote(x)} style={{ overflowWrap: 'anywhere' }}>{importRowNote(x)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
            {res.report.length > 200 || res.reportOmitted ? <div className="muted bmd-note">표에는 앞 {Math.min(200, res.report.length)}줄만 보입니다(오류 줄이 먼저 · 전체 {res.total}줄).</div> : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
