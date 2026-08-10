import React, { useState } from 'react';
import { fetchJson, downloadFile } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';

/**
 * 성능점검 대상 내보내기 — CSV · XLSX(엑셀) · JSON 세 포맷.
 *
 * 가져오기(등록)는 성능점검 트리의 '＋ 등록' 통합 마법사(파일 모드)로 옮겼다 — 등록 경로를 하나로
 * 모아 소량 직접입력·대량 붙여넣기·파일·템플릿·엣지 배정을 한 흐름에서 처리한다. 이 화면은
 * 내보내기(백업/현황)와 컬럼 설명만 담당한다.
 *
 * 포맷은 확장자로 자동 판별한다(.xlsx=엑셀, .json=JSON, 그 외 CSV). 점검 1건이 1행이다.
 */

const EXP_FMT = [
  { v: 'csv', label: 'CSV', ext: 'csv' },
  { v: 'xlsx', label: '엑셀(XLSX)', ext: 'xlsx' },
  { v: 'json', label: 'JSON', ext: 'json' },
];

export default function CsvTab({ canEdit }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [schema, setSchema] = useState(null);
  const [showCols, setShowCols] = useState(false);
  const [exp, setExp] = useState({ kind: '', path: '', tests: true, format: 'csv' });

  const doExport = async () => {
    setErr(''); setBusy('export'); setDone('');
    try {
      const qs = new URLSearchParams();
      if (exp.kind) qs.set('kind', exp.kind);
      if (exp.path.trim()) qs.set('path', exp.path.trim());
      if (!exp.tests) qs.set('tests', '0');
      const path = `/svcmon/targets/export.${exp.format}?${qs}`;
      const name = await downloadFile(path);
      setDone(`${name} 을 내려받았습니다.`);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const doSample = async () => {
    setErr(''); setBusy('sample'); setDone('');
    try {
      await downloadFile('/svcmon/targets/sample.csv');
      setDone('샘플 CSV 를 내려받았습니다. 헤더를 그대로 두고 값만 바꿔, 트리의 “＋ 등록 → 파일”에서 가져오세요.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const loadSchema = async () => {
    if (schema) { setShowCols((v) => !v); return; }
    try { setSchema(await fetchJson('/svcmon/targets/csv-schema')); setShowCols(true); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="flex col gap">
      <div className="card" style={{ padding: 14 }}>
        <b>내보내기</b>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
          점검 1건이 1행입니다(한 대상에 점검이 여러 개면 앞 5열이 반복). CSV·XLSX 는 UTF-8/엑셀에서 바로 열립니다.
          <br />등록·가져오기는 성능점검 트리의 <b>＋ 등록</b>(파일 모드에서 CSV/XLSX 가져오기)으로 통합됐습니다.
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={exp.kind} onChange={(e) => setExp({ ...exp, kind: e.target.value })}>
            <option value="">전체 (인프라 + 서비스)</option>
            <option value="infra">인프라만</option>
            <option value="service">서비스만</option>
          </select>
          <input className="input" style={{ minWidth: 260 }} placeholder="경로로 범위 좁히기 (예: A.Infra\OC2)"
            value={exp.path} onChange={(e) => setExp({ ...exp, path: e.target.value })} />
          <select className="select" value={exp.format} onChange={(e) => setExp({ ...exp, format: e.target.value })} title="내보낼 파일 형식">
            {EXP_FMT.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={exp.tests} onChange={(e) => setExp({ ...exp, tests: e.target.checked })} />
            점검 항목 포함
          </label>
          <button className="login-btn" disabled={!canEdit || busy === 'export'} onClick={doExport}>
            {busy === 'export' ? '내보내는 중…' : `⤓ ${EXP_FMT.find((f) => f.v === exp.format)?.label || ''} 내보내기`}
          </button>
          <button className="tab" disabled={!canEdit || busy === 'sample'} onClick={doSample}>⤓ 샘플 CSV</button>
          <button className="tab" disabled={!canEdit} onClick={loadSchema}>{showCols ? '컬럼 설명 닫기' : '컬럼 설명 보기'}</button>
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

        {err && <ErrorBox message={err} />}
        {done && <div className="svc-ok" style={{ marginTop: 8 }}>{done}</div>}
        {!canEdit && <div className="svc-warn" style={{ marginTop: 8 }}>내보내기·샘플·컬럼 설명은 operator 이상 권한이 필요합니다(서버가 강제).</div>}
      </div>
    </div>
  );
}
