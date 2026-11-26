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
import { postJson, downloadFile, canCsv } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { importSummaryText, IMPORT_ACTION } from './checkText.js';

const FILE_MAX = 900 * 1024;   // 서버 본문 한도(1MB) 안 — 원장 2만 줄이면 넉넉하다
const sigOf = (s, replace) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return `${s.length}:${h >>> 0}:${replace ? 1 : 0}`; };

export default function AssetLedger({ meta, onClose, onChanged }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
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
    try { setText(await f.text()); setName(f.name); setRes(null); setMsg(null); } catch (ex) { setMsg({ ok: false, text: `파일을 읽지 못했습니다: ${ex?.message || ex}` }); }
  };
  const run = async (dryRun) => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/bm-assets/import', { csv: text, dryRun, replace });
      if (!r || r.ok === false) throw new Error(r?.reason || '요청을 처리하지 못했습니다.');
      if (dryRun) setRes({ ...r, sig });
      else {
        setRes({ ...r, sig });
        setMsg({ ok: true, text: r.changed ? `원장에 적용했습니다 — ${importSummaryText(r.summary, { replace })}.` : '바뀐 것이 없어 쓰지 않았습니다.' });
        if (r.changed) onChanged?.();
      }
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); }
    finally { setBusy(false); }
  };
  const dl = (path, file) => downloadFile(path, file).catch((e) => setMsg({ ok: false, text: opErrorText(e) }));
  const s = res?.summary;
  const blocked = replace && s && s.error > 0;
  return (
    <Modal title="자산 원장(보증 · 계약) 올리기" onClose={onClose} width={720}>
      <div className="bmd-al">
        <div className="muted bmd-note">
          서비스 태그마다 보증 만료일 · 보증 종류 · 구매일 · 계약 번호 · 지원 종료일을 CSV 로 올립니다. 포탈은 제조사에 조회하지 않습니다 — 값은 이 파일에서만 옵니다.
          원장에 없는 서버는 ‘모름’ 으로 따로 셉니다(끝남에도 정상에도 넣지 않습니다).
        </div>
        <div className="muted bmd-note">
          지금 원장: {meta?.unreadable ? '파일을 읽지 못했습니다(서비스 점검에서 확인 — 올리기가 막힙니다)' : `${meta?.n ?? 0}줄${meta?.at ? ` · ${new Date(meta.at).toLocaleString()} 갱신` : ' · 아직 올린 적 없음'}${meta?.by ? ` · ${meta.by}` : ''}`}
        </div>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={pick} />
          <button type="button" className="logout-btn" disabled={busy} onClick={() => fileRef.current?.click()}>파일 고르기</button>
          <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name || '고른 파일 없음'}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="logout-btn" disabled={busy} onClick={() => dl('/admin/bm-assets/sample.csv', 'bm-assets-sample.csv')}>샘플 CSV</button>
          {canCsv() ? <button type="button" className="logout-btn" disabled={busy || !!meta?.unreadable} onClick={() => dl('/admin/bm-assets.csv', 'bm-assets.csv')}>지금 원장 내려받기</button> : null}
        </div>
        <label className="bmd-al-chk">
          <input type="checkbox" checked={replace} disabled={busy} onChange={(e) => setReplace(e.target.checked)} />
          <span>원장을 이 파일로 바꾸기 — 파일에 없는 서버를 원장에서 지웁니다(끄면 파일의 줄만 더하고 바꿉니다)</span>
        </label>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <button type="button" className="login-btn bmd-btn" disabled={busy || !text} onClick={() => run(true)}>검증</button>
          <button type="button" className="login-btn bmd-btn" disabled={busy || !checked || blocked || !s || (!s.add && !s.update && !(replace && s.remove))} onClick={() => run(false)}
            title={!checked ? '먼저 검증하십시오(검증 뒤 파일 · 바꾸기 선택을 바꿨으면 다시 검증)' : blocked ? '오류 줄이 있으면 ‘파일로 바꾸기’ 를 할 수 없습니다' : undefined}>적용</button>
          {s && checked ? <span className="muted">{res.total}줄 — {importSummaryText(s, { replace })}</span> : null}
        </div>
        {blocked && checked ? <div className="bmd-note" style={{ color: 'var(--red)' }} role="alert">오류 줄이 {s.error}개 있어 ‘원장을 파일로 바꾸기’ 를 할 수 없습니다 — 오류 줄의 서버가 원장에서 사라지지 않게 전부 멈춥니다. 오류를 고치거나 바꾸기를 끄십시오.</div> : null}
        {msg ? <div className={`bmd-opnote ${msg.ok ? 'ok' : 'bad'}`} role={msg.ok ? 'status' : 'alert'} style={{ borderRadius: 8, borderBottom: 0 }}>{msg.text}</div> : null}
        {res?.report?.length && checked ? (
          <>
            <STable className="table bmd-ct" minWidth={520} limit={200}>
              <thead><tr><th>줄</th><th>서비스 태그</th><th>결과</th><th>사유</th></tr></thead>
              <tbody>
                {res.report.map((x, i) => {
                  const a = IMPORT_ACTION[x.action] || IMPORT_ACTION.error;
                  return (
                    <tr key={`${x.line}:${i}`}>
                      <td data-sort={x.line ?? ''}>{x.line ?? '—'}</td>
                      <td className="mono" data-sort={x.tag || ''}>{x.tag || '—'}</td>
                      <td data-sort={a.label}><span className={`badge ${a.badge}`}>{a.label}</span></td>
                      <td data-sort={x.reason || ''} style={{ overflowWrap: 'anywhere' }}>{x.reason || ''}</td>
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
