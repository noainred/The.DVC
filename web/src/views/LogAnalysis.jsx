import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import STable from '../components/STable.jsx';
import BoldText from '../components/boldText.jsx';
import { SEVERITY, SOURCES, coverageText, kpis, entityText, filterFindings, PASTE_HINT, ruleListNote, ruleOriginText } from './logAnalysisText.js';

/**
 * 설정 › Log › 로그 분석(개선점 도출) — v2.583.
 *
 * 사용자 요청: "지금 분석하고 있는 로그를 분석해서 개선점 도출할 수 있는 메뉴와 기능을 설정에 만들어줘".
 * 그 로그는 폐쇄망 중앙 서버의 서비스 저널이었고 **반출이 안 돼 화면 덤프만** 가능했다 — 그래서
 * 포탈이 스스로 읽고(누적·저널·엣지) 붙여넣은 것도 분석한다. 판정·문구는 logAnalysisText.js 하나.
 *
 * 규약: 폴링하지 않는다(마운트 1회 + 버튼 — 저널 읽기는 무겁다). 표는 STable + minWidth(400px 에서
 * 열이 짜부라지지 않게). 조치 문구는 BoldText 로 그린다(**강조** 가 별표로 새지 않게).
 */
const HOURS = { live: [1, 6, 24, 72, 168], journal: [1, 6, 24, 72] };
const SEV_ORDER = ['info', 'low', 'medium', 'high'];

function Badge({ sev }) {
  const s = SEVERITY[sev] || { label: sev, color: 'gray' };
  return <span className={`badge ${s.color}`}>{s.label}</span>;
}

function Card({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 140, flex: '1 1 140px' }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || 'inherit' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}

function Finding({ f }) {
  return (
    <div className="card" style={{ padding: 12, marginBottom: 8, borderLeft: `3px solid var(--${SEVERITY[f.severity]?.color === 'red' ? 'red' : SEVERITY[f.severity]?.color === 'amber' ? 'amber' : 'border'})` }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 4 }}>
        <Badge sev={f.severity} />
        <b style={{ overflowWrap: 'anywhere' }}>{f.title}</b>
        <span className="muted" style={{ fontSize: 12 }}>{f.count.toLocaleString()}건{f.lastRaw ? ` · 마지막 ${f.lastRaw}` : ''}</span>
        {f.link && (
          <button className="tab" style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 12 }}
            onClick={() => { window.location.hash = f.link; }}>{f.linkLabel || '바로가기'} ›</button>
        )}
      </div>
      {f.entities?.length > 0 && (
        <div className="flex gap wrap" style={{ margin: '4px 0', gap: 4, alignItems: 'center' }}>
          {f.entityLabel && <span className="muted" style={{ fontSize: 11.5 }}>{f.entityLabel}</span>}
          {f.entities.map((e) => (
            <span key={e.name} className="badge gray" style={{ fontWeight: 400, whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left' }}>
              {e.guessed ? '추정 · ' : ''}{entityText(e)}
            </span>
          ))}
          {f.entityTotal > f.entities.length && <span className="muted" style={{ fontSize: 11.5 }}>외 {(f.entityTotal - f.entities.length).toLocaleString()}개</span>}
        </div>
      )}
      <div style={{ fontSize: 12.5, lineHeight: 1.6 }}><BoldText text={f.meaning} /></div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 2 }}><b>조치</b> · <BoldText text={f.action} /></div>
      {f.samples?.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>원문 표본 {f.samples.length}줄</summary>
          <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0' }}>{f.samples.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

export default function LogAnalysis() {
  const [source, setSource] = useState('live');
  const [hours, setHours] = useState(24);
  const [agent, setAgent] = useState('');
  const [text, setText] = useState('');
  const [meta, setMeta] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [minSev, setMinSev] = useState('info');
  const [tab, setTab] = useState('findings');

  const run = async (src = source) => {
    setBusy(true); setError('');
    try {
      let r;
      if (src === 'journal') r = await postJson('/admin/log-analysis/journal', { hours });
      else if (src === 'paste') {
        if (!text.trim()) { setBusy(false); setReport(null); return; }
        r = await postJson('/admin/log-analysis/paste', { text });
      } else if (src === 'edge') {
        if (!agent) { setBusy(false); setReport(null); return; }
        r = await fetchJson('/admin/log-analysis', { source: 'edge', agent }, undefined, { retries: 0, timeoutMs: 60_000 });
      } else r = await fetchJson('/admin/log-analysis', { source: src, hours }, undefined, { retries: 0, timeoutMs: 60_000 });
      if (r && r.ok === false) { setReport(null); setError(r.detail || r.reason || '분석 실패'); }
      else setReport(r?.report || null);
    } catch (e) { setError(e.message || String(e)); setReport(null); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    fetchJson('/admin/log-analysis/meta').then(setMeta).catch((e) => setError(e.message || String(e)));
    run('live');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (k) => {
    setSource(k); setReport(null); setError('');
    if (k === 'live' || k === 'buffer') run(k);
    if (k === 'journal' && hours > 72) setHours(24);
  };

  const k = kpis(report);
  const cov = report ? coverageText(report.coverage) : null;
  const findings = filterFindings(report?.findings, minSev);
  const srcInfo = SOURCES.find((s) => s.k === source);
  const toneColor = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)' };

  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.6 }}>
        로그에서 <b>반복되는 실패·설정 문제·데이터 손실 위험</b>을 찾아 뜻과 조치를 보여줍니다. 규칙에 없는 경고·오류와
        로그를 뒤덮는 반복 문장도 따로 모읍니다. 표본 문장의 비밀처럼 보이는 값(토큰·비밀번호)은 가리지만
        <b> 자유 문장이라 완전히 가릴 수는 없습니다</b> — 화면을 외부에 공유할 때 확인하세요.
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        {SOURCES.map((s) => (
          <button key={s.k} className={source === s.k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }}
            onClick={() => pick(s.k)} disabled={busy}>{s.label}</button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{srcInfo?.help}</div>

      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        {HOURS[source] && (
          <select className="input" style={{ width: 'auto' }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {HOURS[source].map((h) => <option key={h} value={h}>최근 {h >= 24 ? `${h / 24}일` : `${h}시간`}</option>)}
          </select>
        )}
        {source === 'edge' && (
          <select className="input" style={{ width: 'auto', maxWidth: '100%' }} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">엣지 선택</option>
            {(meta?.edges || []).map((e) => <option key={e.agent} value={e.agent}>{e.agent} ({(e.logCount ?? 0).toLocaleString()}줄)</option>)}
          </select>
        )}
        {source !== 'paste' && (
          <button className="tab" style={{ padding: '6px 12px' }} disabled={busy || (source === 'edge' && !agent)} onClick={() => run()}>
            {busy ? '분석 중…' : source === 'journal' ? '저널 읽고 분석' : '분석'}
          </button>
        )}
        {source === 'journal' && meta?.journal?.unit && <span className="muted" style={{ fontSize: 11.5 }}>유닛 {meta.journal.unit}</span>}
        {source === 'edge' && !(meta?.edges || []).length && (
          <span className="muted" style={{ fontSize: 12 }}>로그 보관분이 있는 엣지가 없습니다 — 특수기능 › 엣지 로그에서 먼저 가져오세요.</span>
        )}
      </div>

      {source === 'paste' && (
        <div className="card" style={{ padding: 12, marginBottom: 10 }}>
          <textarea className="input" style={{ width: '100%', minHeight: 160, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}
            placeholder="journalctl 또는 tail 출력을 붙여넣으세요(최대 8MB)" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap wrap" style={{ marginTop: 6, alignItems: 'center' }}>
            <button className="tab" style={{ padding: '6px 12px' }} disabled={busy || !text.trim()} onClick={() => run('paste')}>{busy ? '분석 중…' : '붙여넣은 로그 분석'}</button>
            <span className="muted" style={{ fontSize: 11.5 }}>{(new Blob([text]).size / 1048576).toFixed(2)} MB</span>
          </div>
          <details style={{ marginTop: 6 }}>
            <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>다른 서버에서 줄여서 가져오는 명령(8MB 이내)</summary>
            <pre style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', userSelect: 'all' }}>{PASTE_HINT.join('\n')}</pre>
          </details>
        </div>
      )}

      {error && <ErrorBox message={error} />}
      {busy && !report && <Loading label={source === 'journal' ? '서비스 저널을 읽는 중' : '로그를 분석하는 중'} />}

      {report && (<>
        <div style={{ fontSize: 12.5, marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', color: toneColor[cov.tone], overflowWrap: 'anywhere' }}>
          {cov.text}{cov.hint && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{cov.hint}</div>}
        </div>
        <div className="flex gap wrap" style={{ marginBottom: 12 }}>
          <Card label="분석한 줄" value={k.lines == null ? '—' : k.lines.toLocaleString()} sub={report.http?.total ? `요청 로그 ${report.http.total.toLocaleString()}줄 포함` : ''} />
          <Card label="개선점 · 심각/높음" value={k.urgent} color={k.urgent ? 'var(--red)' : undefined} />
          <Card label="개선점 · 보통" value={k.medium} color={k.medium ? 'var(--amber)' : undefined} />
          <Card label="개선점 · 낮음/정보" value={k.minor} />
          <Card label="경고 · 오류 줄" value={k.hasLevels ? `${k.warn.toLocaleString()} · ${k.error.toLocaleString()}` : '—'}
            sub={k.hasLevels ? '' : '이 원천에는 로그 수준이 없습니다(문구로 추정한 것은 미분류에 표시)'} />
          <Card label="서버 오류 응답(5xx)" value={k.http5xx == null ? '—' : k.http5xx.toLocaleString()} color={k.http5xx ? 'var(--red)' : undefined} />
        </div>

        <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
          {[['findings', `개선점 (${(report.findings || []).length})`], ['tags', `태그별 (${report.tagsTotal ?? 0})`], ['templates', `반복 문장 (${report.templatesTotal ?? 0})`], ['rules', `규칙 목록 (${(meta?.rules || []).length})`]].map(([key, l]) => (
            <button key={key} className={tab === key ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setTab(key)}>{l}</button>
          ))}
          {tab === 'findings' && (
            <select className="input" style={{ width: 'auto', marginLeft: 'auto' }} value={minSev} onChange={(e) => setMinSev(e.target.value)}>
              {SEV_ORDER.map((s) => <option key={s} value={s}>{SEVERITY[s].label} 이상</option>)}
            </select>
          )}
        </div>

        {tab === 'findings' && (
          findings.length ? findings.map((f) => <Finding key={`${f.kind}:${f.id}`} f={f} />)
            : <div className="muted" style={{ fontSize: 12.5 }}>{(report.findings || []).length ? '이 심각도 이상의 개선점이 없습니다.' : `이 구간(${(report.coverage?.lines ?? 0).toLocaleString()}줄)에서 규칙에 맞거나 문제로 보이는 문장이 없습니다. 구간 밖은 알 수 없습니다.`}</div>
        )}

        {tab === 'tags' && (
          <STable className="table" minWidth={520}>
            <thead><tr><th>태그</th><th>줄 수</th><th>비율</th><th>경고</th><th>오류</th></tr></thead>
            <tbody>{(report.tags || []).map((t) => (
              <tr key={t.tag}>
                <td style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{t.tag}</td>
                <td data-sort={t.n}>{t.n.toLocaleString()}</td>
                <td data-sort={t.sharePct ?? -1}>{t.sharePct == null ? '—' : `${t.sharePct}%`}</td>
                <td data-sort={t.warn}>{k.hasLevels ? t.warn.toLocaleString() : '—'}</td>
                <td data-sort={t.error}>{k.hasLevels ? t.error.toLocaleString() : '—'}</td>
              </tr>
            ))}</tbody>
          </STable>
        )}

        {tab === 'templates' && (<>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>값(이름·IP·숫자)을 가려 같은 문장끼리 묶었습니다. 상위 40개입니다{report.overflow?.tmpl ? ` · 묶음 상한으로 ${report.overflow.tmpl.toLocaleString()}줄은 세지 못했습니다` : ''}.</div>
          <STable className="table" minWidth={720}>
            <thead><tr><th>줄 수</th><th>비율</th><th>태그</th><th>규칙</th><th>표본 문장</th></tr></thead>
            <tbody>{(report.templates || []).map((t, i) => (
              <tr key={`${t.tag}-${i}`}>
                <td data-sort={t.count}>{t.count.toLocaleString()}</td>
                <td data-sort={t.sharePct ?? -1}>{t.sharePct == null ? '—' : `${t.sharePct}%`}</td>
                <td className="muted">{t.tag || '—'}</td>
                <td className="muted">{t.rule || '—'}</td>
                <td style={{ overflowWrap: 'anywhere', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5 }}>{t.sample}</td>
              </tr>
            ))}</tbody>
          </STable>
        </>)}

        {tab === 'rules' && (<>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{ruleListNote(meta?.rules)}</div>
          <STable className="table" minWidth={900}>
            <thead><tr><th>심각도</th><th>분류</th><th>태그</th><th>제목</th><th>출처</th><th>조치</th></tr></thead>
            <tbody>{(meta?.rules || []).map((r) => (
              <tr key={r.id}>
                <td data-sort={{ critical: 5, high: 4, medium: 3, low: 2, info: 1 }[r.severity] || 0}><Badge sev={r.severity} /></td>
                <td className="muted">{r.categoryLabel}</td>
                <td style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{r.tag || '—'}</td>
                <td style={{ overflowWrap: 'anywhere' }} title={r.pattern}>{r.title}</td>
                <td className="muted" style={{ fontSize: 11.5 }} title={r.src}>{ruleOriginText(r)}</td>
                <td style={{ overflowWrap: 'anywhere', fontSize: 12 }}><BoldText text={r.action} /></td>
              </tr>
            ))}</tbody>
          </STable>
        </>)}
      </>)}
    </div>
  );
}
