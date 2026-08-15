import React, { useState } from 'react';
import { fetchJson, postJson, downloadFile } from '../api.js';
import { ErrorBox, Loading } from '../components/ui.jsx';

const levelClass = { 높음: 'red', 중간: 'amber', 경고: 'amber', 낮음: 'gray' };

function FindingTable({ rows }) {
  return (
    <div className="table-wrap" style={{ maxHeight: '48vh' }}>
      <table>
        <thead><tr><th>수준</th><th>항목</th><th>판단</th><th>근거</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={`${r.level}-${r.title}`}>
            <td><span className={`badge ${levelClass[r.level] || 'gray'}`}>{r.level}</span></td>
            <td><b>{r.title}</b></td>
            <td style={{ whiteSpace: 'normal', minWidth: 360 }}>{r.detail}</td>
            <td><code>{r.evidence}</code></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function CodexCheck() {
  const { data, error, loading } = useReport();
  const [message, setMessage] = useState('');
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return null;

  const write = async () => {
    try {
      const r = await postJson('/admin/codex-check/write', {});
      setMessage(`기록 완료: ${r.fileName}`);
    } catch (e) { setMessage(`기록 실패: ${e.message}`); }
  };
  const download = async () => {
    try { await downloadFile('/admin/codex-check/file', data.fileName); setMessage('Markdown 다운로드 완료'); }
    catch (e) { setMessage(`다운로드 실패: ${e.message}`); }
  };

  return (
    <>
      <div className="section-title">🛡️ 보안·완성도 점검</div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex between wrap gap">
          <div>
            <h2 style={{ margin: 0 }}>프로그램 점검 보고서</h2>
            {/* 점검 결과는 2026-08-08 스냅샷(상수) — 조회 시각을 점검일처럼 보이지 않게 명시 */}
            <div className="muted" style={{ marginTop: 6 }}>정적 코드 점검 스냅샷(2026-08-08) · 점검 당시 버전 기준 · 조회 {new Date(data.generatedAt).toLocaleString('ko-KR')}</div>
          </div>
          <div className="flex gap wrap">
            <button className="login-btn" onClick={write}>📄 파일 기록</button>
            <button className="tab" onClick={download}>⬇ Markdown</button>
          </div>
        </div>
        {message && <div className="muted" style={{ marginTop: 10 }}>{message}</div>}
      </div>

      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="card kpi"><div className="label">보안 판정</div><div className="value" style={{ color: 'var(--amber)' }}>{data.verdict.security}</div><div className="meta">운영 설정 보완 필요</div></div>
        <div className="card kpi"><div className="label">완성도</div><div className="value" style={{ color: 'var(--amber)' }}>{data.verdict.completeness}</div><div className="meta">기능은 넓으나 검증 잔여</div></div>
        <div className="card kpi"><div className="label">테스트</div><div className="value" style={{ color: 'var(--red)' }}>{data.verdict.test}</div><div className="meta">543 pass / 4 fail / 3 cancelled</div></div>
      </div>

      <div className="section-title">보안 점검 결과 ({data.security.length})</div>
      <FindingTable rows={data.security} />
      <div className="section-title">완성도 점검 결과 ({data.completeness.length})</div>
      <FindingTable rows={data.completeness} />
      <div className="section-title">권장 개선 순서</div>
      <div className="card"><ol style={{ margin: 0, paddingLeft: 22 }}>{data.recommendations.map((r) => <li key={r} style={{ marginBottom: 8 }}>{r}</li>)}</ol></div>
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>본 보고서는 정적 점검 결과이며 실제 침투테스트·부하테스트를 대체하지 않습니다.</p>
    </>
  );
}

function useReport() {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  React.useEffect(() => {
    let active = true;
    fetchJson('/admin/codex-check').then((data) => active && setState({ data, error: null, loading: false }))
      .catch((error) => active && setState({ data: null, error: error.message, loading: false }));
    return () => { active = false; };
  }, []);
  return state;
}
