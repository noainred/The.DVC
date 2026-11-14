/**
 * 서버 한 대의 디스크 배드 섹터 이력(v3.8.0) — iDRAC 상세 '디스크 이력' 탭과 분석 화면의 서버 창이 같이 쓴다.
 *
 * 화면이 지키는 것(설계 README §3):
 *  · '기록 없음' 은 '발생한 적 없음' 이 아니다 — 판정 띠에 항상 로그가 남은 구간을 쓴다.
 *  · 못 읽음 · 일부만 읽음은 판정하지 않는다.
 *  · 판정(아직 사용 중 · 교체됨 · 판단 불가)은 서버가 내린 것 그대로 + 확신 수준 + 근거 목록(판단 근거).
 *  · 무거운 조회라 탭을 열 때 점검을 돌리지 않는다(버튼). 점검 중이면 그 서버 버튼만 잠근다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { fmtDate, fmtDateTime, serverBand, clsTone, verdictTone, confidenceTone, noteOf, clsOfCode, diagInfo, scanSent, sourceRows, sourceTone, traceTone, valCell, SEL_KIND_LABEL, selKindTone } from './diskBadText.js';

/** 디스크 값 표의 기본 순서 — 로그 기록 · 복구 불가 흔적 · 흔적 · 흔적 없음 · 값 모름. */
const TRACE_ORDER = { records: 0, unrecoverable: 1, trace: 2, none: 3, unknown: 4 };
const hours = (h) => (Number.isFinite(h) ? `${(h / 8766).toFixed(1)}년` : '—');
/** 디스크 값 출처 짧은 이름(긴 이름은 마우스를 올리면 — 서버 VALS_SRC_LABEL). */
const SRC_SHORT = { telemetry: '텔레메트리', metrics: 'DriveMetrics' };

const BAND = {
  bad: { border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.10)' },
  warn: { border: '1px solid rgba(245,158,11,.45)', background: 'rgba(245,158,11,.10)' },
  err: { border: '1px solid rgba(239,68,68,.45)', background: 'rgba(239,68,68,.08)' },
  neutral: { border: '1px solid var(--border)', background: 'var(--bg-soft)' },
};

/**
 * @param {{serverId:string, agent?:string|null}} p  agent = 그 서버를 맡은 엣지(수집 서버 id · 중앙 직결은 '').
 *   다른 엣지에 같은 사설 IP id 가 있을 수 있어 (엣지, id)로 찾는다. 모르면 null(서버가 id 하나뿐일 때만 찾는다).
 */
export function DiskBadServerPanel({ serverId, agent = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgBad, setMsgBad] = useState(false);
  const [open, setOpen] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [showProbe, setShowProbe] = useState(true);
  const reqSeq = useRef(0);
  const url = `/tools/disk-bad/server/${encodeURIComponent(serverId)}${agent != null ? `?agent=${encodeURIComponent(agent)}` : ''}`;
  const load = () => {
    const seq = ++reqSeq.current;
    return fetchJson(url)
      .then((d) => { if (seq === reqSeq.current) { setData(d); setErr(null); } })
      .catch((e) => { if (seq === reqSeq.current) setErr(e); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); load(); }, [url]);
  // 점검 중이면 10초마다 이 서버만 다시 읽는다(무거운 집계가 아니다 — 공용 usePolling, 끝나면 멈춘다).
  const poll = usePolling(data?.running ? url : null, {}, 10_000);
  useEffect(() => { if (poll.data) setData(poll.data); }, [poll.data]);

  const scan = (mode) => {
    setBusy(true); setMsg(''); setMsgBad(false);
    postJson('/tools/disk-bad/scan', { scope: 'server', serverId, ...(agent != null ? { agent } : {}), mode })
      .then((r) => {
        // 409 는 던지지 않고 본문으로 온다(api.js) — 시작하지 못한 점검(다른 점검 진행 중 · 엣지 포탈 · 같은 id 가 여러 엣지)을 '보냈습니다' 라고 하지 않는다(v3.8.3).
        const sent = scanSent(r);
        setMsg(sent.text); setMsgBad(!sent.ok);
        return load();
      })
      .catch((e) => { setMsg(e?.message || String(e)); setMsgBad(true); })
      .finally(() => setBusy(false));
  };

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading label="디스크 이력" />;
  if (data.dbUnavailable) return <div className="muted">디스크 배드 섹터 DB 를 열지 못했습니다(포탈 로그 확인).</div>;
  if (data.excluded) return <div className="muted" style={{ padding: 8 }}>HPE iLO 서버입니다 — 이 기능은 Dell iDRAC 의 Lifecycle 로그만 읽어 점검 대상에서 제외했습니다.</div>;

  const v = data.scanned ? data.view : null;
  const band = serverBand(v);
  const refs = data.labels?.refs || [];
  const cov = v?.coverage || null;
  const diag = diagInfo(cov?.diag);
  const recs = (v?.records || []).filter((r) => showAll || r.cls !== 'other').sort((a, b) => b.created - a.created);
  const LIMIT = 200;
  const sources = sourceRows(cov);
  const diskVals = Array.isArray(v?.diskVals) ? [...v.diskVals].sort((a, b) => (TRACE_ORDER[a.trace] ?? 9) - (TRACE_ORDER[b.trace] ?? 9)) : null;
  const selEvents = Array.isArray(v?.selEvents) ? v.selEvents : [];
  const srcLabel = data.labels?.valsSrc || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="flex between" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
        <div style={{ minWidth: 0, fontSize: 12.5 }}>
          <b>iDRAC Lifecycle 로그에서 디스크 배드 섹터 계열 기록을 찾습니다</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {cov ? <>마지막 점검 {fmtDateTime(cov.lastScanAt)}{cov.lastOkAt ? ` · 마지막 성공 ${fmtDateTime(cov.lastOkAt)}` : ''}{cov.logTotal != null ? ` · 로그 ${cov.logTotal.toLocaleString('ko-KR')}건` : ''}{cov.synthesized ? ' · 데모(합성) 결과' : ''}</> : '아직 점검한 적이 없습니다.'}
            {data.running ? ' · 점검 중' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} disabled={busy || data.running} onClick={() => scan('incremental')}>{data.running ? '점검 중…' : (v ? '다시 점검' : '배드 섹터 이력 점검')}</button>
          {v && <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} disabled={busy || data.running} onClick={() => scan('full')} title="이 서버의 로그를 처음부터 다시 읽습니다">처음부터 다시 읽기</button>}
        </div>
      </div>
      {msg && <div className={msgBad ? undefined : 'muted'} style={{ fontSize: 12, ...(msgBad ? { color: 'var(--red)', fontWeight: 600 } : {}) }}>{msg}</div>}

      <div style={{ ...BAND[band.tone], borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>{band.title}</div>
        {band.lines.map((l, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6 }}>{l}</div>)}
      </div>

      {v && Array.isArray(v.alerting) && v.alerting.length > 0 && (
        <div style={{ border: '1px solid rgba(245,158,11,.55)', background: 'rgba(245,158,11,.07)', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.65, minWidth: 0 }}>
          <b>iDRAC 가 지금 이상을 알리는 디스크 {v.alerting.length}개</b> <span className="muted" style={{ fontSize: 12 }}>현재 상태와 고장 예측 — 배드 섹터 기록과는 별개의 근거입니다</span>
          {v.alerting.map((a, i) => (
            <div key={a.slotKey || a.serial || i} style={{ overflowWrap: 'anywhere' }}>
              <span className={`badge ${a.level === 'fault' ? 'red' : 'amber'}`}>{a.levelLabel}</span>{a.predictive && <span className="badge blue" style={{ marginLeft: 4 }}>고장 예측</span>}
              {' '}<b>{a.label || '위치 모름'}</b> · {a.model || '모델 모름'} · S/N {a.serial || '—'}{a.raw ? ` · iDRAC 값 ${a.raw}` : ''}{a.hasRecords ? ' · 이 자리에 배드 섹터 기록도 있습니다' : ''}
            </div>
          ))}
        </div>
      )}
      {v && sources.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 0 6px' }}>어디까지 봤나 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>출처마다 본 기간 — ‘기록 없음’ 은 이 기간 안에서만의 말입니다</span></div>
          {/* 980px 창(본문 약 940px) 안에 다 들어오게 — 글이 긴 칸은 줄을 바꾼다(표 칸 기본값이 nowrap 이다 · 화면 확인에서 비고 칸이 잘렸다). */}
          <STable className="data-table" minWidth={760} style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>출처</th><th>말해 주는 것</th><th>본 기간</th><th>읽은 것</th><th>상태</th><th data-nosort>비고</th></tr></thead>
            <tbody>{sources.map((r) => (
              <tr key={r.key}>
                <td style={{ whiteSpace: 'normal', minWidth: 110 }}><b>{r.name}</b></td>
                <td style={{ whiteSpace: 'normal', minWidth: 110, maxWidth: 170 }}>{r.what}</td>
                <td data-sort={r.rangeSort ?? ''} style={{ whiteSpace: 'normal', minWidth: 120, maxWidth: 170, fontFamily: 'var(--mono)', fontSize: 12 }}>{r.range}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 90, maxWidth: 150 }}>{r.count}</td>
                <td data-sort={r.status} style={{ whiteSpace: 'nowrap' }}><span className={`badge ${sourceTone(r.status)}`}>{r.statusLabel}</span>{Number.isFinite(r.at) ? <div className="muted" style={{ fontSize: 11 }}>{fmtDateTime(r.at)}</div> : null}</td>
                <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 12, minWidth: 180 }}>{r.note || <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </STable>
        </div>
      )}
      {diag && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', fontSize: 12, lineHeight: 1.65, minWidth: 0 }}>
          <b>읽기 진단</b> <span className="muted">이 서버의 로그를 무엇을 얼마나 읽었는지 — 판정이 아니라 읽은 사실입니다</span>
          {diag.lines.map((l, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>{l}</div>)}
          {diag.warn && <div style={{ marginTop: 4, color: 'var(--amber, #f59e0b)', fontWeight: 600 }}>{diag.warn}</div>}
        </div>
      )}
      {data.canProbe && !data.probe && (
        <div className="muted" style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '8px 12px', fontSize: 12, lineHeight: 1.6, minWidth: 0 }}>
          <b>장비 진단이 아직 없습니다</b> — 이 화면에서 ‘다시 점검’ 이나 ‘처음부터 다시 읽기’ 를 눌러 <b>이 서버 한 대만</b> 점검할 때 받아 옵니다(법인 · 전체 점검에서는 받지 않습니다).
          이 서버를 맡은 노드가 다른 점검을 하는 중이면 시작되지 않으니, 점검 탭에서 진행 중인 작업이 없는지 먼저 확인하세요.
        </div>
      )}
      {data.probe && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', fontSize: 12, lineHeight: 1.6, minWidth: 0 }}>
          <div className="flex between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}><b>장비 진단</b> <span className="muted">이 iDRAC 가 실제로 무엇을 주는지(읽기 전용 조회 · {fmtDateTime(data.probeAt)}) — 관리자에게만 보입니다</span></div>
            <button className="tab" style={{ flex: 'none', padding: '3px 10px' }} onClick={() => setShowProbe((x) => !x)}>{showProbe ? '접기' : '펼치기'}</button>
          </div>
          {showProbe && <pre style={{ margin: '6px 0 0', padding: 8, borderRadius: 8, background: 'var(--bg-soft)', fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(data.probe, null, 2)}</pre>}
        </div>
      )}

      {v && v.slots.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 0 6px' }}>기록이 있는 디스크 자리 {v.slots.length}곳</div>
          <STable className="data-table" minWidth={820} style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>위치</th><th>기록</th><th>지금 디스크</th><th>디스크 값</th><th>판정</th><th data-nosort>근거</th></tr></thead>
            <tbody>{v.slots.map((s) => (
              <React.Fragment key={s.slotKey}>
                <tr>
                  <td data-sort={s.slotKey}><b>{s.label}</b></td>
                  <td data-sort={s.total}>{Object.entries(s.byCode).map(([c, n]) => <span key={c} className={`badge ${clsTone(clsOfCode(c, refs))}`} style={{ marginRight: 4 }} title={noteOf(c, refs)}>{c} {n}</span>)}<div className="muted" style={{ fontSize: 11.5 }}>{fmtDate(s.first)} ~ {fmtDate(s.last)}</div></td>
                  <td>{s.drive ? <>{s.drive.model || '—'}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>S/N {s.drive.serial || '—'}{s.drive.health ? ` · ${s.drive.health}` : ''}</div></> : <span className="muted">찾지 못함</span>}</td>
                  <td data-sort={s.vals?.uncorrectable ?? ''} style={{ fontSize: 12, lineHeight: 1.5 }}>{s.vals ? <>재할당 {valCell(s.vals.realloc)}<br />보류 {valCell(s.vals.pending)}<br />복구 불가 {s.vals.uncorrectable > 0 ? <b>{valCell(s.vals.uncorrectable)}</b> : valCell(s.vals.uncorrectable)}</> : <span className="muted">값 모름</span>}</td>
                  <td data-sort={s.verdict}><span className={`badge ${verdictTone(s.verdict)}`}>{data.labels.verdict[s.verdict]}</span> <span className={`badge ${confidenceTone(s.confidence)}`}>{data.labels.confidence[s.confidence]}</span></td>
                  <td><button className="tab" style={{ flex: 'none', padding: '3px 9px', fontSize: 12 }} onClick={() => setOpen(open === s.slotKey ? null : s.slotKey)}>{open === s.slotKey ? '닫기' : '판단 근거'}</button></td>
                </tr>
                {open === s.slotKey && (
                  <tr><td colSpan={6} style={{ background: 'var(--bg-soft)', whiteSpace: 'normal' }}>
                    <ol style={{ margin: '4px 0 6px 18px', padding: 0, fontSize: 12.5, lineHeight: 1.6 }}>
                      {s.evidence.map((e, i) => <li key={i}>{e.text} <span className="muted" style={{ fontSize: 11.5 }}>— {e.src}</span></li>)}
                    </ol>
                    {s.caveat && <div style={{ fontSize: 12, border: '1px dashed var(--border)', borderRadius: 8, padding: '6px 10px' }}><b>틀릴 수 있는 경우</b> — {s.caveat}</div>}
                  </td></tr>
                )}
              </React.Fragment>
            ))}</tbody>
          </STable>
        </div>
      )}

      {v && diskVals && diskVals.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 0 6px' }}>디스크 값 {diskVals.length}개 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>디스크가 스스로 적어 둔 누적 값 — 로그가 넘어가도 남지만, 언제 생겼는지는 말해 주지 않습니다</span></div>
          <STable className="data-table" minWidth={820} style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>위치</th><th>디스크</th><th style={{ textAlign: 'right' }}>재할당</th><th style={{ textAlign: 'right' }}>보류</th><th style={{ textAlign: 'right' }}>복구 불가</th><th>판정</th><th>포탈이 본 변화</th></tr></thead>
            <tbody>{diskVals.map((d) => (
              <tr key={d.id || d.slotKey}>
                <td data-sort={d.slotKey || d.label}><b>{d.label}</b>{d.inVolume === false ? <div className="muted" style={{ fontSize: 11 }}>RAID 밖 — 로그로 볼 수 없음</div> : null}</td>
                <td>{d.model || '—'}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>S/N {d.serial || '—'}{d.media ? ` · ${d.media}` : ''}{Number.isFinite(d.vals?.powerOnHours) ? ` · 가동 ${hours(d.vals.powerOnHours)}` : ''}</div></td>
                <td data-sort={d.vals?.realloc ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{valCell(d.vals?.realloc)}</td>
                <td data-sort={d.vals?.pending ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{valCell(d.vals?.pending)}</td>
                <td data-sort={d.vals?.uncorrectable ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{d.vals?.uncorrectable > 0 ? <b>{valCell(d.vals.uncorrectable)}</b> : valCell(d.vals?.uncorrectable)}</td>
                <td data-sort={TRACE_ORDER[d.trace] ?? 9}><span className={`badge ${traceTone(d.trace)}`}>{d.traceLabel}</span>{d.vals?.src ? <div className="muted" style={{ fontSize: 11 }} title={srcLabel[d.vals.src] || d.vals.src}>{SRC_SHORT[d.vals.src] || d.vals.src}</div> : null}{d.vals?.stale ? <div className="muted" style={{ fontSize: 11 }}>지난 값 · {fmtDate(d.vals.readAt)} 에 읽음</div> : null}</td>
                <td data-sort={d.vals?.changedAt ?? ''} style={{ fontSize: 12, whiteSpace: 'normal', minWidth: 140, maxWidth: 220 }}>{d.vals?.changedAt ? <>늘어남 {fmtDateTime(d.vals.changedAt)}{d.vals.before ? <div className="muted" style={{ fontSize: 11 }}>전: 재할당 {valCell(d.vals.before.realloc)} · 보류 {valCell(d.vals.before.pending)} · 복구 불가 {valCell(d.vals.before.uncorrectable)}</div> : null}</> : (d.vals?.firstAt ? <span className="muted">처음 읽음 {fmtDate(d.vals.firstAt)} · 변화 없음</span> : <span className="muted">—</span>)}</td>
              </tr>
            ))}</tbody>
          </STable>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>재할당 · 보류가 0 이 아니라고 곧 고장은 아닙니다 — 살펴볼 이유입니다. ‘—’ 는 그 값을 읽지 못한 것이고 0 이 아닙니다. 교체되어 나간 디스크의 값은 읽을 수 없습니다.</div>
        </div>
      )}

      {v && selEvents.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 0 6px' }}>시스템 이벤트 로그의 디스크 항목 {selEvents.length}건 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>탈거 · 장착 · 고장 시각 — 빠짐만 교체 판정의 근거로 씁니다</span></div>
          <STable className="data-table" minWidth={760} limit={LIMIT} style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>시각</th><th>위치(추정)</th><th>종류</th><th>SEL 원문</th></tr></thead>
            <tbody>{selEvents.map((e, i) => (
              <tr key={`${e.created}|${e.kind}|${i}`}>
                <td data-sort={e.created ?? ''} style={{ whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>{fmtDateTime(e.created)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{e.slotKey ? e.slotKey.replace(/^bp(\d+):d(\d+)$/, (_, b, dd) => `Disk ${dd} · BP ${b}`) : <span className="muted">위치 모름</span>}</td>
                <td data-sort={e.kind}><span className={`badge ${selKindTone(e.kind)}`}>{SEL_KIND_LABEL[e.kind] || e.kind}</span>{e.messageId ? <div className="muted" style={{ fontSize: 11 }}>{e.messageId}</div> : null}</td>
                <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 240 }}>{e.message || '—'}</td>
              </tr>
            ))}</tbody>
          </STable>
        </div>
      )}

      {v && recs.length > 0 && (
        <div style={{ minWidth: 0 }}>
          <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 6px' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>기록 {recs.length}건{recs.length > LIMIT ? ` (최근 ${LIMIT}건 표시)` : ''}</div>
            <label className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 분류에 없는 스토리지 기록도 보기
            </label>
          </div>
          <STable className="data-table" minWidth={760} limit={LIMIT} style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>시각</th><th>위치</th><th>기록 ID · 주석</th><th>Lifecycle 로그 원문</th></tr></thead>
            <tbody>{recs.map((r) => (
              <tr key={r.entryKey}>
                <td data-sort={r.created} style={{ whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>{fmtDateTime(r.created)}{r.baseline ? <div className="muted" style={{ fontSize: 11 }}>첫 점검에서 찾음</div> : null}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.slotKey ? r.slotKey.replace(/^bp(\d+|\?):d(\d+)$/, (_, b, d) => (b === '?' ? `Disk ${d}` : `Disk ${d} · BP ${b}`)) : <span className="muted">위치 모름</span>}</td>
                <td><span className={`badge ${clsTone(r.cls)}`}>{r.code || '—'}</span><div className="muted" style={{ fontSize: 11.5 }}>{noteOf(r.code, refs) || (r.cls === 'other' ? '분류에 없는 기록 — 원문만 보관' : '')}</div></td>
                <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 240 }}>{r.message || '—'}</td>
              </tr>
            ))}</tbody>
          </STable>
        </div>
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'rgba(59,130,246,.08)', padding: '8px 12px', fontSize: 12, lineHeight: 1.65 }}>
        <b>읽는 법</b> — iDRAC 가 지금 보여 주는 Lifecycle 로그(활성분으로 보입니다 — Dell 안내서 요약 기준)에 남아 있는 구간만 봅니다. 로그가 차서 보관으로 넘어간 과거 기록은 아직 읽지 않습니다. 그 대신 디스크가 적어 둔 누적 값(날짜 없음)과 시스템 이벤트 로그(디스크 탈거 · 장착 시각)를 함께 읽습니다. 기록 ID 는 Dell 이 붙인 메시지 번호이고, 뜻은 Dell 문서를 검색 요약으로 확인한 것입니다(원문 · 실장비 대조 전).
        ‘아직 사용 중’ 은 포탈이 적어 둔 시리얼이 같으면 확정, 로그에 디스크 빠짐 기록이 없으면 추정입니다. 찾은 기록은 포탈에 보관해, iDRAC 로그가 덮어써져도 남습니다.
        {cov?.continuousSince ? ` 끊김 없이 읽은 구간: ${fmtDate(cov.continuousSince)} 이후.` : ''}
      </div>
    </div>
  );
}

export default DiskBadServerPanel;
