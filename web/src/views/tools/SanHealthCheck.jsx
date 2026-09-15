import React, { useEffect, useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { STATUS_LABEL, STATUS_MARK, stageLabel, stamp, deviceVerdict, allSummaryText,
  sortResults, baselineNote, deviceReportDoc, allReportDoc, reportFileName } from './sanHealthText.js';

/**
 * 특수기능 › SAN 스위치 모니터링 — **월간 점검**(v2.519, 사용자 제공 Brocade 월간 점검 체크리스트).
 *
 * 사용자 요청: "위 명령어를 조합해서 장비 점검하는 기능 / 장비별 점검 / 전체 SAN 스위치 점검 버튼 /
 * 이상 유무를 간단하게 보고 / 자세한 정보를 세부 보고서를 PDF 로".
 *
 * ⚠ 이 화면의 제1 규칙: **'확인 불가' 를 '이상 없음' 에 섞지 않는다.** 그래서 KPI 도 '정상/주의/
 *   이상' 옆에 '확인 불가' 를 따로 세우고, 문구는 순수 모듈(`sanHealthText.js`)이 소유한다.
 * ⚠ 점검은 **저장된 스냅샷을 판정**한다(스위치 재접속 없음) — 전체 점검이 28대에 동시 SSH 를
 *   열면 그게 운영 사고다. 최신 데이터가 필요하면 '전체 수집' 을 먼저 누르고 점검한다.
 * ⚠ PDF 는 기존 벡터 PDF 인프라(`reportExport.saveDocAsPdf`)를 재사용한다 — jsPDF·한글 폰트는
 *   **동적 import** 라 버튼을 누른 사람만 내려받는다(청크를 무겁게 하지 않는다).
 */

const COLOR = { green: 'var(--green, #22c55e)', amber: 'var(--amber, #f59e0b)', red: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };
const tone = (c) => COLOR[c] || COLOR.muted;

/**
 * 판정 배지.
 *
 * ⚠ `label`·`color` 를 **주입할 수 있게** 해 둔다 — 장비 종합 판정은 '정상이지만 일부 미확인'
 *   일 때 초록 '정상' 이 아니라 호박색 '정상(일부 미확인)' 이어야 한다(`deviceVerdict`).
 *   Chromium 판독에서 판정 열만 훑으면 색을 보고 '괜찮다' 고 읽히는 것을 발견해 고친 것이다.
 */
function StatusBadge({ status, label, color }) {
  const c = color || { ok: 'green', warn: 'amber', bad: 'red', unknown: 'muted' }[status] || 'muted';
  return (
    <span style={{ color: tone(c), fontWeight: c === 'green' ? 400 : 600, whiteSpace: 'nowrap' }}>
      {STATUS_MARK[status] || '·'} {label || STATUS_LABEL[status] || status}
    </span>
  );
}

/** 항목 표 — 단계별로 묶어 체크리스트 순서대로. 근거는 펼쳐 보기(원문 복사 가능). */
function ItemTable({ items }) {
  const [open, setOpen] = useState(null);
  const byStage = useMemo(() => {
    const m = new Map();
    for (const i of items || []) { if (!m.has(i.stage)) m.set(i.stage, []); m.get(i.stage).push(i); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [items]);
  return (
    <>
      {byStage.map(([stage, list]) => (
        <div key={stage} style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 11, margin: '6px 0 4px' }}>{stageLabel(stage)}</div>
          <div className="table-wrap">
            <STable>
              <thead><tr><th>항목</th><th>판정</th><th>명령</th><th>결과</th><th data-nosort>근거</th></tr></thead>
              <tbody>
                {list.map((i) => {
                  const ev = i.evidence || [];
                  const isOpen = open === i.key;
                  return (
                    <React.Fragment key={i.key}>
                      <tr>
                        <td style={{ whiteSpace: 'nowrap' }}><b>{i.label}</b></td>
                        <td data-sort={i.status}><StatusBadge status={i.status} /></td>
                        <td><code style={{ fontSize: 11 }}>{i.cmd || '—'}</code></td>
                        {/* 결과 문구는 문장이라 길다 — 줄바꿈을 허용해야 오른쪽에서 잘리지 않는다(v2.513 규약) */}
                        <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: 420 }}><BoldText text={i.detail || ''} /></td>
                        <td>
                          {ev.length
                            ? <button className="tab" style={{ padding: '2px 8px' }} onClick={() => setOpen(isOpen ? null : i.key)}>{isOpen ? '접기' : `${ev.length}건`}</button>
                            : <span className="muted">—</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={5}>
                            {/* 원문은 <pre> — 선택·복사가 되고 모바일에서도 보인다(v2.516 규약) */}
                            <pre style={{ margin: 0, padding: 8, background: 'var(--bg2, rgba(0,0,0,0.25))', borderRadius: 6,
                              fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }}>{ev.join('\n')}</pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </div>
      ))}
    </>
  );
}

/** 장비 1대 점검 패널 — 포트 상세 모달의 '점검' 탭. */
export function DeviceHealthPanel({ deviceId, deviceName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => {
    setError(null);
    return fetchJson(`/tools/sanswitch/devices/${deviceId}/healthcheck`)
      .then((d) => setData(d)).catch((e) => setError(e.message));
  };
  // 폴링하지 않는다 — 스냅샷 판정이라 값이 스스로 바뀌지 않고, 탭을 열 때 1회면 충분하다.
  useEffect(() => { let alive = true; setData(null); fetchJson(`/tools/sanswitch/devices/${deviceId}/healthcheck`)
    .then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; }; }, [deviceId]);

  const saveBaseline = async () => {
    if (!window.confirm('현재 수집된 포트 에러 카운터를 이번 달 기준선으로 저장할까요?\n\n· 스위치의 카운터는 건드리지 않습니다(portstatsclear 를 실행하지 않습니다).\n· 다음 점검부터 이 시점 이후 신규 에러만 가려서 보여줍니다.')) return;
    setBusy(true); setMsg('');
    try { const r = await postJson(`/tools/sanswitch/devices/${deviceId}/err-baseline`, {});
      setMsg(`기준선 저장 완료 — 포트 ${r.baseline?.portCount ?? 0}개`); await load(); }
    catch (e) { setMsg(`기준선 저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const dropBaseline = async () => {
    if (!window.confirm('저장된 기준선을 지울까요? 다음 점검부터 당월 신규 에러를 판정하지 않습니다.')) return;
    setBusy(true); setMsg('');
    try { await delJson(`/tools/sanswitch/devices/${deviceId}/err-baseline`); setMsg('기준선 삭제'); await load(); }
    catch (e) { setMsg(`삭제 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const savePdf = async () => {
    setBusy(true); setMsg('PDF 만드는 중…');
    try {
      const { saveDocAsPdf } = await import('./reportExport.js');
      await saveDocAsPdf(deviceReportDoc(data.result, { baseline: data.baseline }), reportFileName(data.result?.name || deviceName));
      setMsg('PDF 저장 완료');
    } catch (e) { setMsg(`PDF 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const r = data.result;
  const v = deviceVerdict(r);
  const c = r?.counts || {};

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: tone(v.color) }}>{STATUS_MARK[r?.overall]} {v.label}</div>
        <div className="muted" style={{ fontSize: 12 }}>{v.text}</div>
        <div style={{ flex: 1 }} />
        <button className="tab" style={{ flex: 'none', padding: '4px 10px' }} disabled={busy} onClick={savePdf}>📄 점검 보고서 PDF</button>
        {data.baseline
          ? <button className="tab" style={{ flex: 'none', padding: '4px 10px' }} disabled={busy} onClick={dropBaseline}>기준선 삭제</button>
          : <button className="login-btn" style={{ flex: 'none', padding: '4px 10px' }} disabled={busy} onClick={saveBaseline}>이번 달 기준선 저장</button>}
      </div>
      {msg && <div className="card muted" style={{ fontSize: 12, padding: 8, marginBottom: 6 }}>{msg}</div>}
      <div className="muted" style={{ fontSize: 11, marginBottom: 6, lineHeight: 1.8 }}>
        판정 데이터 수집 시각 <b>{stamp(r?.collectedAt)}</b> — 점검은 이 스냅샷을 판정한 것이고 스위치에 새로 접속하지 않습니다.
        최신 상태로 점검하려면 먼저 <b>수집</b>을 누르세요.
        <div><BoldText text={baselineNote(data.baseline)} /></div>
        {c.unknown ? (
          <div style={{ color: COLOR.amber, marginTop: 2 }}>
            ⚠ <b>확인 불가 {c.unknown}항목</b> — 이상이 없다는 뜻이 아니라 그 항목을 보지 못했다는 뜻입니다(명령 없음·실행 실패·형식 미인식).
          </div>
        ) : null}
      </div>
      {error && <ErrorBox message={error} />}
      <ItemTable items={r?.items || []} />
    </div>
  );
}

/** 전체 점검 — 목록 화면의 '전체 점검' 버튼이 여는 모달 본문. */
export function AllHealthCheck({ datacenterIds = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null);
  const dcParam = datacenterIds.join(',');

  useEffect(() => {
    let alive = true; setData(null); setError(null);
    fetchJson('/tools/sanswitch/healthcheck-all', dcParam ? { datacenterId: dcParam } : {})
      .then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [dcParam]);

  const savePdf = async () => {
    setBusy(true); setMsg('PDF 만드는 중…');
    try {
      const { saveDocAsPdf } = await import('./reportExport.js');
      await saveDocAsPdf(allReportDoc(data), reportFileName(dcParam ? '선택법인' : '전체'));
      setMsg('PDF 저장 완료');
    } catch (e) { setMsg(`PDF 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const rows = sortResults(data.results);
  const s = data.summary || {};
  const b = s.byOverall || {};

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 12 }}>{allSummaryText(s)}</div>
        <div style={{ flex: 1 }} />
        <button className="tab" style={{ flex: 'none', padding: '4px 10px' }} disabled={busy} onClick={savePdf}>📄 세부 보고서 PDF</button>
      </div>
      {msg && <div className="card muted" style={{ fontSize: 12, padding: 8, marginBottom: 6 }}>{msg}</div>}

      {/* '전부 이상 없음' 이라고 말할 수 없는 조건을 **먼저** 밝힌다. */}
      {(s.missing || b.unknown || s.uncheckedItems) ? (
        <div className="card" style={{ fontSize: 12, lineHeight: 1.9, borderColor: 'var(--amber)', marginBottom: 8 }}>
          <b>점검하지 못한 부분이 있습니다 — '전부 이상 없음' 으로 결론 내리지 마세요.</b>
          {s.missing ? <div>· 수집된 스냅샷이 없어 점검 대상에서 빠진 스위치 <b>{s.missing}대</b> — 먼저 수집하세요.</div> : null}
          {b.unknown ? <div>· 판정 가능한 항목이 하나도 없던 스위치 <b>{b.unknown}대</b>.</div> : null}
          {s.uncheckedItems ? <div>· 확인 불가 항목 합계 <b>{s.uncheckedItems}개</b>(명령 없음·실행 실패·형식 미인식).</div> : null}
        </div>
      ) : null}

      <div className="table-wrap" style={{ maxHeight: '46vh', overflow: 'auto' }}>
        <STable>
          <thead><tr><th>스위치</th><th>법인</th><th>판정</th><th>확인 불가</th><th>내용</th><th data-nosort>상세</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const v = deviceVerdict(r);
              const isOpen = open === r.deviceId;
              return (
                <React.Fragment key={r.deviceId}>
                  <tr>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{r.name}</b><div className="muted" style={{ fontSize: 10.5 }}>{r.host}{r.agent ? ` · 엣지 ${r.agent}` : ''}</div></td>
                    <td className="muted">{r.datacenterName || '—'}</td>
                    {/* 종합 판정은 deviceVerdict 의 라벨·색을 쓴다 — '정상(일부 미확인)' 을 초록으로
                        보여주지 않기 위해서다. 정렬 키는 등급+미확인 여부(정상끼리도 갈린다). */}
                    <td data-sort={`${r.overall}${r.uncheckedCount ? '-u' : ''}`}><StatusBadge status={r.overall} label={v.label} color={v.color} /></td>
                    <td data-sort={String(r.uncheckedCount ?? 0)} style={{ textAlign: 'right', color: r.uncheckedCount ? COLOR.amber : COLOR.muted }}>{r.uncheckedCount ?? 0}</td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: 360 }}>{v.text}</td>
                    <td><button className="tab" style={{ padding: '2px 8px' }} onClick={() => setOpen(isOpen ? null : r.deviceId)}>{isOpen ? '접기' : '보기'}</button></td>
                  </tr>
                  {isOpen && <tr><td colSpan={6}><ItemTable items={r.items || []} /></td></tr>}
                </React.Fragment>
              );
            })}
            {!rows.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>점검할 스냅샷이 없습니다 — 먼저 수집하세요.</td></tr>}
          </tbody>
        </STable>
      </div>

      {(data.missing || []).length ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          점검 제외(스냅샷 없음): {(data.missing || []).map((m) => m.name || m.deviceId).join(', ')}
        </div>
      ) : null}
    </div>
  );
}
