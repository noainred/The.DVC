/**
 * 리눅스 베어메탈 통합 성능 — **서버 상세**(2단계 화면 · 설계 §5 ② · ③ 400 폭).
 *
 * 머리(판정 배지 · 경로 · 두 경로 읽은 시각 · 커버리지) → 판정 띠(서버 판정 한 줄 + 교차 판정 후보) → 탭(요약 · 자원 · 하드웨어).
 * ⚠ 탭은 **지금 데이터가 있는 것만** 둔다(`DETAIL_TABS`) — 장애 기록 · 튜닝 · 용도 · 스냅샷 · 추이는 그 기능이 생길 때 더한다.
 * ⚠ 조회는 서버를 고를 때 1회 + ‘다시 읽기’ 버튼(폴링 금지) · 늦게 온 다른 서버 응답은 버린다 · 403 은 ErrorBox(권한 안내).
 * ⚠ 판정·문구는 서버(`useJudge.js`)와 `bmPerfText.js` 가 소유한다 — 이 파일은 조립만.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { VerdictBadge, StateChips } from './BmPerfBoard.jsx';
import {
  RES_ORDER, RES_LABEL, USE_KEYS, USE_LABEL, HW_USE_LABEL, cellView, cellFootnotes, verdictView, coverageView, rowStates, STATE_TEXT,
  mismatchText, readText, crossView, crossBandText, thresholdText, basisText, evidenceRows, DETAIL_TABS, detailNotes, pathAtText,
  hwFactRows, detailErrorText, numText, hwEmptyText,
} from './bmPerfText.js';

function CodeText({ code }) {
  const v = cellView(code);
  return (
    <span style={{ color: v.judged ? toneVar(v.tone) : 'var(--text-faint)', whiteSpace: 'nowrap' }} title={v.title}>
      {v.judged ? v.text : `—${v.mark}`}{!v.judged && <span style={{ fontSize: 11 }}> {v.title}</span>}
    </span>
  );
}

/** 칸 하나(U·S·E) — 판정 code · 근거 입력들(값 · 기준값). */
function UseRow({ k, cell, th, hw = false }) {
  if (!cell) return null;
  return (
    <div className="bmp-use-row">
      <div className="bmp-use-k">{hw ? HW_USE_LABEL[k] : `${USE_LABEL[k]} ${k}`}</div>
      <div style={{ minWidth: 0 }}>
        <CodeText code={cell.code} />
        {(cell.basis || []).map((b, i) => {
          const thr = thresholdText(b.key, th);
          return (
            <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
              · {basisText(b)}{b.code && b.code !== cell.code && cellView(b.code).judged ? ` (${cellView(b.code).text})` : ''}
              {thr && <span style={{ color: 'var(--text-faint)' }}> — 기준 {thr}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Face({ res, entry, th, perfCols, children }) {
  const c = entry?.cells?.[res];
  const pr = verdictView(entry?.perResource?.[res]);
  const ev = evidenceRows(perfCols, entry?.values || {}, res);
  return (
    <div className="bmp-face">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <h5 style={{ margin: 0, fontSize: 14 }}>{RES_LABEL[res]}{res === 'hw' ? '(iDRAC)' : ''}</h5>
        <span className="bmp-badge" style={{ color: toneVar(pr.tone), borderColor: toneVar(pr.tone) }}>{pr.label}</span>
      </div>
      {c ? USE_KEYS.map((k) => <UseRow key={k} k={k} cell={c[k]} th={th} hw={res === 'hw'} />)
        : <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>근거 상세가 없습니다(아래 안내 참조) — 칸 판정은 요약 탭에 있습니다.</p>}
      {!!ev.length && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>근거 열(판정에 쓰지 않는 값)</div>
          <div className="bmp-ev">
            {ev.map((x) => <div key={x.col} style={{ minWidth: 0 }}><span style={{ color: 'var(--muted)' }}>{x.label}</span> {x.text}</div>)}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

export default function BmPerfDetail({ itemKey, item = null, authStops = [], staleMs = null, onClose }) {
  // ⚠ 훅은 전부 조기 return 위에.
  const [resp, setResp] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('summary');
  const gen = useRef(0);
  const rootRef = useRef(null);
  const load = useCallback(async (key) => {
    const g = ++gen.current;
    setLoading(true); setErr(null);
    try {
      const d = await fetchJson(`/tools/bm-usage/perf/${encodeURIComponent(key)}`);
      if (g === gen.current) setResp(d);
    } catch (e) {
      if (g === gen.current) { setResp(null); setErr(e); }
    } finally { if (g === gen.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!itemKey) return;
    setResp(null); setTab('summary');
    load(itemKey);
    try { rootRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); } catch { /* 스크롤 실패는 무시 */ }
  }, [itemKey, load]);

  if (!itemKey) return null;
  const sameKey = resp && (resp.key === itemKey);
  const entry = sameKey ? resp.entry : null;
  const target = (sameKey && resp.target) || item?.target || {};
  const th = (sameKey && resp.perfThresholds) || item?.th || null;
  const name = target.name || item?.name || itemKey;
  const states = rowStates(entry || item?.entry || null, { ...target, key: item?.key || itemKey }, { authStops, snapAt: resp?.snapAt ?? item?.snapAt, staleMs });
  const cov = coverageView((entry || item?.entry)?.coverage);
  const e = entry || null;
  const errIs403 = !!err && err.status === 403;
  const notes = sameKey ? detailNotes(resp) : [];
  const mm = e ? mismatchText(e.mismatch, th) : '';
  const usedCodes = [];
  if (e?.codes) for (const r of RES_ORDER) for (const k of USE_KEYS) usedCodes.push(e.codes[r]?.[k]);

  return (
    <div ref={rootRef} className="card bmp-detail" style={{ minWidth: 0 }}>
      {/* ── 머리 ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h4 style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</h4>
        {e && <VerdictBadge verdict={e.verdict} />}
        <span className="bmp-chip" style={{ color: e ? toneVar(cov.tone) : 'var(--muted)' }}>경로 {e ? cov.label : '—'}</span>
        <span style={{ flex: '1 1 auto' }} />
        <button className="btn btn-sm bmp-touch" onClick={() => load(itemKey)} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
        {onClose && <button className="btn btn-sm bmp-touch" onClick={onClose}>닫기</button>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 4 }}>
        {[target.serviceTag && `서비스 태그 ‘${target.serviceTag}’`, target.vcenterId || '귀속 없음', target.model, item?.agent && `엣지 ${item.agent}`].filter(Boolean).join(' · ')}
      </div>
      {e && (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          {pathAtText(e, target.paths || [])}{readText(e.read) ? ` · ${readText(e.read)}` : ''}
        </div>
      )}
      {notes.map((x, i) => <p key={i} style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}><BoldText text={x} /></p>)}

      {errIs403 && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      {err && !errIs403 && <p style={{ margin: '8px 0 0', fontSize: 12, color: toneVar('bad'), lineHeight: 1.6 }}>{detailErrorText(err)}</p>}
      {!resp && !err && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted)' }}>성능 상세를 불러오는 중…</p>}
      {sameKey && !e && !err && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>이 서버의 성능 판정 항목이 없습니다 — 위 안내가 이유를 말합니다.</p>}

      {/* ── 상태(9종 중 해당하는 것) ── */}
      {!!states.length && (
        <div className="bmp-states">
          {states.map((s) => {
            const st = STATE_TEXT[s];
            if (!st) return null;
            return (
              <div key={s} className="bmp-state" style={{ borderLeftColor: toneVar(st.tone) }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{st.title}</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}><BoldText text={st.body} /></div>
              </div>
            );
          })}
        </div>
      )}

      {e && (
        <>
          {/* ── 판정 띠 ── */}
          <div className="bmp-verdict" style={{ borderLeftColor: toneVar(verdictView(e.verdict).tone) }}>
            <div style={{ fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{e.line}</div>
            {crossBandText(e.crossDetail || e.cross).map((c, i) => <div key={i} style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={`→ ${c}`} /></div>)}
            {mm && <div style={{ fontSize: 12, lineHeight: 1.6, color: toneVar('warn') }}>{mm}</div>}
          </div>

          {/* ── 탭 ── */}
          <div className="bmp-seg" role="tablist">
            {DETAIL_TABS.map((x) => (
              <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)}>{x.label}</button>
            ))}
          </div>

          {tab === 'summary' && (
            <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
              <STable minWidth={420}>
                <thead><tr><th>자원</th><th>U</th><th>S</th><th>E</th><th>자원 판정</th></tr></thead>
                <tbody>
                  {RES_ORDER.map((r) => (
                    <tr key={r}>
                      <td data-sort={r}>{RES_LABEL[r]}{r === 'hw' ? '(iDRAC)' : ''}</td>
                      {USE_KEYS.map((k) => <td key={k} data-sort={cellView(e.codes?.[r]?.[k]).sort}>{r === 'hw' && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{HW_USE_LABEL[k]} </span>}<CodeText code={e.codes?.[r]?.[k] || 'missing'} /></td>)}
                      <td data-sort={verdictView(e.perResource?.[r]).rank}><span style={{ color: toneVar(verdictView(e.perResource?.[r]).tone) }}>{verdictView(e.perResource?.[r]).label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {cellFootnotes(usedCodes).map((f, i) => <p key={i} style={{ margin: 0, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={f} /></p>)}
              <div>
                <h5 style={{ margin: '0 0 4px', fontSize: 14 }}>교차 판정 — 두 경로가 다 읽혀야 켜집니다 · 상관은 ‘후보’ 로만</h5>
                <div className="bmp-cross">
                  {(e.crossDetail || e.cross || []).map((x) => {
                    const v = crossView(x);
                    return (
                      <div key={x.id} className="bmp-cross-item">
                        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <b>{v.no}</b><span style={{ fontSize: 13 }}>{v.title || '(상세 생략)'}</span>
                          <span className="bmp-chip" style={{ color: toneVar(v.tone) }}>{v.stateLabel}</span>
                        </div>
                        {!!v.evidence.length && <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>{v.evidence.join(' · ')}</div>}
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={v.conclusion} /></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'res' && (
            <div className="bmp-faces">
              <Face res="cpu" entry={e} th={th} perfCols={resp?.perfCols}>
                {e.detail && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-dim)' }}>코어 {numText(e.detail.cores)} · 실행 중 {numText(e.detail.procsRunning)} · 스레드 {numText(e.detail.threads)}</div>}
                {mm && <div style={{ fontSize: 12, marginTop: 4, color: toneVar('warn'), lineHeight: 1.6 }}>{mm}</div>}
              </Face>
              <Face res="mem" entry={e} th={th} perfCols={resp?.perfCols} />
              <Face res="disk" entry={e} th={th} perfCols={resp?.perfCols}>
                {Array.isArray(e.detail?.disks) && e.detail.disks.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <STable minWidth={420} style={{ fontSize: 12 }}>
                      <thead><tr><th>장치</th><th className="right">busy</th><th className="right">IOPS</th><th className="right">await</th><th className="right">대기열</th><th className="right">in-flight</th></tr></thead>
                      <tbody>
                        {e.detail.disks.map((d) => (
                          <tr key={d.name}>
                            <td data-sort={d.name}>{d.name}</td>
                            <td className="right" data-sort={d.busyPct ?? ''}>{numText(d.busyPct, '%')}</td>
                            <td className="right" data-sort={d.iops ?? ''}>{numText(d.iops)}</td>
                            <td className="right" data-sort={d.awaitMs ?? ''}>{numText(d.awaitMs, 'ms')}</td>
                            <td className="right" data-sort={d.aqu ?? ''}>{numText(d.aqu)}</td>
                            <td className="right" data-sort={d.inFlight ?? ''}>{numText(d.inFlight)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                    {Number(e.detail.disksTotal) > e.detail.disks.length && <div style={{ fontSize: 11, color: 'var(--muted)' }}>장치 {e.detail.disksTotal}개 중 앞 {e.detail.disks.length}개만 실었습니다(상한).</div>}
                  </div>
                )}
              </Face>
              <Face res="net" entry={e} th={th} perfCols={resp?.perfCols}>
                {Array.isArray(e.detail?.nics) && e.detail.nics.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <STable minWidth={420} style={{ fontSize: 12 }}>
                      <thead><tr><th>인터페이스(물리)</th><th className="right">드롭 rx/tx</th><th className="right">오류 rx/tx</th><th>상태</th></tr></thead>
                      <tbody>
                        {e.detail.nics.map((x) => (
                          <tr key={x.iface}>
                            <td data-sort={x.iface}>{x.iface}</td>
                            <td className="right" data-sort={x.dropDelta ?? ''}>{numText(x.rxDropDelta)} / {numText(x.txDropDelta)}</td>
                            <td className="right" data-sort={x.errDelta ?? ''}>{numText(x.rxErrDelta)} / {numText(x.txErrDelta)}</td>
                            <td data-sort={x.state || ''}>{x.state || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>드롭·오류는 이번 주기 증가분입니다. 가상 인터페이스(veth·bridge)는 회선 드롭이 아니라 뺐습니다.</div>
                  </div>
                )}
              </Face>
            </div>
          )}

          {tab === 'hw' && (
            <div className="bmp-faces">
              <Face res="hw" entry={e} th={th} perfCols={resp?.perfCols} />
              <div className="bmp-face">
                <h5 style={{ margin: '0 0 6px', fontSize: 14 }}>하드웨어 사실(이미 가진 데이터 — Redfish 추가 호출 없음)</h5>
                {e.hw ? (
                  <>
                    <div className="bmp-kv">
                      {hwFactRows(e.hw).map((r) => (
                        <React.Fragment key={r.label}>
                          <div style={{ color: 'var(--muted)' }}>{r.label}</div>
                          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><BoldText text={r.text} /></div>
                        </React.Fragment>
                      ))}
                    </div>
                    {Array.isArray(e.hw.faults) && e.hw.faults.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <STable minWidth={360} style={{ fontSize: 12 }}>
                          <thead><tr><th>종류</th><th>부품</th><th>상태</th></tr></thead>
                          <tbody>
                            {e.hw.faults.map((f, i) => (
                              <tr key={`${f.kind}|${f.label}|${i}`}>
                                <td data-sort={f.kind}>{f.kind}</td><td data-sort={f.label}>{f.label}</td>
                                <td data-sort={f.state}><span style={{ color: toneVar(f.state === 'fault' ? 'bad' : f.state === 'warn' ? 'warn' : 'idle') }}>{f.state === 'fault' ? '장애' : f.state === 'warn' ? '경고' : f.state}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </STable>
                        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>부품 장애 모듈의 판정을 그대로 가져왔습니다(복제하지 않음).</div>
                      </div>
                    )}
                  </>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
                    <BoldText text={hwEmptyText(states)} />
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
