import React, { useEffect, useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { hostText } from './addressHiddenText.js'; // v2.599: 비-admin 에는 관리 주소가 가려져 온다 — 빈 칸 대신 '—'
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { STATUS_LABEL, STATUS_MARK, stageLabel, stamp, deviceVerdict, allSummaryText,
  sortResults, baselineNote, deviceReportDoc, allReportDoc, reportFileName,
  portVerdict, opticalText, errorText, portCheckSummary, portBaselineNote, problemPortText, sideText,
  problemOmittedNote, portZoningFallback,
  cmdText, cmdNote, changeLabel, compareSummary, recordNote, hasUncheckedPart, failedNamesText } from './sanHealthText.js';

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
                        <td>
                          <code style={{ fontSize: 11, color: i.usedAlt ? tone('amber') : undefined }}>{cmdText(i)}</code>
                          {/* ⚠ 대체 명령을 썼으면 반드시 말한다 — 출력이 원 명령과 같지 않을 수 있다(v2.522) */}
                          {i.usedAlt && <div className="muted" style={{ fontSize: 10.5, whiteSpace: 'normal' }}><BoldText text={cmdNote(i)} /></div>}
                        </td>
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
/**
 * **전 포트 점검 표**(v2.521 — 사용자 요청 "모든 포트에 대해서 점검").
 *
 * ⚠ `링크 없음` 포트는 광량 판정에서 뺐다 — 그 사실을 표와 요약이 **말한다**(조용히 빼면
 *   '전 포트를 봤다' 는 거짓이 된다). 신고된 거짓 경보(-27 dBm 인데 빈 포트)의 원인이었다.
 * ⚠ 훅은 조기 return 위에(React #310).
 */
function PortCheckTable({ pc, problems, zoningNote, omitted }) {
  const [open, setOpen] = useState(null);
  const [onlyBad, setOnlyBad] = useState(true);
  const probByIndex = useMemo(() => new Map((problems || []).map((p) => [p.index, p])), [problems]);
  const rows = useMemo(() => {
    const list = (pc?.rows || []).filter((r) => (!onlyBad || r.verdict === 'bad' || r.verdict === 'warn' || r.verdict === 'unknown'));
    const ord = ['bad', 'warn', 'unknown', 'ok'];
    return [...list].sort((a, b) => ord.indexOf(a.verdict) - ord.indexOf(b.verdict) || a.index - b.index);
  }, [pc, onlyBad]);
  if (!pc?.rows?.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>전 포트 점검</div>
        <button className={onlyBad ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '2px 9px', fontSize: 11 }} onClick={() => setOnlyBad(!onlyBad)}>
          {onlyBad ? '문제만 보는 중' : '전체 보는 중'}
        </button>
        <div className="muted" style={{ fontSize: 11.5 }}>{portCheckSummary(pc)}</div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}><BoldText text={portBaselineNote(pc)} /></div>
      {problemOmittedNote(omitted) && <div style={{ fontSize: 11.5, marginBottom: 6, color: COLOR.amber }}>⚠ {problemOmittedNote(omitted)}</div>}
      <div className="table-wrap">
        <STable className="v3-table" minWidth={760} wrap={false}>
          <thead>
            <tr><th>포트</th><th>판정</th><th>상태</th><th>연결 장비</th><th>광량(Rx)</th><th>에러</th><th data-nosort>세부</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.index}>
                <tr>
                  <td data-sort={String(r.index)}>{r.index}{r.slotPort ? ` (${r.slotPort})` : ''}</td>
                  <td data-sort={r.verdict}><StatusBadge status={r.verdict} label={portVerdict(r.verdict).label} color={portVerdict(r.verdict).color} /></td>
                  <td data-sort={r.state}>{r.stateRaw || r.state}</td>
                  <td style={{ fontSize: 11.5 }}>{r.name || '—'}</td>
                  <td data-sort={String(r.rxPowerDbm ?? 999)}>{opticalText(r)}</td>
                  <td data-sort={String(r.errNew ?? r.errSum ?? -1)}>{errorText(r)}</td>
                  <td>
                    {(r.reasons?.length || probByIndex.has(r.index))
                      ? <button className="tab" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => setOpen(open === r.index ? null : r.index)}>{open === r.index ? '접기' : '보기'}</button>
                      : <span className="muted">—</span>}
                  </td>
                </tr>
                {open === r.index && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--panel)' }}>
                      <PortDetail row={r} prob={probByIndex.get(r.index)} zoningNote={zoningNote} omitted={omitted} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">{onlyBad ? '이상·주의·확인 불가 포트가 없습니다.' : '표시할 포트가 없습니다.'}</td></tr>}
          </tbody>
        </STable>
      </div>
    </div>
  );
}

/** 포트 1개의 판정 근거 + **어떤 서버인지 · 어디와 조닝되어 있는지**(v2.521 사용자 요청). */
function PortDetail({ row, prob, zoningNote, omitted }) {
  return (
    <div style={{ display: 'grid', gap: 8, padding: '8px 4px', minWidth: 0 }}>
      {!!row.reasons?.length && (
        <div>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>판정 근거</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {row.reasons.map((x, i) => <li key={i} style={{ whiteSpace: 'normal' }}>{x}</li>)}
          </ul>
        </div>
      )}
      {!!row.causes?.length && (
        <div>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>에러 종류별 원인</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {row.causes.map((c) => <li key={c.key} style={{ whiteSpace: 'normal' }}><code>{c.label}</code> {c.total}건 → {c.cause}</li>)}
          </ul>
        </div>
      )}
      <div>
        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 3 }}>연결 장비 · 조닝</div>
        {!prob && <div className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{portZoningFallback(row, zoningNote, omitted)}</div>}
        {prob && (
          <>
            <div className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{problemPortText(prob, zoningNote)}</div>
            {!!prob.wwns?.length && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                {prob.wwns.map((w) => (
                  <li key={w.wwn} style={{ whiteSpace: 'normal' }}>
                    <b>{w.label}</b> <code style={{ fontSize: 11 }}>{w.wwn}</code>
                    {w.vendor ? ` · ${w.vendor}` : ''} · {sideText(w)}
                  </li>
                ))}
              </ul>
            )}
            {(prob.zones || []).map((z) => (
              <div key={z.name} style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>zone {z.name} <span className="muted" style={{ fontWeight: 400 }}>(멤버 {z.memberCount})</span></div>
                <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.7 }}>
                  {(z.partners || []).map((p) => (
                    <li key={p.wwn} style={{ whiteSpace: 'normal' }}>↔ <b>{p.label}</b> <code style={{ fontSize: 11 }}>{p.wwn}</code> · {sideText(p)}</li>
                  ))}
                  {!!z.partnersOmitted && <li className="muted">↔ … {z.partnersOmitted}개 생략</li>}
                  {!z.partners?.length && <li className="muted">이 zone 에 다른 멤버가 없습니다(단독 zone).</li>}
                </ul>
              </div>
            ))}
            {!!prob.zonesOmitted && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>zone {prob.zonesOmitted}개는 생략했습니다.</div>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * **최근 N회 점검 비교**(v2.522 — 사용자 요청 "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교").
 *
 * ⚠ '지난달과 비슷하다' 같은 뭉갠 말을 하지 않는다 — 새로 생긴 문제·해소된 문제·확인 불가로
 *   바뀐 항목을 **각각** 센다(`compareSummary`).
 * ⚠ `확인 불가 → 정상` 은 '호전' 이 아니라 **'이제 확인됨'** 이다(명령이 생겼거나 권한이 바뀐 것).
 * ⚠ 기록은 '수집 1회 = 1건' 이다 — 탭을 열 때마다 쌓이면 '최근 10회' 가 같은 값 10개가 된다.
 */
function HistoryPanel({ history }) {
  const [open, setOpen] = useState(false);
  const c = history?.compare;
  if (!history) return null;
  if (history.available === false) {
    return (
      <div className="card muted" style={{ fontSize: 12, padding: 8, marginTop: 12 }}>
        점검 이력을 저장할 수 없습니다(이 런타임에서 내장 SQLite 를 쓸 수 없습니다{history.db?.error ? ` — ${history.db.error}` : ''}).
        현재 점검 결과는 보이지만 <b>최근 점검과의 비교는 되지 않습니다</b>.
      </div>
    );
  }
  const runs = history.runs || [];
  return (
    <div style={{ marginTop: 14 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>최근 점검 비교</div>
        <button className="tab" style={{ flex: 'none', padding: '2px 9px', fontSize: 11 }} onClick={() => setOpen(!open)}>
          {open ? '이력 접기' : `이력 ${runs.length}건 보기`}
        </button>
        <div className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}><BoldText text={compareSummary(c)} /></div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{recordNote(history.recorded)}</div>

      {!!c?.changes?.length && (
        <div className="table-wrap" style={{ marginBottom: 8 }}>
          <STable>
            <thead><tr><th>항목</th><th>변화</th><th>직전</th><th>이번</th><th>내용</th></tr></thead>
            <tbody>
              {c.changes.map((x) => {
                const cl = changeLabel(x.dir);
                return (
                  <tr key={x.key}>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{x.label}</b></td>
                    <td data-sort={x.dir} style={{ color: tone(cl.color), fontWeight: 600, whiteSpace: 'nowrap' }}>{cl.mark} {cl.label}</td>
                    <td data-sort={x.from}><StatusBadge status={x.from} /></td>
                    <td data-sort={x.to}><StatusBadge status={x.to} /></td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: 420 }}><BoldText text={x.detail || ''} /></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
      {!!c?.persistent?.length && (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 6, whiteSpace: 'normal' }}>
          ⚠ <b>{c.compared}회 내내 문제인 항목</b> — {c.persistent.map((p) => p.label).join(', ')}. 매달 같은 경고가 반복되고 있습니다.
        </div>
      )}
      {open && (
        <div className="table-wrap">
          <STable>
            <thead><tr><th>점검 시각</th><th>수집 시각</th><th>종합</th><th>이상</th><th>주의</th><th>확인 불가</th><th>정상</th><th>이상 포트</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td data-sort={String(r.at)}>{stamp(r.at)}</td>
                  <td data-sort={String(r.collectedAt || 0)}>{r.collectedAt ? stamp(r.collectedAt) : '—'}</td>
                  <td data-sort={r.overall}><StatusBadge status={r.overall} /></td>
                  <td data-sort={String(r.counts.bad)} style={{ color: r.counts.bad ? tone('red') : undefined }}>{r.counts.bad}</td>
                  <td data-sort={String(r.counts.warn)} style={{ color: r.counts.warn ? tone('amber') : undefined }}>{r.counts.warn}</td>
                  <td data-sort={String(r.counts.unknown)} style={{ color: r.counts.unknown ? tone('amber') : undefined }}>{r.counts.unknown}</td>
                  <td data-sort={String(r.counts.ok)}>{r.counts.ok}</td>
                  <td data-sort={String(r.ports?.bad ?? -1)}>{r.ports?.bad == null ? '—' : r.ports.bad}</td>
                </tr>
              ))}
              {!runs.length && <tr><td colSpan={8} className="muted">아직 기록된 점검이 없습니다 — 이번 점검부터 쌓입니다.</td></tr>}
            </tbody>
          </STable>
        </div>
      )}
    </div>
  );
}

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
      await saveDocAsPdf(
        deviceReportDoc(data.result, {
          baseline: data.baseline, ports: data.ports, problemPorts: data.problemPorts,
          zoningNote: data.zoningNote, history: data.history,
        }),
        reportFileName(data.result?.name || deviceName),
      );
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
      <PortCheckTable pc={data.ports} problems={data.problemPorts} zoningNote={data.zoningNote} omitted={data.problemPortsOmitted} />
      <HistoryPanel history={data.history} />
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
      {hasUncheckedPart(s) ? (
        <div className="card" style={{ fontSize: 12, lineHeight: 1.9, borderColor: 'var(--amber)', marginBottom: 8 }}>
          <b>점검하지 못한 부분이 있습니다 — '전부 이상 없음' 으로 결론 내리지 마세요.</b>
          {s.failed ? <div>· 점검 중 오류(스냅샷 형식 오류)로 빠진 스위치 <b>{s.failed}대</b> — {failedNamesText(data.failed)}</div> : null}
          {s.missing ? <div>· 수집된 스냅샷이 없어 점검 대상에서 빠진 스위치 <b>{s.missing}대</b> — 먼저 수집하세요.</div> : null}
          {b.unknown ? <div>· 판정 가능한 항목이 하나도 없던 스위치 <b>{b.unknown}대</b>.</div> : null}
          {s.uncheckedItems ? <div>· 확인 불가 항목 합계 <b>{s.uncheckedItems}개</b>(명령 없음·실행 실패·형식 미인식).</div> : null}
        </div>
      ) : null}

      <div className="table-wrap" style={{ maxHeight: '46vh', overflow: 'auto' }}>
        <STable minWidth={680} wrap={false}>
          <thead><tr><th>스위치</th><th>법인</th><th>판정</th><th>확인 불가</th><th>내용</th><th data-nosort>상세</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const v = deviceVerdict(r);
              const isOpen = open === r.deviceId;
              return (
                <React.Fragment key={r.deviceId}>
                  <tr>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{r.name}</b><div className="muted" style={{ fontSize: 10.5 }}>{hostText(r.host)}{r.agent ? ` · 엣지 ${r.agent}` : ''}</div></td>
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

      {/* v2.607 LEFT2607-03: 점검 중 오류로 빠진 스위치 — 이름과 사유를 조용히 빼지 않는다. */}
      {(data.failed || []).length ? (
        <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--amber)' }}>
          점검 실패(오류로 판정 제외):
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{(data.failed || []).slice(0, 50).map((f, i) => <li key={f.deviceId || i}>{f.name || f.deviceId}{f.reason ? ` — ${f.reason}` : ''}</li>)}</ul>
          {(data.failed || []).length > 50 ? <div className="muted">외 {(data.failed || []).length - 50}대</div> : null}
        </div>
      ) : null}
      {(data.missing || []).length ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          점검 제외(스냅샷 없음): {(data.missing || []).map((m) => m.name || m.deviceId).join(', ')}
        </div>
      ) : null}
    </div>
  );
}
