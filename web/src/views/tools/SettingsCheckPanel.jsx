/**
 * 설정 전수 점검 — **설정에 등록된 모든 통신 대상**을 재고 해결책을 제시한다(v2.553).
 *
 * 사용자 요청(2026-09-18): "설정에 있는 모든 통신이 되는지 점검하고 해결책 제시하는 기능".
 * 선택: **전부 25종** · 해결책 **고정 조치문 + 맞춤 진단 둘 다** · **도달성만(인증은 수동 1회)**.
 *
 * 화면 설계 의도:
 *  1. 맨 위 배너가 **'무엇을 보지 않았는지'** 를 먼저 말한다(로그인하지 않는다 — 계정 잠금 방지).
 *  2. 그룹(중앙↔엣지·가상화·서버·스토리지…)별 표. 행을 누르면 **해결책 카드**가 펼쳐진다.
 *  3. '확인 깊이' 열이 **'정상' 의 뜻**을 종류마다 밝힌다(포트 열림까지 ≠ 제품 확인까지).
 *  4. 판정·문구는 `settingsCheckText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 점검은 폴러가 주기로 돌고, 화면은 마운트 1회 + 버튼이다(v2.508 V4 규약).
 * ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다(열 8개 — 감싸지 않으면 400px 에서 페이지를 밀어낸다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  SEVERITY_LABEL, severityTone, remedyText, targetState, STATE_LABEL, stateTone,
  kpisOf, depthNote, depthReached, headerNote, groupRows, settingsLinkOf, tableFootnotes,
} from './settingsCheckText.js';

function Badge({ text, tone }) {
  return <span style={{ color: tone, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;
}

/** 해결책 카드 — 심각도 순(서버가 정렬해 준다). 조치가 없으면 그 줄을 만들지 않는다. */
function RemedyCard({ row, hostForm, paths }) {
  const link = settingsLinkOf(row, paths);
  const list = row.findings || [];
  return (
    <div style={{ padding: '8px 10px', display: 'grid', gap: 8, background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        등록값 <b style={{ color: 'inherit' }}>{row.address || '—'}</b>
        {row.host ? ` → 접속 ${row.host}:${row.port}` : ''}
        {row.agent ? ` · 담당 엣지 ${row.agent}` : ' · 중앙 직접'}
        {link ? (
          <>
            {' · '}
            <a href={link.hash} style={{ color: 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{link.label}</a>
          </>
        ) : null}
      </div>
      {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>고칠 것으로 찾은 항목이 없습니다.</div>}
      {list.map((f, i) => {
        const r = remedyText(f, { hostForm: hostForm?.[row.kind] });
        return (
          <div key={`${f.code}-${i}`} style={{ display: 'grid', gap: 2, borderLeft: `3px solid ${severityTone(f.severity)}`, paddingLeft: 8 }}>
            <div style={{ fontSize: 12 }}>
              <Badge text={SEVERITY_LABEL[f.severity] || f.severity} tone={severityTone(f.severity)} />
              {' '}<b>{r.title}</b>
            </div>
            {r.detail ? <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'normal' }}><BoldText text={r.detail} /></div> : null}
            {/* ⚠ 조치는 **있을 때만** 줄을 만든다 — 빈 '조치:' 는 정보가 아니다. */}
            {r.action ? <div style={{ fontSize: 11, whiteSpace: 'normal' }}>→ <BoldText text={r.action} /></div> : null}
          </div>
        );
      })}
      {row.latest ? (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          마지막 점검 {new Date(row.latest.ts).toLocaleString('ko-KR')} · {row.latest.summary || ''}
          {row.latest.streak > 1 ? ` · 같은 상태 ${row.latest.streak}회` : ''}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsCheckPanel() {
  // ⚠ 훅은 전부 조기 return 위에(조기 반환 뒤 훅 추가는 React #310 크래시 — v2.202 실제 사고).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);
  const [open, setOpen] = useState({});

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setData(await fetchJson('/tools/link-check/targets')); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const opt = useMemo(() => ({ enabled: !!data?.enabled, settingsCheck: data?.settingsCheck !== false }), [data]);
  const rows = useMemo(() => {
    const list = data?.targets || [];
    const needle = q.trim().toLowerCase();
    return list.filter((r) => {
      if (onlyBad) {
        const st = targetState(r, opt).state;
        if (st !== 'fail' && st !== 'config') return false;
      }
      if (!needle) return true;
      return [r.name, r.address, r.host, r.label, r.group, r.agent].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [data, q, onlyBad, opt]);

  const kpi = useMemo(() => kpisOf(data?.targets || [], opt), [data, opt]);
  const banners = useMemo(() => headerNote(data || {}), [data]);
  const groups = useMemo(() => groupRows(rows, data?.groupOrder || []), [rows, data]);
  const foots = useMemo(() => tableFootnotes(rows, opt), [rows, opt]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await postJson('/tools/link-check/run', {});
      setNote(r?.ok === false ? `점검 실패: ${r.error || r.skipped || '사유 미상'}` : `점검 ${r.checked ?? 0}건(실패 ${r.failed ?? 0}) — 아래 표를 갱신했습니다.`);
      await load();
    } catch (e) { setNote(`점검 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const depthLabel = data?.depthLabel || {};
  const kinds = data?.kinds || {};

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      {/* 긴 설명은 배너가 한 번만(v2.509) */}
      {banners.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--warn, #e8b23a)' }}>
          {banners.map((b, i) => <div key={i} style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={b} /></div>)}
        </div>
      )}

      <div className="kpis">
        <Kpi label="설정 대상" value={kpi.total} />
        <Kpi label="정상" value={kpi.ok} />
        <Kpi label="실패" value={kpi.fail} />
        {/* ⚠ '설정 문제' 와 '측정 없음' 을 정상·실패에 흡수하지 않는다 */}
        <Kpi label="설정 문제" value={kpi.config} />
        <Kpi label="측정 없음" value={kpi.nodata} />
        {/* ⚠ **비활성 칸을 빼면 화면에서 합이 안 맞는다**(v2.553 판독: 82 대상인데 74+5+1+0=80).
            다섯 칸은 겹치지 않으므로 합계 = 정상 + 실패 + 설정문제 + 측정없음 + 비활성 이다. */}
        <Kpi label="비활성" value={kpi.disabled} />
        <Kpi label="정상률(측정분)" value={kpi.okPct == null ? '—' : `${kpi.okPct}%`} />
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={runNow} disabled={busy || !data?.enabled} title={!data?.enabled ? '통신 점검이 꺼져 있습니다 — 링크 탭의 설정에서 켜세요.' : ''}>
          {busy ? '점검 중…' : '지금 점검'}
        </button>
        <button className="btn" onClick={load} disabled={busy}>새로고침</button>
        <SearchBox value={q} onChange={setQ} placeholder="이름·주소·종류 검색" />
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 문제만
        </label>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          차단 {kpi.blockers}건 · 주의 {kpi.warns}건 {rows.length !== (data?.targets || []).length ? `· ${rows.length}/${(data?.targets || []).length} 표시` : ''}
        </span>
      </div>

      {note && <div className="card" style={{ fontSize: 12 }}><BoldText text={note} /></div>}

      {(data?.sourceErrors || []).length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--bad, #ef5a5a)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>등록부를 읽지 못했습니다 — 그 종류가 목록에서 빠졌습니다</div>
          {data.sourceErrors.map((e, i) => (
            <div key={i} style={{ fontSize: 11, whiteSpace: 'normal' }}>{e.source}: {e.reason}</div>
          ))}
        </div>
      )}

      {(data?.problems || []).length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>주소를 해석할 수 없는 등록 {data.problems.length}건</div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table">
              <thead><tr><th>종류</th><th>이름</th><th>등록값</th><th>사유</th></tr></thead>
              <tbody>
                {data.problems.map((p, i) => (
                  <tr key={i}>
                    <td>{kinds[p.kind]?.label || p.kind}</td><td>{p.name || p.ref}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.address}>{p.address || '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </div>
      )}

      {groups.map(({ group, rows: grows }) => (
        <div className="card" key={group}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{group} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>{grows.length}건</span></div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table">
              <thead>
                <tr>
                  <th>종류</th><th>이름</th><th>주소</th><th>상태</th><th>확인 깊이</th>
                  <th>응답</th><th>인증서</th><th>해결책</th>
                </tr>
              </thead>
              <tbody>
                {grows.map((r) => {
                  const st = targetState(r, opt);
                  const L = r.latest || null;
                  const blockers = (r.findings || []).filter((x) => x.severity === 'blocker').length;
                  const warns = (r.findings || []).filter((x) => x.severity === 'warn').length;
                  const isOpen = !!open[r.id];
                  return (
                    <React.Fragment key={r.id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.label}</td>
                        <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</td>
                        <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.address}>{r.address || '—'}</td>
                        <td data-sort={st.state}><Badge text={STATE_LABEL[st.state] || st.state} tone={stateTone(st.state)} /></td>
                        {/* ⚠ **선언 깊이가 아니라 실제 도달 깊이**를 적는다 — 403 을 받으면
                            제품 확인까지 가지 않는데 '제품 확인까지' 라 쓰면 거짓이다(v2.553). */}
                        {(() => {
                          const dr = depthReached(r);
                          return (
                            <td style={{ whiteSpace: 'nowrap', fontSize: 11 }} title={depthNote(dr.depth, depthLabel, dr)}>
                              {dr.depth == null
                                ? <span style={{ color: 'var(--muted)' }}>—</span>
                                /* ⚠ 측정 전에는 **이 종류가 볼 수 있는 깊이**일 뿐이다 — 확인했다는
                                   뜻으로 읽히지 않게 흐린 색 + 물음표로 둔다(v2.553 판독). */
                                : dr.measured
                                  ? <>{depthLabel[dr.depth] || dr.depth}{dr.shallower ? <span style={{ color: 'var(--warn, #e8b23a)' }}> ▾</span> : null}</>
                                  : <span style={{ color: 'var(--muted)' }}>{depthLabel[dr.depth] || dr.depth} (예정)</span>}
                            </td>
                          );
                        })()}
                        <td className="right" data-sort={L?.totalMs ?? ''}>{L?.totalMs == null ? '—' : `${L.totalMs}ms`}</td>
                        <td data-sort={L?.certDaysLeft ?? ''} style={{ whiteSpace: 'nowrap' }}>
                          {L?.certDaysLeft == null ? '—' : `${L.certDaysLeft}일`}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }} data-sort={blockers * 100 + warns}>
                          {blockers ? <Badge text={`차단 ${blockers}`} tone={severityTone('blocker')} /> : null}
                          {blockers && warns ? ' ' : ''}
                          {warns ? <Badge text={`주의 ${warns}`} tone={severityTone('warn')} /> : null}
                          {!blockers && !warns ? <span style={{ color: 'var(--muted)' }}>—</span> : null}
                          <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{isOpen ? '▾' : '▸'}</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr><td colSpan={8} style={{ padding: 0 }}>
                          <RemedyCard row={r} hostForm={data?.hostForm} paths={data?.settingsPaths} />
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <div className="card" style={{ fontSize: 12, color: 'var(--muted)' }}>
          <BoldText text={q || onlyBad ? '검색·필터에 맞는 대상이 없습니다.' : '설정에 등록된 통신 대상이 없습니다 — vCenter·수집 서버·장비를 먼저 등록하세요.'} />
        </div>
      )}

      {foots.length > 0 && (
        <div className="card" style={{ fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 3 }}>
          {foots.map((f, i) => <div key={i}><BoldText text={f} /></div>)}
        </div>
      )}
    </div>
  );
}

export default SettingsCheckPanel;
