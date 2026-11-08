/**
 * 서버 상세 ‘로그’ 탭(리눅스 성능 7a단계 · 아트보드 Logs.dc.html · 설계 PROFILES §17).
 *   KPI 4(분류별 패턴/줄) + 읽은 양(상한 · 잘림 · 권한 없음) → 시간대별 누적 막대 → 보안 패널 → 패턴 표(STable) → 규칙 카탈로그 + 수집 방식.
 * ⚠ 판정은 서버 — 그리기만(bmLogsText.js). 조회는 탭을 열 때 1회 + ‘다시 읽기’ + 기간 바꿀 때(폴링 없음) · 늦게 온 이전 응답은 버린다(createDetailLoader 세대).
 * ⚠ 못 읽은 시간 칸은 막대 없이 점선(0 이 아니다) · 값이 없으면 ‘—’.
 */
import React, { useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { canCsv } from '../../api.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { perfPath } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 요청에 법인을 싣는다
import {
  CLASS_ORDER, CLASS_TEXT, SEV_TEXT, SRC_LABEL, RANGE_OPTIONS, kpiCards, sourceChips, permGuide, readCard, hourlyBars, secPanelRows, SEC_HONEST, SEC_HIDDEN_TEXT,
  corrChips, corrHeadText, patternCsv, methodLines, stamp, numText, LOG_GRADE_TEXT,
} from './bmLogsText.js';
import './bmOps.css';
import './bmLogs.css';

/** 규칙 등급 — 로그 규칙 뜻(LOG_GRADE_TEXT)으로(튜닝 근거 등급 문구를 빌리지 않는다). */
function LogGrade({ grade }) {
  if (!grade) return null;
  return <span className="bmo-grade" title={LOG_GRADE_TEXT[grade] || ''}><span className="bmo-g">{grade}</span>{LOG_GRADE_TEXT[grade] || ''}</span>;
}

function HourlyChart({ hourly = [], onPick }) {
  const H = 120; const W = Math.max(1, hourly.length);
  const { max, bars } = useMemo(() => hourlyBars(hourly, { height: H }), [hourly]);
  const step = 100 / W;
  return (
    <div className="bml-chart" role="img" aria-label={`시간대별 발생 — 최대 ${max}`}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="bml-svg">
        {bars.map((b, i) => (
          <g key={b.t} onClick={() => onPick?.(b)} style={{ cursor: onPick ? 'pointer' : 'default' }}>
            <title>{`${stamp(b.t)} — ${b.unread ? '읽은 기록 없음' : `${b.total}건`}`}</title>
            {b.unread ? <rect x={i * step + step * 0.15} y={H - 6} width={step * 0.7} height={6} fill="none" stroke="var(--text-faint)" strokeDasharray="1 1" vectorEffect="non-scaling-stroke" />
              : b.segs.map((s) => <rect key={s.cls} x={i * step + step * 0.15} y={s.y} width={step * 0.7} height={s.h} fill={s.color} opacity="0.85" />)}
          </g>
        ))}
      </svg>
      <div className="bml-axis">
        <span>{stamp(hourly[0]?.t)}</span><span>최대 {numText(max)}건/시간</span><span>{stamp(hourly.at(-1)?.t)}</span>
      </div>
      <div className="bml-legend">
        {CLASS_ORDER.map((c) => <span key={c}><i style={{ background: CLASS_TEXT[c].color }} />{CLASS_TEXT[c].label}</span>)}
        <span><i className="bml-unread" />읽은 기록 없음(막대 없음 — 0 아님)</span>
      </div>
    </div>
  );
}

function SecPanel({ sec = {}, hidden = false, authSrc = null }) {
  const rows = secPanelRows(sec);
  return (
    <section className="bmo-card">
      <h5 className="bmo-h">보안 — 누가 · 어디서 · 몇 번</h5>
      <div className="bmo-reads">/var/log/secure · journald 보안(sshd · sudo) · auditd 중 한 출처의 보안 분류 줄{authSrc ? ` — 이번 기간 ${SRC_LABEL[authSrc] || authSrc}` : ''} · auditd {sec.auditd ? `‘${sec.auditd}’` : '—'} · secure {sec.secureStatus ? `‘${sec.secureStatus}’` : '—'}</div>
      {hidden && <p className="bmo-note"><BoldText text={SEC_HIDDEN_TEXT} /></p>}
      <STable minWidth={560} className="bmo-t" style={{ fontSize: 12 }}>
        <thead><tr><th>항목</th><th className="right">기간 합</th><th>상위(최대 5)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind}>
              <td data-sort={r.label} className="bmo-name">{r.label}</td>
              <td className="right" data-sort={r.total ?? ''} title={r.why || undefined}>{numText(r.total)}</td>
              <td className="bmo-wrap" data-sort={r.tops[0]?.items?.[0]?.count ?? ''}>
                {r.why && <div className="bmo-sub bml-why">{r.why}</div>}
                {r.tops.every((x) => !x.items.length) ? (r.why ? null : <span style={{ color: 'var(--muted)' }}>—</span>)
                  : r.tops.map((x) => <div key={x.k}><span className="bmo-sub">{x.lbl}</span> {x.items.map((it) => `${it.item} ×${numText(it.count)}`).join(' · ')}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </STable>
      {!!(sec.bursts || []).length && (
        <p className="bmo-note" style={{ color: toneVar('bad') }}>마지막 주기 SSH 실패 집중: {sec.bursts.map((b) => `${b.ip} ${numText(b.count)}줄(${stamp(b.from, { date: false })}~${stamp(b.to, { date: false })})`).join(' · ')}</p>
      )}
      <p className="bmo-note">{SEC_HONEST}</p>
    </section>
  );
}

export function LogsView({ resp, range, onRange, onTab, onReload, loading = false }) {
  const [cls, setCls] = useState('');
  const [open, setOpen] = useState('');
  const pats = useMemo(() => (resp?.patterns || []).filter((p) => !cls || p.cls === cls), [resp, cls]);
  const rc = readCard(resp?.read);
  const chips = sourceChips(resp?.read?.sources);
  const guide = permGuide(resp?.read?.sources);
  const exportCsv = () => {
    try {
      const blob = new Blob([`﻿${patternCsv(resp)}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `bm-logs-${resp?.key || 'server'}-${range}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch { /* 내보내기 실패는 화면을 바꾸지 않는다 */ }
  };
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-bar">
        <div className="bmp-seg" role="tablist" aria-label="기간">
          {RANGE_OPTIONS.map(([id, label]) => <button key={id} role="tab" aria-selected={range === id} className={range === id ? 'active' : ''} onClick={() => onRange?.(id)}>{label}</button>)}
        </div>
        <button className="btn btn-sm bmp-touch" onClick={onReload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
        {canCsv() && <button className="btn btn-sm bmp-touch" onClick={exportCsv} disabled={!resp?.patterns?.length}>CSV</button>}
        {resp?.via === 'edge' && <span className="bmo-sub">엣지 {resp.agent} 대행(원문은 법인 밖으로 나가지 않음)</span>}
      </div>
      <div className="bml-kpis">
        {kpiCards(resp).map((c) => (
          <div key={c.key} className="bmo-kpi">
            <div className="bmo-k"><i className="bml-dot" style={{ background: c.color }} />{c.label}</div>
            <div className="bmo-kv">{c.value}</div>
            <div className="bmo-sub">{c.sub}</div>
            {c.cover && <div className="bmo-sub" style={{ color: toneVar(c.partial ? 'idle' : 'warn') }}>{c.cover}</div>}
            <div className="bmo-sub" style={{ color: 'var(--text-faint)' }}>{c.desc}</div>
          </div>
        ))}
        <div className="bmo-kpi">
          <div className="bmo-k">읽은 양(줄)</div>
          <div className="bmo-kv">{rc.value}</div>
          <div className="bmo-sub">{rc.sub}</div>
          {rc.cut && <div className="bmo-sub" style={{ color: toneVar('warn') }}>{rc.cut}</div>}
          {rc.reset && <div className="bmo-sub" style={{ color: toneVar('warn') }}>{rc.reset}</div>}
        </div>
      </div>
      {!!chips.length && (
        <div className="bml-chips">
          {chips.map((c) => <span key={c.src} className="bmp-chip" title={c.title} style={{ color: toneVar(c.tone) }}>{c.label} {c.text}{c.extra ? ` · ${c.extra}` : ''}</span>)}
        </div>
      )}
      {!!guide.length && (
        <section className="bmo-card">
          <h5 className="bmo-h">필요한 권한 — 못 읽은 출처</h5>
          {guide.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
        </section>
      )}
      <section className="bmo-card">
        <h5 className="bmo-h">시간대별 발생 — 분류 4(시간당 줄 수)</h5>
        <div className="bmo-reads">추이 · 집중 탭과 같은 시간축(정시 칸) · 막대 클릭 = 그 시간이 마지막인 패턴만</div>
        <HourlyChart hourly={resp?.hourly || []} onPick={(b) => setOpen(b.unread ? '' : `h:${b.t}`)} />
      </section>
      <SecPanel sec={resp?.security || {}} hidden={!!resp?.secHidden} authSrc={resp?.read?.authSrc || null} />
      <section className="bmo-card">
        <h5 className="bmo-h">패턴(서명)별 — 같은 메시지는 한 행 · {corrHeadText(resp?.corrWindowMs)}</h5>
        <div className="bmo-bar">
          <div className="bmp-seg" role="tablist" aria-label="분류">
            <button role="tab" aria-selected={!cls} className={!cls ? 'active' : ''} onClick={() => setCls('')}>분류 전체</button>
            {CLASS_ORDER.map((c) => <button key={c} role="tab" aria-selected={cls === c} className={cls === c ? 'active' : ''} onClick={() => setCls(c)}>{CLASS_TEXT[c].label}</button>)}
          </div>
          {open.startsWith('h:') && <button className="btn btn-sm" onClick={() => setOpen('')}>{stamp(Number(open.slice(2)))} 시간 거르기 해제</button>}
        </div>
        <STable minWidth={960} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>분류 · 심각</th><th className="right">횟수</th><th>첫 / 마지막</th><th>출처 · 유닛</th><th>서명(정규화)</th><th>표본(가림)</th><th>규칙 · 근거</th><th>연계</th></tr></thead>
          <tbody>
            {pats.filter((p) => !open.startsWith('h:') || (p.last && Math.floor(p.last / 3_600_000) * 3_600_000 === Number(open.slice(2)))).map((p) => {
              const sv = SEV_TEXT[p.severity] || SEV_TEXT.info;
              return (
                <tr key={p.sig}>
                  <td data-sort={`${p.cls}|${9 - sv.rank}`}><span style={{ color: CLASS_TEXT[p.cls]?.color }}>{CLASS_TEXT[p.cls]?.label || p.cls}</span><div style={{ color: toneVar(sv.tone) }}>{sv.label}</div></td>
                  <td className="right" data-sort={p.count ?? ''}>{numText(p.count)}{p.total != null && p.total !== p.count && <div className="bmo-sub">누적 {numText(p.total)}</div>}</td>
                  <td data-sort={p.last ?? ''}>{stamp(p.first)}<div className="bmo-sub">{stamp(p.last)}</div></td>
                  <td data-sort={p.src}>{SRC_LABEL[p.src] || p.src || '—'}<div className="bmo-sub">{p.unit || '—'}</div></td>
                  <td className="bmo-wrap bmo-mono" data-sort={p.tmpl} style={{ minWidth: 160 }}>{p.tmpl || '—'}</td>
                  <td className="bmo-wrap" data-nosort style={{ minWidth: 160 }}>
                    {p.samplesHidden ? <span className="bmo-sub">보안 분류 표본은 관리자 판본에만</span>
                      : (p.samples || []).length ? (
                        <details open={open === p.sig} onToggle={(e) => setOpen(e.currentTarget.open ? p.sig : '')}>
                          <summary className="bmo-mono">{p.samples.at(-1).text.slice(0, 70)}{p.samples.at(-1).text.length > 70 ? '…' : ''}</summary>
                          <pre className="bmo-pre">{p.samples.map((x) => `[${stamp(x.ts)}] ${x.text}`).join('\n')}</pre>
                        </details>
                      ) : '—'}
                  </td>
                  <td className="bmo-wrap" data-sort={p.ruleId} style={{ minWidth: 140 }}><span className="bmo-mono">{p.ruleId || '—'}</span><div><LogGrade grade={p.grade} /></div><div className="bmo-sub">{p.title}{(p.evidence || []).length ? ` · 근거 ${p.evidence.join(' · ')}` : ''}</div></td>
                  <td className="bmo-wrap" data-nosort style={{ minWidth: 132 }}>
                    {corrChips(p.corr).map((c, i) => (
                      <button key={i} type="button" className="bml-corr" onClick={() => onTab?.(c.tab)} title="그 탭으로">{c.text}</button>
                    ))}
                    {!corrChips(p.corr).length && <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        {!pats.length && <p className="bmo-note">{resp?.read?.never ? '아직 이 서버의 로그를 읽은 주기가 없습니다.' : '이 기간 · 분류에 맞는 패턴이 없습니다(읽은 줄 중 규칙에 맞은 줄 기준 — 분류 안 된 줄은 세기만 합니다).'}</p>}
        {!!resp?.patternsOmitted && <p className="bmo-sub">상위 300 패턴만 실었습니다(나머지 {numText(resp.patternsOmitted)}).</p>}
        <p className="bmo-note">서명 = 메시지의 숫자 · IP · 계정 · PID · 경로 가변부를 치환한 문자열(해시로 저장). 같은 서명은 한 행에 횟수만 올리고 가린 표본 5줄만 둡니다 — 로그를 통째로 저장하지 않습니다. 연계 칩은 그 탭으로 갑니다(시각이 맞는다는 것이지 원인이라는 뜻이 아닙니다).</p>
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">규칙 카탈로그 — 분류는 규칙이 정하고 규칙은 근거를 갖는다</h5>
        <div className="bmo-reads">포탈 자체 로그 분석 엔진(loganalysis: 정규식 · 표본 검증 · id)을 서버 로그에 재사용 · 처음 맞는 규칙 하나 · 규칙 {numText(resp?.rules?.length)}개</div>
        <details>
          <summary className="bmo-sub">규칙 목록 펼치기</summary>
          <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>분류</th><th>규칙 id</th><th>제목</th><th>심각도</th><th>출처</th><th>근거</th><th>등급</th></tr></thead>
            <tbody>
              {(resp?.rules || []).map((r) => (
                <tr key={r.id}>
                  <td data-sort={r.cls}><span style={{ color: CLASS_TEXT[r.cls]?.color }}>{r.clsLabel}</span></td>
                  <td data-sort={r.id} className="bmo-mono bmo-wrap">{r.id}{r.derived && <div className="bmo-sub">파생({(r.derivedFrom || []).join(' · ')})</div>}</td>
                  <td className="bmo-wrap" data-sort={r.title}>{r.title}</td>
                  <td data-sort={SEV_TEXT[r.severity]?.rank ?? 0}>{r.severity}</td>
                  <td data-sort={r.tag}>{r.tag ? SRC_LABEL[r.tag] || r.tag : '전체'}</td>
                  <td className="bmo-wrap" data-sort={(r.evidence || []).map((e) => e.id).join(',')}>{(r.evidence || []).map((e) => <div key={e.id} className="bmo-sub"><b>{e.id}</b> {e.text}</div>)}</td>
                  <td data-sort={r.grade}><LogGrade grade={r.grade} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
        </details>
      </section>
      <section className="bmo-card bmo-honest">
        <h5 className="bmo-h">수집 방식 · 규칙</h5>
        {methodLines(resp?.method).map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      </section>
    </div>
  );
}

export default function BmLogsTab({ itemKey, vc = '', onTab }) {
  const [range, setRange] = useState('24h');
  // 조회기는 한 번 만들어진다(useOpsLoad) — 기간은 열쇠에 실어 넘긴다(클로저에 묶으면 첫 기간으로 고정된다).
  const st = useOpsLoad((k, v) => { const [key, rg] = String(k).split('\u0000'); return perfPath(key, v, '/logs', `range=${encodeURIComponent(rg || '24h')}`); }, `${itemKey}\u0000${range}`, vc);
  return (
    <div style={{ minWidth: 0 }}>
      <OpsError err={st.err} />
      {!st.resp && !st.err && <p className="bmo-note">로그 분석을 불러오는 중…</p>}
      {st.resp && st.resp.ok === false && <p className="bmo-note" style={{ color: toneVar('bad') }}>{st.resp.reason || '로그 분석을 읽지 못했습니다.'}</p>}
      {st.resp && st.resp.ok !== false && <LogsView resp={st.resp} range={range} onRange={setRange} onTab={onTab} onReload={st.reload} loading={st.loading} />}
    </div>
  );
}
