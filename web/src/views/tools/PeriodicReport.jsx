// v3.31 — '정기 점검 보고'(도구 periodic-report · 메뉴 '특수 기능 › 리포트 · 점검' · 설계 docs/design/periodic-report · 컨펌 2026-11-20 '진행해').
//   일일 · 주간 · 월간 · 분기 — 인프라 · 서비스 · 설비를 저장된 수집 결과로 점검한 보고서의 보관함 · 점검 항목 · 일정 · 전달 · 보고서 열람.
//   판정 · 조립 · 범위 절단은 서버(server/src/periodic/*) — 화면은 그리기만(periodicReport/periodicReportText.js 순수). 조회는 마운트 1회 + 버튼(폴링 없음 —
//   보고서를 만드는 동안에만 상태를 5초마다 본다) · 늦게 온 이전 응답은 버린다. 보기는 해시 — archive · items · schedule · r/<회차 ID>.
import React, { useEffect, useState } from 'react';
import { hasRole } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { hashSegments } from '../../hooks/hashTab.js';
import Archive from './periodicReport/Archive.jsx';
import ReportView from './periodicReport/ReportView.jsx';
import CatalogTab from './periodicReport/CatalogTab.jsx';
import ScheduleTab from './periodicReport/ScheduleTab.jsx';
import { VIEWS, busyText } from './periodicReport/periodicReportText.js';
import { useLoad } from './periodicReport/parts.jsx';
import './periodicReport/periodicReport.css';

const BASE = ['tools', 'periodic-report'];
const VIEW_KEYS = [...VIEWS.map((v) => v.key), 'r'];
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return ''; } };
function useHashSegs() {
  const [segs, setSegs] = useState(() => hashSegments(window.location.hash));
  useEffect(() => {
    const on = () => setSegs(hashSegments(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return segs;
}
export default function PeriodicReport() {
  // ⚠ 훅은 전부 조기 return 위(React #310).
  const [view, setView] = useHashTab({ base: BASE, valid: VIEW_KEYS, fallback: 'archive' });
  const segs = useHashSegs();
  const runId = view === 'r' && segs[3] ? safeDecode(segs[3]) : '';
  const isAdmin = hasRole('admin');
  const st = useLoad('/tools/periodic-report/status');
  const [preview, setPreview] = useState(null);   // { run, previewId } — 미리보기(보관 · 전달 안 함)
  const busy = st.data?.busy || null;
  // 만드는 중일 때만 5초마다 상태를 본다(그 밖에는 폴링하지 않는다).
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => st.reload(), 5000);
    return () => clearInterval(t);
  }, [busy, st.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const openRun = (id) => { window.location.hash = `#/${[...BASE, 'r', encodeURIComponent(id)].join('/')}`; };
  if (!st.data && st.err) return <div className="prr"><ErrorBox error={st.err} /></div>;
  if (!st.data) return <div className="prr"><Loading label="정기 점검 보고" /></div>;
  const scoped = !!st.data.scoped;
  return (
    <div className="prr">
      <div className="prr-head">
        <span className="prr-title">정기 점검 보고</span>
        <span className="prr-muted">일일 · 주간 · 월간 · 분기 — 인프라 · 서비스 · 설비를 저장된 수집 결과로 점검한 보고서</span>
        {busy && <span className="prr-pill run">{busyText(busy)}</span>}
      </div>
      <div className="prr-bar">
        <div className="prr-seg" role="group" aria-label="보기">
          {VIEWS.map((v) => <button key={v.key} type="button" className={view === v.key ? 'on' : ''} aria-pressed={view === v.key} onClick={() => { setPreview(null); setView(v.key); }}>{v.label}</button>)}
        </div>
        <span className="prr-grow" />
        <button type="button" className="prr-btn" onClick={() => st.reload()} disabled={st.busy}>{st.busy ? '불러오는 중…' : '새로고침'}</button>
      </div>
      <div className="prr-banner">보고서는 새로 수집하지 않습니다 — 폴러 · 엣지가 저장한 최신값 · 추이 · 판정만 읽어서 만듭니다. 회차마다 데이터 기준 시각을 적고, 못 읽거나 오래되거나 꺼진 원천은 정상에도 이상에도 넣지 않고 <b>확인 불가</b>로 따로 셉니다. 시각은 포탈 시각입니다.</div>
      {st.err && <div className="prr-banner amber">새로 불러오지 못했습니다(전에 받은 값을 보여 줍니다): {String(st.err?.message || st.err)}</div>}
      {st.data.edge && <div className="prr-banner amber">이 포탈은 엣지입니다 — 정기 점검 보고는 중앙 포탈만 만들고 보냅니다.</div>}
      {st.data.settingsError && <div className="prr-banner amber">설정 파일을 읽지 못해 정기 점검 보고를 멈췄습니다(사용자가 꺼 둔 보고를 기본값으로 켜지 않게): {st.data.settingsError.reason}</div>}
      {st.data.lastError && <div className="prr-banner amber">마지막 오류 — {st.data.lastError.message}</div>}
      {preview && <ReportView run={preview.run} previewId={preview.previewId} isAdmin={isAdmin} onClose={() => setPreview(null)} onKept={(id) => { setPreview(null); st.reload(); openRun(id); }} />}
      {!preview && view === 'archive' && <Archive status={st.data} scoped={scoped} onOpen={openRun} />}
      {!preview && view === 'items' && <CatalogTab isAdmin={isAdmin} scoped={scoped} />}
      {!preview && view === 'schedule' && <ScheduleTab status={st.data} isAdmin={isAdmin} scoped={scoped} onChanged={() => st.reload()} onPreview={(p) => setPreview(p)} onOpen={openRun} />}
      {!preview && view === 'r' && <ReportView id={runId} isAdmin={isAdmin} scoped={scoped} onBack={() => setView('archive')} />}
    </div>
  );
}
