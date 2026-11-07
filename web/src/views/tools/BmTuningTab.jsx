/**
 * 서버 상세 ‘튜닝’ 탭(리눅스 성능 4단계 · 아트보드 ⑤ Tuning.dc.html) — 요약 띠(TuneD · 상태 수 · 역할 · 근거 등급) → 분류 ①~⑤ 카드(항목 · 현재 · 권장(누가) · 근거 요지 · 출처 · 상태) →
 * 근거 문서 목록(번호 · 확인 방법 · 등급) → 정직 기록.
 * ⚠ 판정은 서버(`tuning/judge.js`) — 이 파일은 그리기만. **자동 적용 버튼 없음**(읽기 전용 — 적용은 담당자가).
 * ⚠ 조회는 탭을 열 때 1회 + ‘다시 읽기’(폴링 없음) · 늦게 온 응답은 세대로 버린다(createDetailLoader).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { createDetailLoader } from './BmPerfDetail.jsx';
import { detailErrorText } from './bmPerfText.js';
import {
  TUNING_STATUS_TEXT, GRADE_TEXT, gradeView, byText, tuningSummaryParts, devicesText, tuningStatusView, sourceById, factsNotes,
  tuningHeadParts, TUNING_HONEST,
} from './bmOpsText.js';
import './bmOps.css';

/**
 * 탭 조회기 — 키가 바뀌면 1회 조회 + ‘다시 읽기’ · 늦게 온 이전 키 응답은 버린다(세대 — createDetailLoader). 폴링 없음.
 * `url(key)` 는 키에서 경로를 만든다(키에 기간 같은 선택을 함께 담으면 선택이 바뀔 때 다시 읽는다).
 */
/** 조회 실패 — 403 은 ErrorBox(권한 안내), 404 는 ‘없거나 범위 밖’(둘을 구분하지 않는다 — 형제 탭과 같은 문구). */
export function OpsError({ err }) {
  if (!err) return null;
  if (err.status === 403) return <ErrorBox error={err} />;
  return <p className="bmo-note" style={{ color: toneVar('bad') }}>{detailErrorText(err)}</p>;
}

export function useOpsLoad(url, key) {
  const [st, setSt] = useState({ resp: null, err: null, loading: false });
  const loader = useRef(null);
  if (!loader.current) loader.current = createDetailLoader((k) => fetchJson(url(k), {}, undefined, { timeoutMs: 60_000 }));
  const set = useCallback((p) => setSt((s) => ({ ...s, ...p })), []);
  const load = useCallback(() => loader.current.load(key, set), [key, set]);
  useEffect(() => { setSt({ resp: null, err: null, loading: false }); load(); }, [load]);
  return { ...st, reload: load };
}

/** 근거 등급 — 기호 + 짧은 낱말(‘◐ 발췌’). 등급 문자열은 서버 카탈로그 값 그대로. */
/** 등급 범례 — 기호는 표 칸과 같은 기호 글꼴(.bmo-g)로(400 판독: 범례의 ◐ 가 작은 반원으로 보였다). 문장은 GRADE_TEXT 그대로. */
export function GradeLegend() {
  return Object.entries(GRADE_TEXT).map(([g, txt], i) => <React.Fragment key={g}>{i > 0 && ' · '}<span className="bmo-g">{g}</span>{txt}</React.Fragment>);
}
export function Grade({ grade }) {
  const v = gradeView(grade);
  return (
    <span className="bmo-grade" title={v.title}>
      {v.parts.map((p, i) => <React.Fragment key={i}>{i > 0 && ' / '}<span className="bmo-g">{p.g}</span>{p.label}</React.Fragment>)}
      {v.note && <span className="bmo-sub"> {v.note}</span>}
    </span>
  );
}
function Sources({ ids = [], list = [] }) {
  if (!ids.length) return <span style={{ color: 'var(--muted)' }}>공식 문서 없음(검색 범위 내)</span>;
  return (
    <span>
      {ids.map((id, i) => {
        const s = sourceById(list, id);
        return (
          <React.Fragment key={id}>
            {i > 0 && ' · '}
            {s ? <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>{id}</a> : id}
          </React.Fragment>
        );
      })}
    </span>
  );
}

export function TuningView({ resp }) {
  const items = Array.isArray(resp?.items) ? resp.items : [];
  const head = tuningHeadParts(resp || {});
  const notes = factsNotes(resp || {});
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-band">
        <div><span className="bmo-k">TuneD 활성 프로파일</span> <b>{head.tuned}</b></div>
        <div className="bmo-counts">
          {tuningSummaryParts(resp?.counts).map((p) => (
            <span key={p.key} className="bmp-chip" style={{ color: toneVar(p.tone) }}>{p.label} {p.count}</span>
          ))}
        </div>
        <div style={{ fontSize: 12 }}><span className="bmo-k">권장값 기준</span> 역할 {head.role} · 용도 {head.apps} · 읽기 전용 — 적용은 담당자가</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>근거 등급: <GradeLegend /></div>
      </div>
      {notes.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      {(resp?.categories || []).map((c) => {
        const rows = items.filter((x) => x.cat === c.no);
        if (!rows.length) return null;
        return (
          <section key={c.no} className="bmo-card">
            <h5 className="bmo-h">{c.no} · {c.title}</h5>
            <div className="bmo-reads">읽는 것: {c.reads}</div>
            <STable minWidth={980} className="bmo-t" style={{ fontSize: 12 }}>
              <thead><tr><th>항목</th><th>현재</th><th>권장(누가 정했나)</th><th>근거 — 문서 요지</th><th>출처</th><th>상태</th></tr></thead>
              <tbody>
                {rows.map((x) => {
                  const sv = tuningStatusView(x);
                  const cur = x.devices ? devicesText(x.devices) : (x.current ?? '');
                  return (
                    <tr key={x.id}>
                      <td data-sort={x.title} className="bmo-name">{x.title}</td>
                      <td data-sort={cur || ''} className="bmo-wrap bmo-cur">{cur || '—'}</td>
                      <td data-sort={x.rec || ''} className="bmo-wrap">{x.rec || '—'}<div className="bmo-sub">{byText(x.by)}</div></td>
                      <td data-nosort className="bmo-wrap bmo-ev"><Grade grade={x.grade} /> {x.evidence}</td>
                      <td data-sort={(x.sources || []).join(',')}><Sources ids={x.sources} list={resp.sources} /></td>
                      <td data-sort={sv.rank} title={sv.title} className="bmo-wrap">
                        <span style={{ color: toneVar(sv.tone), fontWeight: 600 }}>{sv.label}</span>
                        {sv.reason && <div className="bmo-sub">{sv.reason}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </section>
        );
      })}
      <section className="bmo-card">
        <h5 className="bmo-h">근거 문서 목록 — 이 탭이 인용한 공식 문서</h5>
        <div className="bmo-reads">확인일 {resp?.sourcesCheckedAt || '—'} · 각 행의 출처 번호가 이 표를 가리킵니다</div>
        <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>문서</th><th>확인 방법</th><th>등급</th></tr></thead>
          <tbody>
            {(resp?.sources || []).map((s) => (
              <tr key={s.id}>
                <td data-sort={s.id}>{s.id}</td>
                <td data-sort={s.title} className="bmo-wrap"><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></td>
                <td data-sort={s.how} className="bmo-wrap">{s.how}</td>
                <td data-sort={s.grade}><Grade grade={s.grade} /></td>
              </tr>
            ))}
          </tbody>
        </STable>
      </section>
      <section className="bmo-card bmo-honest">
        <h5 className="bmo-h">정직하게 적어 둘 것</h5>
        {TUNING_HONEST.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      </section>
    </div>
  );
}

export default function BmTuningTab({ itemKey }) {
  const { resp, err, loading, reload } = useOpsLoad((k) => `/tools/bm-usage/perf/${encodeURIComponent(k)}/tuning`, itemKey);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="bmo-bar">
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>권장값은 역할(DB · 웹 · 캐시 · 파일 · 일반)과 용도 프로파일이 정합니다 — 상태: {Object.values(TUNING_STATUS_TEXT).map((s) => s.label).join(' · ')}</span>
        <span style={{ flex: '1 1 auto' }} />
        <button className="btn btn-sm bmp-touch" onClick={reload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      <OpsError err={err} />
      {!resp && !err && <p className="bmo-note">튜닝 판정을 불러오는 중…</p>}
      {resp && <TuningView resp={resp} />}
    </div>
  );
}
