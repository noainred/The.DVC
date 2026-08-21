// CSV 일괄 관리 공용 모달(v2.339) — 내보내기(비밀 포함 선택)·가져오기(검증 드라이런 → 덮어쓰기
// 확인 → 실행). 수집 서버 CSV(v2.338, Collectors.jsx)에서 자리잡은 UX 를 화면마다 복제하지 않게
// 엔드포인트/컬럼만 주입받는 형태로 일반화했다(배포 대상·iDRAC 스캔 대역이 사용).
// 서버 계약: import 는 { csv, dryRun?, overwrite? } → dryRun 시 { report, summary{add,overwrite,
// error,...}, total }, 커밋 시 { added, overwritten, skipped[], failed[] }.
import React, { useRef, useState } from 'react';
import { postJson, downloadFile } from '../api.js';
import EscClose from './EscClose.jsx';

/**
 * 내보내기 모달. exportPath 로 다운로드하고, secrets 체크 시 `?secrets=1`(또는 secretsQuery)을
 * 붙인다 — 서버가 설정 소유자 게이트 + 감사로그를 강제한다.
 */
export function CsvExportModal({ title, description, exportPath, secretsQuery = 'secrets=1', secretsLabel, onClose }) {
  const [withSecrets, setWithSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { await downloadFile(`${exportPath}${withSecrets ? `${exportPath.includes('?') ? '&' : '?'}${secretsQuery}` : ''}`); onClose(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 540 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>{description}</div>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12.5, margin: '12px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
          <span>{secretsLabel} — <b style={{ color: 'var(--amber)' }}>자격증명 평문 덤프</b>(설정 소유자만 가능 · 감사로그 기록 · 파일을 자격증명과 동급으로 보관)</span>
        </label>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 8 }}>⚠ {err}</div>}
        <div className="flex gap" style={{ justifyContent: 'flex-end' }}>
          <button className="tab" style={{ padding: '8px 16px' }} onClick={onClose}>닫기</button>
          <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={run}>{busy ? '내려받는 중…' : '⤓ 내려받기'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 가져오기 모달 — 2단계(① 검증 드라이런 ② 실행). 기존 항목과 겹치는 행(overwrite)은
 * 체크박스로 명시 허용해야 적용된다(서버도 overwrite=true 없이는 갱신하지 않음).
 * @param {Array<{key,label,align?,render?}>} columns 드라이런 report 행 표시 컬럼(행 번호/동작/문제는 자동)
 * @param {(f:object)=>string} nameOf skipped/failed 행 표시명 추출
 */
export function CsvImportModal({ title, description, importPath, samplePath, columns, overwriteLabel, nameOf = (f) => f.id || f.host || f.datacenter || '', onClose, onDone }) {
  const fileRef = useRef(null);
  const [text, setText] = useState('');
  const [check, setCheck] = useState(null);
  const [checkedText, setCheckedText] = useState(null);
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setText(String(r.result || '')); setCheck(null); setCheckedText(null); setResult(null); };
    r.readAsText(f);
  };
  const verify = async () => {
    setBusy(true); setErr(null); setResult(null); setCheck(null); setAllowOverwrite(false);
    try {
      const r = await postJson(importPath, { csv: text, dryRun: true });
      if (r.ok === false) setErr(r.reason);
      else { setCheck(r); setCheckedText(text); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await postJson(importPath, { csv: text, overwrite: allowOverwrite });
      if (r.ok === false) setErr(r.reason);
      else setResult(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const verified = check && checkedText === text; // 검증 후 내용이 바뀌면 재검증 요구
  const actLabel = { add: '추가', overwrite: '덮어쓰기', error: '오류' };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <EscClose onClose={() => { if (!busy) onClose(); }} />
      <div className="modal card" style={{ maxWidth: 800 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{description}</div>
        <div className="flex gap wrap" style={{ marginBottom: 8 }}>
          {/* 탭 구분(TSV·엑셀 "텍스트(탭으로 분리)" 저장본)도 서버 파서가 자동 인식(v2.345) — .txt/.tsv 허용 */}
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" style={{ display: 'none' }} onChange={onFile} />
          <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => fileRef.current?.click()}>📁 CSV 파일 선택</button>
          <button className="tab" style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => downloadFile(samplePath).catch((e) => setErr(e.message))}>📄 샘플 CSV</button>
        </div>
        <textarea className="input" style={{ width: '100%', minHeight: 130, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder="여기에 CSV 를 붙여넣거나 위에서 파일을 선택하세요." />
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}

        {check && (
          <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
            <div style={{ marginBottom: 6 }}>
              검증 결과: 총 {check.total}행 — <span style={{ color: 'var(--green)' }}>추가 {check.summary.add}</span>
              {' · '}<span style={{ color: 'var(--amber)' }}>덮어쓰기 {check.summary.overwrite}</span>
              {' · '}<span style={{ color: check.summary.error ? 'var(--red)' : 'var(--text-dim)' }}>오류 {check.summary.error}</span>
              {!verified && <b style={{ color: 'var(--amber)', marginLeft: 8 }}>⚠ 내용이 변경됨 — 재검증 필요</b>}
            </div>
            <div className="table-wrap" style={{ maxHeight: '26vh' }}>
              <table>
                <thead><tr><th style={{ textAlign: 'right' }}>행</th>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align || 'left' }}>{c.label}</th>)}<th>동작</th><th>문제</th></tr></thead>
                <tbody>
                  {check.report.map((r, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'right' }} className="muted">{r.line}</td>
                      {columns.map((c) => <td key={c.key} className="muted" style={{ fontSize: 11.5, textAlign: c.align || 'left' }}>{c.render ? c.render(r) : (r[c.key] ?? '')}</td>)}
                      <td><span className={`badge ${r.action === 'add' ? 'green' : r.action === 'overwrite' ? 'amber' : 'red'}`}>{actLabel[r.action] || r.action}</span></td>
                      <td style={{ color: 'var(--red)', fontSize: 11.5 }}>{r.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 덮어쓰기 확인 — 명시 체크 없이는 기존 항목을 건드리지 않는다(서버도 강제). */}
            {verified && check.summary.overwrite > 0 && !result && (
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5, marginTop: 8, cursor: 'pointer', color: 'var(--amber)' }}>
                <input type="checkbox" checked={allowOverwrite} onChange={(e) => setAllowOverwrite(e.target.checked)} />
                <span>{overwriteLabel(check.summary.overwrite)}</span>
              </label>
            )}
          </div>
        )}

        {result && (
          <div className="card" style={{ padding: 10, marginTop: 10, fontSize: 12.5 }}>
            <div>총 {result.total}행 — <span style={{ color: 'var(--green)' }}>추가 {result.added}</span>
              {' · '}<span style={{ color: 'var(--amber)' }}>덮어쓰기 {result.overwritten}</span>
              {result.skipped?.length ? <> · <span className="muted">건너뜀 {result.skipped.length}</span></> : ''}
              {result.failed?.length ? <> · <span style={{ color: 'var(--red)' }}>실패 {result.failed.length}</span></> : ''}</div>
            {result.skipped?.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="muted">
                {result.skipped.map((f, i) => <li key={i}>행 {f.line} ({nameOf(f)}): {f.reason}</li>)}
              </ul>
            )}
            {result.failed?.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--red)' }}>
                {result.failed.map((f, i) => <li key={i}>행 {f.line} ({nameOf(f)}): {f.reason}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {result
            ? <button className="login-btn" style={{ padding: '8px 18px' }} onClick={onDone}>완료(목록 새로고침)</button>
            : <>
              <button className="tab" style={{ padding: '8px 16px' }} disabled={busy || !text.trim()} onClick={verify}>{busy ? '검사 중…' : '1) 검증(드라이런)'}</button>
              <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy || !verified}
                title={verified ? (check.summary.error ? '오류 행은 건너뛰고 정상 행만 처리됩니다' : '') : '먼저 검증을 통과하세요'}
                onClick={run}>{busy ? '가져오는 중…' : '2) 가져오기 실행'}</button>
            </>}
        </div>
      </div>
    </div>
  );
}
