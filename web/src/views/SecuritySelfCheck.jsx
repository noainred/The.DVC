import React, { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import {
  statusColor, statusLabel, sortChecks, summaryText, groupChecks,
} from './securityCheckText.js';

/**
 * 설정 › 보안 자가진단(v2.500).
 *
 * 왜 만들었나: 기존 '프로그램 보안·완성도 점검'(특수 기능)은 2026-08-08 외부 점검 결과를 코드
 * 상수로 굳혀 둔 **과거 스냅샷**이다. 그 뒤 여러 지적이 실제로 수정됐는데도 화면에는 그대로 남아,
 * 이미 해결된 항목을 현재 결함으로 읽게 만들었다(테스트 결과까지 "543 pass / 4 fail" 로 낡아 있었다).
 * 이 화면은 반대로 **조회할 때마다** 지금 이 서버의 상태를 읽는다.
 *
 * 표시 원칙:
 *  · 점수를 만들지 않는다. 상태별 개수와 항목만 보인다.
 *  · 확인하지 못한 항목은 '확인 못 함' 이고 그 이유를 함께 보인다(없는 것을 정상으로 칠하지 않는다).
 *  · 조치 방법이 있는 항목만 조치 문구를 보인다(없는 조치를 지어내지 않는다).
 *  · 표는 공용 STable — 열 제목 클릭 정렬(루트 CLAUDE.md 규약).
 */
const POLL_MS = 60_000;

function Badge({ label, color }) {
  return <span className={`badge ${color || 'gray'}`}>{label}</span>;
}

function Count({ label, n, color }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 120, flex: '1 1 120px' }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'inherit' }}>{n}</div>
    </div>
  );
}

/** 항목의 상세 행(파일 목록·스위치 목록)을 표로. */
function Rows({ check }) {
  const rows = check.rows || [];
  if (!rows.length) return null;
  if (check.id === 'relax-switches') {
    return (
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <STable>
          <thead><tr><th>환경변수</th><th>의미</th><th>상태</th><th>영향</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.env}>
                <td><code>{r.env}</code></td>
                <td>{r.title}</td>
                <td data-sort={r.status === 'risk' ? 0 : 1}><Badge label={r.status === 'risk' ? '켜짐(보호 꺼짐)' : '기본값'} color={statusColor(r.status)} /></td>
                <td style={{ whiteSpace: 'normal', minWidth: 280 }}>{r.why}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    );
  }
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <STable>
        <thead><tr><th>파일</th>{rows[0]?.perm !== undefined && <th>권한</th>}{rows[0]?.status !== undefined && <th>상태</th>}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td><code>{r.name}</code></td>
              {r.perm !== undefined && <td>{r.perm}</td>}
              {r.status !== undefined && <td data-sort={r.status === 'ok' ? 1 : 0}><Badge label={statusLabel(r.status)} color={statusColor(r.status)} /></td>}
            </tr>
          ))}
        </tbody>
      </STable>
    </div>
  );
}

export default function SecuritySelfCheck() {
  // ⚠ 훅은 조기 return 위에 — 렌더 간 훅 개수가 달라지면 React #310 으로 화면 전체가 죽는다(v2.202).
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});      // 항목 id → 상세 펼침
  const [onlyIssues, setOnlyIssues] = useState(false);

  const load = async () => {
    try { setD(await fetchJson('/admin/security/self-check')); setError(''); }
    catch (e) { setError(e.message || String(e)); }
  };
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, []);

  if (error && !d) return <ErrorBox message={error} />;
  if (!d) return <Loading />;

  const s = d.summary || {};
  const all = sortChecks(d.checks || []);
  const shown = onlyIssues ? all.filter((c) => c.status !== 'ok') : all;
  const groups = groupChecks(shown);

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>보안 자가진단</h3>
      {error && <div className="banner warn" style={{ marginBottom: 8 }}>새로고침 실패(직전 값을 보고 있습니다): {error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        조회 시각 {new Date(d.checkedAt).toLocaleString('ko-KR')} · 버전 {d.version}. {d.scope}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Count label="보호 꺼짐" n={s.risk || 0} color={s.risk ? 'var(--red)' : undefined} />
        <Count label="점검 권장" n={s.warn || 0} color={s.warn ? 'var(--amber)' : undefined} />
        <Count label="확인 못 함" n={s.unknown || 0} />
        <Count label="정상" n={s.ok || 0} color={s.ok ? 'var(--green)' : undefined} />
      </div>
      <p style={{ marginTop: 0 }}>{summaryText(s)}</p>

      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
        조치가 필요한 항목만 보기
      </label>

      {groups.map((g) => (
        <section key={g.group} style={{ marginBottom: 18 }}>
          <h4 style={{ margin: '0 0 6px' }}>{g.group}</h4>
          {g.items.map((c) => (
            <div key={c.id} className="card" style={{ padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge label={statusLabel(c.status)} color={statusColor(c.status)} />
                <b>{c.title}</b>
                {(c.rows?.length > 0) && (
                  <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                    {open[c.id] ? '상세 접기' : `상세 보기(${c.rows.length})`}
                  </button>
                )}
              </div>
              <div style={{ marginTop: 4, whiteSpace: 'normal' }}>{c.detail}</div>
              {c.howto && (
                <div className="muted" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                  조치: {c.howto}
                </div>
              )}
              {c.evidence && <div className="muted" style={{ marginTop: 2, fontSize: 11.5 }}>근거: <code style={{ overflowWrap: 'anywhere' }}>{c.evidence}</code></div>}
              {open[c.id] && <Rows check={c} />}
            </div>
          ))}
        </section>
      ))}

      <p className="muted" style={{ fontSize: 11.5 }}>
        이 화면은 설정 값·파일 권한·환경변수만 확인합니다 — 코드 취약점 점검이나 침투테스트가 아닙니다.
        과거 점검 보고서는 특수 기능 › 프로그램 보안·완성도 점검에 시점 기록으로 남아 있습니다.
      </p>
    </div>
  );
}
