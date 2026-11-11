// v2.965 — 'PowerScale 장비 점검'(독립 도구 ps-inspect · 메뉴 '스토리지 › PowerScale 장비 점검' · 설계 docs/design/powerscale-inspection · 사용자 컨펌 2026-11-11 '1차 + 2차').
//   법인별 PowerScale(아이실론) 주간 점검 20항목 · 장비별 결과 · 주간 보고서(메일 · PDF 저장 · CSV) · Top 10 노드 편중 · 점검 주기와 근거.
//   판정 · 조립은 서버(storage/inspect/*) — 화면은 그리기만(psInspect/psInspectText.js 순수). 조회는 마운트 1회 + 버튼(폴링 없음) · 늦게 온 이전 응답은 버린다.
//   보기는 해시(useHashTab) — overview · device(/<장비 id>) · report · top · sources.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, hasRole, canCsv, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { hashSegments } from '../../hooks/hashTab.js';
import InspectOverview from './psInspect/InspectOverview.jsx';
import InspectDevice from './psInspect/InspectDevice.jsx';
import InspectReport from './psInspect/InspectReport.jsx';
import InspectTop from './psInspect/InspectTop.jsx';
import InspectSources from './psInspect/InspectSources.jsx';
import InspectSettings from './psInspect/InspectSettings.jsx';
import { VIEWS, scheduleText, kstText } from './psInspect/psInspectText.js';
import './psInspect/psInspect.css';

const BASE = ['tools', 'ps-inspect'];
const VIEW_KEYS = VIEWS.map((v) => v.key);
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
/** 요청 하나 — 늦게 온 이전 응답은 버린다(seq). */
function useLoad(path, enabled = true) {
  const [st, setSt] = useState({ data: null, err: null, busy: false });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!enabled || !path) return;
    const my = ++seq.current;
    setSt((s) => ({ ...s, busy: true, err: null }));
    fetchJson(path).then((d) => { if (my === seq.current) setSt({ data: d, err: null, busy: false }); })
      .catch((e) => { if (my === seq.current) setSt((s) => ({ ...s, err: e, busy: false })); });
  }, [path, enabled]);
  useEffect(() => { load(); }, [load]);
  return { ...st, reload: load };
}

export default function PsInspectTool() {
  // ⚠ 훅은 전부 조기 return 위(React #310).
  const [view, setView] = useHashTab({ base: BASE, valid: VIEW_KEYS, fallback: 'overview' });
  const segs = useHashSegs();
  const devId = view === 'device' && segs[3] ? safeDecode(segs[3]) : '';
  const isAdmin = hasRole('admin');
  const ov = useLoad('/tools/ps-inspect');
  const cat = useLoad('/tools/ps-inspect/catalog');
  const det = useLoad(devId ? `/tools/ps-inspect/devices/${encodeURIComponent(devId)}` : '', !!devId);
  const [corp, setCorp] = useState('');
  const rep = useLoad(`/tools/ps-inspect/report${corp ? `?corp=${encodeURIComponent(corp)}` : ''}`, view === 'report');
  const [metric, setMetric] = useState('ops');
  const [range, setRange] = useState('7d');
  const top = useLoad(`/tools/ps-inspect/top-nodes?metric=${metric}&range=${range}`, view === 'top');
  const [run, setRun] = useState({ busy: false, msg: null });
  const [send, setSend] = useState({ busy: false, msg: null });
  const [showSettings, setShowSettings] = useState(false);

  const openDevice = (id) => { window.location.hash = `#/${[...BASE, 'device', encodeURIComponent(id)].join('/')}`; };
  const pickDevice = (id) => { if (id) openDevice(id); };
  const startRun = async (ids = null) => {
    setRun({ busy: true, msg: null });
    try {
      const r = await postJson('/tools/ps-inspect/run', ids ? { ids } : {});
      if (r?.ok === false) setRun({ busy: false, msg: { ok: false, text: r.reason || '시작하지 못했습니다' } });
      else setRun({ busy: false, msg: { ok: true, text: `점검을 시작했습니다 — 이 포탈 ${r.local}대 바로 · 엣지 ${r.queued}대는 그 법인 엣지가 다음 설정 pull 때 받아 점검하고 다음 push 로 올립니다${r.unknown?.length ? ` · 대상 아님 ${r.unknown.length}` : ''}. 끝난 결과는 ‘새로고침’ 으로 봅니다.` } });
    } catch (e) { setRun({ busy: false, msg: { ok: false, text: String(e?.message || e) } }); }
  };
  const sendNow = async () => {
    setSend({ busy: true, msg: null });
    try {
      const r = await postJson('/tools/ps-inspect/report/send-now', {});
      const text = r?.ok ? `보냈습니다(${r.sent ?? 0}/${r.jobs ?? 0}판)` : `보내지 못했습니다 — ${r?.reason || (r?.results || []).map((x) => x.reason).filter(Boolean).join(' · ') || r?.state || '사유 미상'}`;
      setSend({ busy: false, msg: { ok: !!r?.ok, text } });
    } catch (e) { setSend({ busy: false, msg: { ok: false, text: String(e?.message || e) } }); }
  };
  const corpList = ov.data?.corps || [];

  if (!ov.data && ov.err) return <div className="psi"><ErrorBox error={ov.err} /></div>;
  if (!ov.data) return <div className="psi"><Loading label="PowerScale 점검 현황" /></div>;
  const sch = ov.data.schedule;
  // lastRunSlot 은 처음 기동 때 '기준' 으로도 잡힌다(돌리지 않은 회차) — 실제로 시작한 정기 회차만 보여 준다.
  const lastRun = (sch?.history || []).find((h) => h?.type === 'run' && h.kind === 'schedule' && h.state === 'started') || null;
  return (
    <div className="psi">
      <div className="psi-head">
        <span className="psi-title">PowerScale 장비 점검</span>
        <span className="psi-pill">{scheduleText(sch)}</span>
        {lastRun ? <span className="psi-pill">마지막 정기 점검 {kstText(lastRun.slot)}</span> : null}
        {ov.data.runner?.busy && <span className="psi-pill">점검 중{ov.data.runner.current ? ` — ${ov.data.runner.current}` : ''}</span>}
      </div>
      <div className="psi-bar">
        <div className="psi-seg" role="group" aria-label="보기">{VIEWS.map((v) => <button key={v.key} type="button" className={view === v.key ? 'on' : ''} aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}</div>
        <span className="psi-grow" />
        <button type="button" className="psi-btn" onClick={() => { ov.reload(); if (devId) det.reload(); if (view === 'report') rep.reload(); if (view === 'top') top.reload(); }} disabled={ov.busy}>{ov.busy ? '불러오는 중…' : '새로고침'}</button>
        <button type="button" className="psi-btn" onClick={() => setShowSettings((x) => !x)} aria-expanded={showSettings}>일정 · 메일 · 기준</button>
        {isAdmin && <button type="button" className="psi-btn primary" onClick={() => startRun(null)} disabled={run.busy} title="모든 대상 장비에 읽기 전용 점검 명령을 보냅니다">{run.busy ? '시작하는 중…' : '지금 점검(전체)'}</button>}
      </div>
      {ov.err && <div className="psi-banner amber">새로 불러오지 못했습니다(전에 받은 값을 보여 줍니다): {String(ov.err?.message || ov.err)}</div>}
      {run.msg && <div className={`psi-banner${run.msg.ok ? '' : ' amber'}`}>{run.msg.text}</div>}
      {ov.data.settingsUnreadable && <div className="psi-banner amber">점검 설정 파일을 읽지 못해 기본값(매주 월요일 09:00)으로 돌고 있습니다.</div>}
      {ov.data.store?.loadError && <div className="psi-banner amber">점검 이력 파일을 읽지 못해 빈 이력으로 시작했습니다(원본은 .corrupt 로 보존): {ov.data.store.loadError}</div>}
      {(ov.data.drops || []).length > 0 && <div className="psi-banner amber">엣지가 받아 가지 않았거나 결과를 올리지 않아 버린 점검 요청 {ov.data.drops.length}건이 있습니다 — 그 엣지의 상태를 확인하세요.</div>}
      {showSettings && <InspectSettings schedule={sch} corps={corpList} isAdmin={isAdmin} unreadable={ov.data.settingsUnreadable} onSaved={() => ov.reload()} />}
      {view === 'overview' && <InspectOverview data={ov.data} onOpen={openDevice} />}
      {view === 'device' && <InspectDevice devices={ov.data.devices} id={devId} detail={det.data?.device} busy={det.busy} err={det.err} actions={cat.data?.actions} isAdmin={isAdmin} onPick={pickDevice} onRun={startRun} running={run.busy} />}
      {view === 'report' && <InspectReport rep={rep.data} busy={rep.busy} err={rep.err} corps={corpList.filter((c) => c.key)} corp={corp} onCorp={setCorp} isAdmin={isAdmin} csvOk={canCsv()}
        onPrint={() => window.print()} onHtml={() => downloadFile(`/tools/ps-inspect/report?format=html${corp ? `&corp=${encodeURIComponent(corp)}` : ''}`).catch(() => {})}
        onCsv={() => downloadFile('/tools/ps-inspect/report.csv', 'powerscale-inspect.csv').catch(() => {})} onSend={sendNow} sending={send.busy} sendResult={send.msg} />}
      {view === 'top' && <InspectTop top={top.data} busy={top.busy} err={top.err} metric={metric} range={range} onMetric={setMetric} onRange={setRange} onOpen={openDevice} />}
      {view === 'sources' && <InspectSources cat={cat.data} />}
    </div>
  );
}
