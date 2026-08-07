import React, { useState } from 'react';
import { fetchJson, postJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import PreviewTable from './PreviewTable.jsx';

/**
 * 성능점검 CSV 가져오기 / 내보내기.
 *
 * 가져오기는 **미리보기 → 확인 → 등록** 2단계다. 미리보기 없이 바로 등록하는 버튼을 두지 않는다
 * — 2,000행 등록은 되돌리기가 비싸고(배치 롤백이 있지만 그사이 폴러가 이미 점검을 시작한다),
 * 무엇이 새로 만들어지고 무엇이 건너뛰어지는지 사람이 보고 판단해야 한다.
 *
 * 등록은 서버에서 all-or-nothing 이다. 오류가 1건이라도 있으면 아무것도 저장되지 않으므로
 * '오류 무시하고 나머지만 등록' 버튼도 두지 않는다(부분 등록 상태가 가장 추적하기 어렵다).
 */
export default function CsvTab({ canEdit }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [schema, setSchema] = useState(null);
  const [showCols, setShowCols] = useState(false);

  const [exp, setExp] = useState({ kind: '', path: '', tests: true });

  const doExport = async () => {
    setErr(''); setBusy('export');
    try {
      const qs = new URLSearchParams();
      if (exp.kind) qs.set('kind', exp.kind);
      if (exp.path.trim()) qs.set('path', exp.path.trim());
      if (!exp.tests) qs.set('tests', '0');
      const name = await downloadFile(`/svcmon/targets/export.csv?${qs}`);
      setDone({ kind: 'export', text: `${name} 을 내려받았습니다.` });
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const doSample = async () => {
    setErr(''); setBusy('sample');
    try {
      await downloadFile('/svcmon/targets/sample.csv');
      setDone({ kind: 'sample', text: '샘플 CSV 를 내려받았습니다. 헤더를 그대로 두고 값만 바꿔 쓰세요.' });
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const loadSchema = async () => {
    if (schema) { setShowCols((v) => !v); return; }
    try { setSchema(await fetchJson('/svcmon/targets/csv-schema')); setShowCols(true); }
    catch (e) { setErr(e.message); }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // 브라우저에서 읽어 텍스트로 보낸다 — 서버가 multipart 를 다루지 않고, 미리보기 단계에서
    // 같은 본문을 두 번(미리보기·등록) 보내야 하므로 클라이언트가 원문을 들고 있는 게 맞다.
    const r = new FileReader();
    r.onload = () => {
      setCsv(String(r.result || ''));
      setFileName(f.name);
      setPreview(null); setDone(null); setErr('');
    };
    r.onerror = () => setErr('파일을 읽지 못했습니다.');
    r.readAsText(f, 'utf-8');
  };

  const doPreview = async () => {
    setErr(''); setDone(null); setBusy('preview');
    try {
      const r = await postJson('/svcmon/targets/import', { csv, mode: 'preview' });
      if (r.error) setErr(r.error);
      setPreview(r);
    } catch (e) { setErr(e.message); setPreview(null); } finally { setBusy(''); }
  };

  const doImport = async () => {
    setErr(''); setBusy('import');
    try {
      const r = await postJson('/svcmon/targets/import', {
        csv, mode: 'add', expectedCount: preview?.expectedCount,
      });
      if (r.error) { setErr(r.error); setPreview(r); return; }
      setDone({ kind: 'import', text: `대상 ${r.added}개 · 점검 ${r.newTests}개를 등록했습니다. 배치 ${r.batch}` });
      setPreview(null); setCsv(''); setFileName('');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const rows = csv ? csv.split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;
  const canCommit = preview && !preview.error && (preview.summary?.error || 0) === 0
    && (preview.summary?.create || 0) > 0 && preview.capacity?.verdict !== 'reject';

  return (
    <div className="flex col gap">
      {/* ── 내보내기 ── */}
      <div className="card" style={{ padding: 14 }}>
        <b>내보내기</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
          점검 1건이 1행입니다(한 대상에 점검이 여러 개면 앞 5열이 반복). UTF-8 BOM 이라 엑셀에서 바로 열립니다.
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={exp.kind} onChange={(e) => setExp({ ...exp, kind: e.target.value })}>
            <option value="">전체 (인프라 + 서비스)</option>
            <option value="infra">인프라만</option>
            <option value="service">서비스만</option>
          </select>
          <input className="input" style={{ minWidth: 260 }} placeholder="경로로 범위 좁히기 (예: A.Infra\OC2)"
            value={exp.path} onChange={(e) => setExp({ ...exp, path: e.target.value })} />
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={exp.tests} onChange={(e) => setExp({ ...exp, tests: e.target.checked })} />
            점검 항목 포함
          </label>
          <button className="login-btn" disabled={busy === 'export'} onClick={doExport}>
            {busy === 'export' ? '내보내는 중…' : '⤓ CSV 내보내기'}
          </button>
          <button className="tab" disabled={busy === 'sample'} onClick={doSample}>⤓ 샘플 CSV</button>
          <button className="tab" onClick={loadSchema}>{showCols ? '컬럼 설명 닫기' : '컬럼 설명 보기'}</button>
        </div>

        {showCols && schema && (
          <div className="table-wrap" style={{ maxHeight: '40vh', marginTop: 10 }}>
            <table>
              <thead><tr><th>컬럼</th><th>뜻</th><th>필수</th><th>값</th><th>해당 유형</th></tr></thead>
              <tbody>
                {[...schema.target, ...schema.test].map((c) => (
                  <tr key={c.col}>
                    <td><code>{c.col}</code></td>
                    <td>{c.label}</td>
                    <td>{c.required ? <span className="badge red">필수</span>
                      : c.requiredFor ? <span className="badge amber">{c.requiredFor.join('/')} 필수</span> : ''}</td>
                    <td className="muted">
                      {c.kind === 'bool' ? '1/true/yes/y/on/예 = 참, 0/false/no/n/off/아니오 = 거짓'
                        : c.kind === 'enum' ? (c.col === 'kind' ? schema.kinds.join(' | ') : `${schema.types.length}종`)
                          : c.kind === 'int' ? `${c.min}~${c.max}${c.dflt ? ` (기본 ${c.dflt})` : ' (비우면 미지정)'}`
                            : c.kind === 'port' ? '1~65535 (비우면 유형 기본 포트)'
                              : `문자 ${c.max}자 이내`}
                    </td>
                    <td className="muted">{c.usedBy ? c.usedBy.join(', ') : '공통'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, padding: '6px 2px' }}>
              빈 칸 = 기본값(하한이 아닙니다). <code>id</code>·<code>order</code> 컬럼은 없습니다 —
              가져오기가 항상 새 항목으로 등록하므로 왕복에 의미가 없습니다.
            </div>
          </div>
        )}
      </div>

      {/* ── 가져오기 ── */}
      <div className="card" style={{ padding: 14 }}>
        <b>가져오기</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
          ① 파일 선택 → ② 미리보기 → ③ 등록. 이미 있는 대상(구분+경로+이름)은 건너뜁니다.
          오류가 1건이라도 있으면 <b>아무것도 등록하지 않습니다</b>(부분 등록 없음).
        </div>

        {!canEdit && (
          <div className="svc-warn">조회만 가능합니다 — 가져오기는 operator 이상 권한이 필요합니다.</div>
        )}

        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={!canEdit} />
          {fileName && <span className="muted" style={{ fontSize: 12 }}>{fileName} · 약 {rows.toLocaleString()}행</span>}
          <button className="login-btn" disabled={!canEdit || !csv.trim() || busy === 'preview'} onClick={doPreview}>
            {busy === 'preview' ? '검사 중…' : '미리보기'}
          </button>
          {preview && (
            <button className="login-btn" disabled={!canEdit || !canCommit || busy === 'import'} onClick={doImport}
              title={canCommit ? '' : '오류가 없고 등록할 대상이 1개 이상일 때만 등록할 수 있습니다.'}>
              {busy === 'import' ? '등록 중…' : `${(preview.summary?.create || 0).toLocaleString()}개 등록`}
            </button>
          )}
          {(preview || csv) && (
            <button className="tab" onClick={() => { setCsv(''); setFileName(''); setPreview(null); setDone(null); setErr(''); }}>
              초기화
            </button>
          )}
        </div>

        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>파일 대신 붙여넣기</summary>
          <textarea className="input" rows={6} style={{ width: '100%', marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
            placeholder={'kind,path,target_name,host,...\ninfra,A.Infra\\OC2,srv01,10.20.30.41,...'}
            value={csv} onChange={(e) => { setCsv(e.target.value); setFileName(''); setPreview(null); }} disabled={!canEdit} />
        </details>

        {err && <ErrorBox message={err} />}
        {done && <div className="svc-ok">{done.text}</div>}
      </div>

      {busy === 'preview' && <Loading />}
      {preview && <PreviewTable result={preview} title="가져오기 미리보기" />}
    </div>
  );
}
