/**
 * 함대 보기(리눅스 성능 4단계) — ‘용도 분석’(아트보드 ⑥: OS × 기능 매트릭스 · 프로파일 카탈로그 · 서버별 점검 결과 · 튜닝 항목별 서버 수)과
 * ‘장애 기록’(아트보드 ⑦ 함대 표 — 법인 · 종류 · 상태 필터). 도구 키는 그대로(`bm-usage` 안의 보기 전환).
 * ⚠ 판정은 서버 — 그리기만. 조회는 보기를 고를 때 1회 + ‘다시 읽기’(폴링 없음).
 */
import React, { useMemo, useState } from 'react';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { useOpsLoad, Grade, OpsError, GradeLegend } from './BmTuningTab.jsx';
import { IncidentTable, FAULT_PERIODS } from './BmFaultsTab.jsx';
import {
  PROFILE_STATUS_TEXT, APP_LABEL, PLANNED_LABEL, ROLE_LABEL, TUNING_STATUS_TEXT, matrixCellText, PROFILE_HONEST, faultKpiCards,
} from './bmOpsText.js';
import './bmOps.css';

const SEGS = [['matrix', '매트릭스'], ['catalog', '카탈로그'], ['servers', '점검 결과'], ['tuning', '튜닝 차이']];

export function PurposeFleetView({ resp, onOpen }) {
  const [seg, setSeg] = useState('matrix');
  const cols = resp?.columns || [];
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmp-seg" role="tablist" aria-label="용도 분석 보기">
        {SEGS.map(([id, label]) => <button key={id} role="tab" aria-selected={seg === id} className={seg === id ? 'active' : ''} onClick={() => setSeg(id)}>{label}</button>)}
      </div>
      {seg === 'matrix' && (
        <section className="bmo-card">
          <h5 className="bmo-h">OS × 기능 매트릭스 — 서버 수 · 점검 결과</h5>
          <div className="bmo-reads">칸 = 그 조합의 서버 수 · 상태 수 · 프로파일이 없는 조합은 ‘프로파일 없음’(점검하지 않음 — 틀린 판정보다 낫다). 한 서버에 기능이 둘이면 두 칸에 셉니다.</div>
          <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>OS</th>{cols.map((c) => <th key={c}>{APP_LABEL[c] || c}</th>)}</tr></thead>
            <tbody>
              {(resp?.rows || []).map((r) => (
                <tr key={r.osKey}>
                  <td data-sort={r.label}><b>{r.label}</b><div className="bmo-sub">{r.osProfile ? `프로파일 ${r.osProfile}` : 'OS 프로파일 없음'}</div></td>
                  {cols.map((c) => {
                    const v = matrixCellText(r.byApp?.[c]);
                    return <td key={c} data-sort={r.byApp?.[c]?.servers ?? 0}><div>{v.main}</div>{v.sub && <div className="bmo-sub">{v.sub}</div>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </STable>
          {!!resp?.noFacts && <p className="bmo-note">튜닝 · 용도 사실을 아직 받지 못한 서버 {resp.noFacts}대는 ‘미확인’ 행에 있습니다(OS 경로 없음 · 수집 전 · 엣지 이전 판).</p>}
          <p className="bmo-note">예정(만들지 않음): {(resp?.planned || []).map((p) => PLANNED_LABEL[p.id] || p.id).join(' · ')} — 그 조합은 ‘프로파일 없음’ 입니다.</p>
        </section>
      )}
      {seg === 'catalog' && (
        <section className="bmo-card">
          <h5 className="bmo-h">프로파일 카탈로그 — 프로파일 1개 = 파일 1개 · 우선순위 기능 &gt; 역할 &gt; OS</h5>
          <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>프로파일</th><th>종류</th><th>매칭(감지) 규칙 — 읽기 전용</th><th className="right">점검</th><th className="right">튜닝</th><th>상태</th><th>근거</th></tr></thead>
            <tbody>
              {(resp?.catalog || []).map((p) => (
                <tr key={p.id}>
                  <td data-sort={p.id}>{p.id}</td>
                  <td data-sort={p.kind}>{p.kind === 'os' ? 'OS' : '기능'}</td>
                  <td data-sort={p.matchText || ''} className="bmo-wrap">{p.matchText || '—'}</td>
                  <td className="right" data-sort={p.checks ?? ''}>{p.checks ?? '—'}</td>
                  <td className="right" data-sort={p.tunings ?? ''}>{p.status === 'active' ? (p.inheritsTuning ? '튜닝 탭 상속' : p.tunings) : '—'}</td>
                  <td data-sort={p.status}>{p.status === 'active' ? '활성' : '예정(만들지 않음)'}</td>
                  <td data-sort={(p.grades || []).join('')}>{(p.grades || []).length ? <Grade grade={(p.grades || []).join(' / ')} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          <div className="bmo-reads"><GradeLegend /></div>
        </section>
      )}
      {seg === 'servers' && (
        <section className="bmo-card">
          <h5 className="bmo-h">서버별 점검 결과(서버를 누르면 상세 ‘용도’ 탭)</h5>
          <STable minWidth={820} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>서버</th><th>법인</th><th>OS</th><th>기능</th><th>역할</th><th>용도 판정</th><th className="right">튜닝 권고</th><th className="right">확인 불가</th></tr></thead>
            <tbody>
              {(resp?.servers || []).map((s) => {
                const st = PROFILE_STATUS_TEXT[s.status] || PROFILE_STATUS_TEXT.unknown;
                return (
                  <tr key={`${s.agent || ''}|${s.key}`}>
                    <td data-sort={s.name}><span className="bmp-link" role="button" tabIndex={0} onClick={() => onOpen?.(s.key)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(s.key); }}>{s.name}</span>{s.agent && <div className="bmo-sub">엣지 {s.agent}</div>}</td>
                    <td data-sort={s.vcenterId}>{s.vcenterId || '—'}</td>
                    <td data-sort={s.os}>{s.os}</td>
                    <td data-sort={(s.apps || []).join(',')}>{(s.apps || []).map((a) => APP_LABEL[a] || a).join(' · ') || '—'}{s.manual && <div className="bmo-sub">수동 태그</div>}</td>
                    <td data-sort={s.role}>{ROLE_LABEL[s.role] || s.role}{s.roleManual ? '' : <span className="bmo-sub">(기본)</span>}</td>
                    <td data-sort={st.rank}><span style={{ color: toneVar(st.tone) }}>{st.label}</span>{!s.factsRead && <div className="bmo-sub">사실 없음</div>}</td>
                    <td className="right" data-sort={s.tuning?.advise ?? 0}>{s.tuning?.advise ?? '—'}</td>
                    <td className="right" data-sort={s.tuning?.unknown ?? 0}>{s.tuning?.unknown ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </section>
      )}
      {seg === 'tuning' && (
        <section className="bmo-card">
          <h5 className="bmo-h">튜닝 항목별 서버 수 — 권고 · 적합 · 참고 · 확인 불가(확인 불가는 불일치가 아닙니다)</h5>
          <STable minWidth={720} className="bmo-t" style={{ fontSize: 12 }}>
            <thead><tr><th>분류</th><th>항목</th>{['advise', 'ok', 'info', 'unknown'].map((k) => <th key={k} className="right">{TUNING_STATUS_TEXT[k].label}</th>)}<th>등급</th></tr></thead>
            <tbody>
              {(resp?.tuningItems || []).map((x) => (
                <tr key={x.id}>
                  <td data-sort={x.cat}>{x.cat}</td>
                  <td data-sort={x.title}>{x.title}</td>
                  {['advise', 'ok', 'info', 'unknown'].map((k) => <td key={k} className="right" data-sort={x.counts?.[k] ?? 0} style={k === 'advise' && x.counts?.[k] ? { color: toneVar('warn'), fontWeight: 600 } : undefined}>{x.counts?.[k] ?? 0}</td>)}
                  <td data-sort={x.grade}><Grade grade={x.grade} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
          <p className="bmo-note">권장값은 서버마다 그 서버의 역할 · 용도 프로파일 · 관리자 덮어쓰기로 정해집니다 — 같은 항목도 서버마다 기준이 다를 수 있습니다.</p>
        </section>
      )}
      <section className="bmo-card bmo-honest">
        <h5 className="bmo-h">정직하게 적어 둘 것</h5>
        {PROFILE_HONEST.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      </section>
    </div>
  );
}

export function BmPurposeFleet({ onOpen }) {
  const { resp, err, loading, reload } = useOpsLoad(() => '/tools/bm-usage/profiles', 'fleet');
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="bmo-bar">
        <h4 style={{ margin: 0 }}>용도 분석 — OS × 기능 프로파일</h4>
        <span style={{ flex: '1 1 auto' }} />
        <button className="btn btn-sm bmp-touch" onClick={reload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      <OpsError err={err} />
      {!resp && !err && <p className="bmo-note">불러오는 중…</p>}
      {resp && <PurposeFleetView resp={resp} onOpen={onOpen} />}
    </div>
  );
}

export function FaultsFleetView({ resp, days, onDays, onOpen }) {
  const [corp, setCorp] = useState('');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('all');
  const labels = resp?.labels || {};
  const corps = useMemo(() => [...new Set((resp?.incidents || []).map((i) => i.vcenterId).filter(Boolean))].sort(), [resp]);
  const kinds = useMemo(() => [...new Set((resp?.incidents || []).map((i) => i.kind))], [resp]);
  const rows = (resp?.incidents || []).filter((i) => (!corp || i.vcenterId === corp) && (!kind || i.kind === kind) && (state === 'all' || (state === 'open' ? i.ongoing : !i.ongoing)));
  if (resp && resp.partFaultsAccess === false) return <p className="bmo-note"><BoldText text={`**권한 없음** — 부품 장애 기록은 ‘파트 장애’ 도구 접근이 있어야 봅니다. ${resp.reason || ''}`} /></p>;
  if (resp && resp.available === false) return <p className="bmo-note">{resp.reason || '부품 장애 기록을 읽지 못했습니다.'}</p>;
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div className="bmo-kpis">
        {faultKpiCards(resp?.kpis || {}, { days }).map((c) => (
          <div key={c.key} className="bmo-kpi"><div className="bmo-k">{c.label}</div><div className="bmo-kv" style={{ color: toneVar(c.tone) }}>{c.value}</div>{c.note && <div className="bmo-sub">{c.note}</div>}</div>
        ))}
      </div>
      <div className="bmo-bar">
        <div className="bmp-seg" role="tablist" aria-label="기간">
          {FAULT_PERIODS.map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'active' : ''} onClick={() => onDays?.(d)}>{d ? `${d}일` : '전체'}</button>)}
        </div>
        <Select sort={false} className="select select-sm" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인"><option value="">법인 전체</option>{corps.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Select sort={false} className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="종류"><option value="">종류 전체</option>{kinds.map((k) => <option key={k} value={k}>{labels.kind?.[k] || k}</option>)}</Select>
        <Select sort={false} className="select select-sm" value={state} onChange={(e) => setState(e.target.value)} aria-label="상태"><option value="all">진행 중 + 종료</option><option value="open">진행 중만</option><option value="closed">종료만</option></Select>
      </div>
      {rows.length ? <IncidentTable rows={rows} labels={labels} withServer onServer={onOpen} /> : <p className="bmo-note">조건에 맞는 장애 기록이 없습니다.</p>}
      {resp?.omitted > 0 && <p className="bmo-note">상한으로 {resp.omitted}건은 싣지 않았습니다 — 기간을 좁혀 보세요.</p>}
      <p className="bmo-note">서버 이름을 누르면 그 서버의 ‘장애 기록’ 탭이 열립니다. 범위 계정은 자기 법인 서버의 장애만 봅니다. 기존 파트 장애 모듈의 기록 그대로입니다(새 수집 없음).</p>
    </div>
  );
}

export function BmFaultsFleet({ onOpen }) {
  const [days, setDays] = useState(90);
  const { resp, err, loading, reload } = useOpsLoad((k) => `/tools/bm-usage/faults?days=${k}`, String(days));
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="bmo-bar">
        <h4 style={{ margin: 0 }}>하드웨어 장애 기록 — 함대</h4>
        <span style={{ flex: '1 1 auto' }} />
        <a className="btn btn-sm bmp-touch" href="#/tools/part-faults">파트 장애 도구</a>
        <button className="btn btn-sm bmp-touch" onClick={reload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      <OpsError err={err} />
      {!resp && !err && <p className="bmo-note">불러오는 중…</p>}
      {resp && <FaultsFleetView resp={resp} days={days} onDays={setDays} onOpen={onOpen} />}
    </div>
  );
}
