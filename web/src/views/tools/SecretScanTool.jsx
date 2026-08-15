import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';

/**
 * 특수기능 › 평문 자격증명 점검(v2.297, admin 전용) — 설정 파일·portal.env·로그·소스에
 * 평문으로 남은 계정정보/로그인 정보를 탐지해 보여준다. 서버(secretScan.js)가 값을 항상
 * 마스킹해 내려주므로 이 화면에 실제 비밀이 표시될 일은 없다.
 * 평문 설정이 발견되면 '설정 › 보안 › 자격증명 저장 방식'(v2.296)으로 암호화 전환을 안내한다.
 */
const STATE_BADGE = { plain: ['평문', 'red'], sealed: ['암호화됨', 'green'], empty: ['빈값', 'gray'] };

export default function SecretScanTool() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (fresh) => {
    setBusy(true); setErr(null);
    try { setD(await fetchJson(`/tools/secret-scan${fresh ? '?fresh=1' : ''}`, {}, undefined, { timeoutMs: 120_000, retries: 0 })); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { run(false); }, []);

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const s = d.summary || {};
  const plainFiles = (d.configFiles || []).filter((f) => f.plain > 0);

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy} onClick={() => run(true)}>
          {busy ? '점검 중…' : '↻ 다시 점검'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          마지막 점검 {d.generatedAt ? new Date(d.generatedAt).toLocaleString('ko-KR') : '—'} · {d.ms}ms ·
          모든 값은 서버에서 마스킹되어 표시됩니다(실제 비밀 미노출).
        </span>
        {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>⚠ {err}</span>}
      </div>

      {/* KPI — 평문이 0 이 목표 상태 */}
      <div className="kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Kpi label="설정 평문 필드" value={s.configPlain ?? 0} accent={s.configPlain ? 'var(--red)' : 'var(--green)'} meta={s.configPlain ? '암호화 전환 권장' : '없음 — 안전'} />
        <Kpi label="설정 암호화 필드" value={s.configSealed ?? 0} accent="var(--green)" />
        <Kpi label="env 민감 키" value={s.envKeys ?? 0} meta="portal.env(평문이 정상 위치 — 권한 확인)" />
        <Kpi label="로그 의심 흔적" value={s.logHits ?? 0} accent={s.logHits ? 'var(--amber)' : undefined} meta="패턴 탐지 — 검토 필요" />
        <Kpi label="소스 의심 라인" value={s.sourceHits ?? 0} accent={s.sourceHits ? 'var(--amber)' : undefined} meta="휴리스틱 — 오탐 가능" />
        <Kpi label="넓은 파일 권한" value={s.widePerm ?? 0} accent={s.widePerm ? 'var(--red)' : 'var(--green)'} meta="그룹/외부 읽기 가능" />
      </div>

      {s.configPlain > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--amber)', fontSize: 13 }}>
          💡 평문 설정 필드 {s.configPlain}개 발견 — <b>설정 › 보안 › 자격증명 저장 방식</b>에서 '암호화 저장'으로
          전환하면 저장 즉시 일괄 봉인됩니다(운영 무중단 · 양방향 전환 가능).
        </div>
      )}

      {/* ① 설정 파일 */}
      <div className="section-title" style={{ fontSize: 14 }}>① 설정 파일(CONFIG_DIR/*.json) — 확정 분류</div>
      <div className="table-wrap" style={{ maxHeight: '38vh', marginBottom: 14 }}>
        <table>
          <thead><tr><th>파일</th><th>권한</th><th style={{ textAlign: 'right' }}>평문</th><th style={{ textAlign: 'right' }}>암호화</th><th style={{ textAlign: 'right' }}>빈값</th><th>상세(필드 위치)</th></tr></thead>
          <tbody>
            {(d.configFiles || []).length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 14 }}>비밀 필드를 가진 설정 파일이 없습니다.</td></tr>}
            {(d.configFiles || []).map((f) => (
              <tr key={f.file}>
                <td><b>{f.file}</b>{f.note && <div className="muted" style={{ fontSize: 11 }}>{f.note}</div>}</td>
                <td>{f.mode ? <span className={`badge ${f.wide ? 'red' : 'gray'}`}>{f.mode}{f.wide ? ' ⚠' : ''}</span> : '—'}</td>
                <td style={{ textAlign: 'right', color: f.plain ? 'var(--red)' : undefined, fontWeight: f.plain ? 700 : 400 }}>{f.plain}</td>
                <td style={{ textAlign: 'right', color: f.sealed ? 'var(--green)' : undefined }}>{f.sealed}</td>
                <td style={{ textAlign: 'right' }} className="muted">{f.empty}</td>
                <td className="muted" style={{ fontSize: 11, maxWidth: 420 }}>
                  {(f.items || []).slice(0, 8).map((it, i) => {
                    const [lb, cls] = STATE_BADGE[it.state] || [it.state, 'gray'];
                    return <span key={i} style={{ marginRight: 8, whiteSpace: 'nowrap' }}><span className={`badge ${cls}`} style={{ fontSize: 10 }}>{lb}</span> {it.path}({it.len}자)</span>;
                  })}
                  {(f.items || []).length > 8 && ` … +${f.items.length - 8}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ② portal.env */}
      {d.env && (
        <>
          <div className="section-title" style={{ fontSize: 14 }}>② portal.env — env 시크릿(평문이 정상 위치 · 파일 권한이 방어선)</div>
          <div className="card" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
            권한 <span className={`badge ${d.env.wide ? 'red' : 'green'}`}>{d.env.mode}{d.env.wide ? ' ⚠ 그룹/외부 읽기 가능 — 600 권장' : ' 적절'}</span>
            <span className="muted" style={{ marginLeft: 10 }}>민감 키 {d.env.keys.length}개: {d.env.keys.map((k) => `${k.key}(${k.len}자)`).join(' · ') || '없음'}</span>
          </div>
        </>
      )}

      {/* ③ 로그 */}
      <div className="section-title" style={{ fontSize: 14 }}>③ 로그 파일 — 비밀번호가 기록된 흔적(패턴 탐지 · 검토 필요)</div>
      {(d.logs || []).length === 0
        ? <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>✅ 로그(꼬리 2MB/파일)에서 자격증명 패턴이 발견되지 않았습니다.</div>
        : (d.logs || []).map((f) => (
          <div key={f.file} className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>{f.file}</b> <span className="muted" style={{ fontSize: 11 }}>검사 {f.scanned}{f.truncated ? ' · 앞부분 미검사(대형 파일)' : ''} · {f.hits.length}건</span>
            {f.hits.map((h, i) => (
              <div key={i} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', color: 'var(--amber)', marginTop: 4, wordBreak: 'break-all' }}>
                [{h.pattern}] {h.preview}
              </div>
            ))}
          </div>
        ))}

      {/* ④ 소스 */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>④ 소스 — 하드코딩 자격증명 의심(휴리스틱 · 오탐 가능)</div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>검사 파일 {d.source?.scannedFiles ?? 0}개{d.source?.capped ? ' (상한 도달 — 일부만 검사)' : ''} · 플레이스홀더/예시/env 참조는 자동 제외</div>
      {(d.source?.hits || []).length === 0
        ? <div className="muted" style={{ fontSize: 13 }}>✅ 소스에서 하드코딩 자격증명 의심 라인이 발견되지 않았습니다.</div>
        : (
          <div className="table-wrap" style={{ maxHeight: '32vh' }}>
            <table>
              <thead><tr><th>파일</th><th style={{ textAlign: 'right' }}>줄</th><th>내용(마스킹)</th></tr></thead>
              <tbody>
                {(d.source.hits || []).map((h, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{h.file}</td>
                    <td style={{ textAlign: 'right' }}>{h.line}</td>
                    <td style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{h.preview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
