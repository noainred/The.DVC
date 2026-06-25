import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * vCenter 연결 테스트 — 등록된 모든 vCenter의 로그인 연결을 한 번에(병렬) 점검한다.
 * 실패 항목은 사유/힌트를 보여주고, 중계(HAProxy) 경로 단계별 테스트(TCP·TLS·HTTP)로 어디서
 * 막혔는지 바로 짚을 수 있게 한다. (수집을 켜기 전 자격증명/네트워크 사전 검증용)
 */
export default function VCenterConnTest() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({}); // id -> { ok, ms, reason, hint, code, testing }
  const [busyAll, setBusyAll] = useState(false);
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [testedAt, setTestedAt] = useState(null);

  const load = async () => {
    try { const r = await fetchJson('/admin/vcenters'); setList(r.vcenters || []); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const testOne = async (vc) => {
    setResults((m) => ({ ...m, [vc.id]: { ...m[vc.id], testing: true } }));
    try {
      const r = await postJson('/admin/vcenters/test', { id: vc.id });
      setResults((m) => ({ ...m, [vc.id]: { ...r, testing: false } }));
    } catch (e) {
      setResults((m) => ({ ...m, [vc.id]: { ok: false, reason: e.message, testing: false } }));
    }
  };

  const testAll = async () => {
    setBusyAll(true);
    // 진행중 표시(병렬 테스트라 결과는 한 번에 들어옴)
    const targets = (list || []).filter((v) => !onlyEnabled || v.enabled !== false);
    setResults((m) => { const n = { ...m }; targets.forEach((v) => { n[v.id] = { ...n[v.id], testing: true }; }); return n; });
    try {
      const r = await postJson(`/admin/vcenters/test-all${onlyEnabled ? '?only=enabled' : ''}`, {});
      const map = {};
      (r.results || []).forEach((x) => { map[x.id] = { ...x, testing: false }; });
      setResults((m) => ({ ...m, ...map }));
      setTestedAt(r.testedAt || Date.now());
    } catch (e) {
      setError(e.message);
      setResults((m) => { const n = { ...m }; targets.forEach((v) => { n[v.id] = { ...n[v.id], testing: false }; }); return n; });
    } finally { setBusyAll(false); }
  };

  if (error) return <ErrorBox message={error} />;
  if (!list) return <Loading />;

  const shown = list.filter((v) => !onlyEnabled || v.enabled !== false);
  const done = shown.filter((v) => results[v.id] && !results[v.id].testing);
  const okN = done.filter((v) => results[v.id].ok).length;
  const failN = done.length - okN;

  return (
    <>
      <div className="flex between wrap gap" style={{ marginBottom: 6, alignItems: 'center' }}>
        <div className="section-title" style={{ margin: '6px 0' }}>vCenter 연결 테스트 (관리자)</div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }} title="‘수집 사용’으로 설정된 vCenter만 테스트">
            <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} /> 수집 사용만
          </label>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} disabled={busyAll || shown.length === 0} onClick={testAll}>
            {busyAll ? '테스트 중…' : `전체 연결 테스트 (${shown.length})`}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <span className="badge green">정상 {okN}</span>
          <span className="badge red">실패 {failN}</span>
          <span className="badge gray">미실행 {shown.length - done.length}</span>
          {testedAt && <span className="muted" style={{ fontSize: 12 }}>· 마지막 전체 테스트 {new Date(testedAt).toLocaleTimeString('ko-KR')}</span>}
          <span className="muted" style={{ fontSize: 12 }}>· 각 vCenter에 로그인→로그아웃을 시도해 연결/자격증명을 검증합니다.</span>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>이름</th><th>호스트</th><th>수집</th><th>결과</th><th className="right">작업</th>
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 28 }}>등록된 vCenter가 없습니다. ‘vCenter 관리’에서 먼저 등록하세요.</td></tr>}
            {shown.map((vc) => {
              const r = results[vc.id];
              return (
                <tr key={vc.id}>
                  <td><b>{vc.id}</b></td>
                  <td>{vc.name}{vc.collectMode === 'site' && <span className="badge amber" style={{ marginLeft: 6, fontSize: 10 }}>사이트 위임</span>}</td>
                  <td className="muted">{vc.host}</td>
                  <td>{vc.enabled !== false ? <span className="badge green">사용</span> : <span className="badge gray">중지</span>}</td>
                  <td>
                    {!r && <span className="muted">—</span>}
                    {r?.testing && <span className="badge blue">테스트 중…</span>}
                    {r && !r.testing && r.ok && <span className="badge green">✓ 연결 성공 {r.ms != null ? `(${r.ms}ms)` : ''}</span>}
                    {r && !r.testing && !r.ok && (
                      <div>
                        <span className="badge red">✗ 실패</span>
                        <span style={{ marginLeft: 6, color: '#f87171', fontSize: 13 }}>{r.reason}</span>
                        {r.hint && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>💡 {r.hint}</div>}
                      </div>
                    )}
                  </td>
                  <td className="right nowrap">
                    <button className="tab" disabled={r?.testing} onClick={() => testOne(vc)}>{r?.testing ? '…' : '테스트'}</button>
                    {r && !r.testing && !r.ok && <RelayTest vcenterId={vc.id} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
        · 연결 실패 시 <b>중계 경로 테스트</b>로 TCP→TLS→HTTP 어느 단계에서 막혔는지 확인할 수 있습니다(HAProxy 중계 환경 진단).
        · 자격증명은 저장된 값을 사용합니다. 새 자격증명 검증은 ‘vCenter 관리 → 수정 → 연결 테스트’를 이용하세요.
      </div>
    </>
  );
}

/** 중계 경로 단계별 진단(TCP·TLS·HTTP) — 실패 행에서 펼쳐 본다. */
function RelayTest({ vcenterId }) {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const run = async () => {
    setBusy(true); setR(null);
    try { setR(await fetchJson(`/admin/vcenter/relay-test?vcenterId=${encodeURIComponent(vcenterId)}`)); }
    catch (e) { setR({ ok: false, reason: e.message }); }
    setBusy(false);
  };
  const Step = ({ label, s }) => {
    if (!s) return <span className="badge gray" style={{ marginRight: 4 }}>{label} —</span>;
    return <span className={`badge ${s.ok ? 'green' : 'red'}`} style={{ marginRight: 4 }} title={s.error || ''}>{label} {s.ok ? '✓' : '✗'}{s.ms != null ? ` ${s.ms}ms` : ''}</span>;
  };
  return (
    <div style={{ marginTop: 6, textAlign: 'left' }}>
      <button className="tab" disabled={busy} onClick={run}>{busy ? '진단 중…' : '🔎 중계 경로'}</button>
      {r && (r.ok === false ? (
        <div style={{ marginTop: 6, color: '#f87171', fontSize: 12 }}>{r.reason}</div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <div className="muted" style={{ marginBottom: 4 }}>대상 {r.host}:{r.port}</div>
          <div style={{ marginBottom: 4 }}>
            <Step label="TCP" s={r.steps.tcp} />
            <Step label="TLS" s={r.steps.tls} />
            <Step label="HTTP" s={r.steps.http} />
          </div>
          <div style={{ color: r.verdict.state === 'ok' ? 'var(--green)' : 'var(--amber)' }}>
            {r.verdict.state === 'ok' ? '✅' : '⚠️'} {r.verdict.text}
          </div>
        </div>
      ))}
    </div>
  );
}
