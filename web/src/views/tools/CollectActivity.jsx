import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import {
  resultBadge, sourceLabel, hasDetail, detailLines,
  durationText, errorBlock, inFlightText, intervalText, countFailures,
} from './collectActivityText.js';

/**
 * views/tools/CollectActivity.jsx — 수집 '작업 로그' 패널 **공용 컴포넌트**(v2.516).
 *
 * 사용자 요구(2026-09-15): "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그 보여주는 기능 추가"
 * + "실패일때 클릭하면 구체적인 로그 보여주는 기능 추가".
 *
 * 왜 공용인가: 스토리지가 v2.315 에 먼저 가진 `ActivityPanel` 을 SAN 스위치도 요구받았다.
 * 복사하면 두 패널의 폴링 주기·문구·표 규약이 갈라진다(이 저장소는 `console/`↔`version_3/`
 * 중복으로 v2.506 svcmon 버그를 두 곳에 고쳐야 했다). 도메인마다 다른 것은 **API 경로와
 * 수치 열**뿐이므로 그 둘만 주입받는다. 서버도 같은 응답 형태를 지킨다
 * (`/tools/storage/activity` · `/tools/sanswitch/activity` — `{poller, events}`).
 *
 * ── 반드시 지킬 것 ──────────────────────────────────────────────────────────
 *  · **훅은 조기 return 위에** (React #310 — v2.202 실제 크래시).
 *  · **실패 사유를 툴팁에만 두지 말 것** — 클릭해 펼치는 경로를 유지한다. v2.515 까지 `title`
 *    뿐이라 복사·공유가 안 되고 모바일에서는 볼 수도 없었다(사용자가 그래서 요청했다).
 *  · **폴링은 5초, 언마운트 시 정지.** 이 응답은 인메모리 링버퍼 조회라 가볍다(DB·장비 왕복 없음).
 *  · 주기·상한 **숫자를 문구에 박지 말 것** — `poller.intervalMs` 가 주는 값만 쓴다(CLAUDE.md).
 */

const POLL_MS = 5000;

export default function CollectActivity({
  path,                 // 예: '/tools/storage/activity'
  title = '📋 수집 작업',
  metricCols = [],      // [{ key, label, align?, render:(evt)=>node, sort?:(evt)=>string }]
  emptyText = '아직 수집 기록이 없습니다.',
}) {
  const [a, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);      // 펼친 이벤트 키
  const [onlyFail, setOnlyFail] = useState(false);

  useEffect(() => {
    let live = true; let timer = 0;
    const load = () => fetchJson(path)
      .then((r) => { if (live) { setA(r); setErr(null); } })
      // 폴링 오류로 패널을 지우지 않는다 — 직전 데이터를 유지하고 사유만 적는다(고RTT 깜빡임 방지).
      .catch((e) => { if (live) setErr(e.message); })
      .finally(() => { if (live) timer = setTimeout(load, POLL_MS); });
    load();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [path]);

  // `a?.events || []` 를 useMemo 의존성에 직접 쓰면 매 렌더 새 배열이라 memo 가 무의미하다
  // (eslint react-hooks/exhaustive-deps 경고). 응답 객체 참조를 의존성으로 쓴다.
  const events = useMemo(() => a?.events || [], [a]);
  const failures = useMemo(() => countFailures(events), [events]);
  const shown = onlyFail ? events.filter((e) => !e.ok) : events;

  if (!a && !err) return null;                  // 첫 응답 전 — 자리만 비운다(스켈레톤 불필요)

  const inFlight = a?.poller?.inFlight || [];
  const hms = (ts) => { try { return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }); } catch { return '—'; } };
  const keyOf = (e, i) => `${e.deviceId}-${e.at}-${i}`;

  return (
    <div className="card" style={{ padding: 14, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <b style={{ fontSize: 14 }}>{title}</b>
        <span className="flex gap" style={{ alignItems: 'center', gap: 8 }}>
          {/* 실패가 0건이면 필터를 켤 이유가 없으므로 버튼을 숨긴다(쓸모없는 버튼 금지). */}
          {failures > 0 && (
            <button type="button" className={onlyFail ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '3px 10px', fontSize: 11.5 }}
              title="실패한 수집만 추려 봅니다" onClick={() => setOnlyFail((v) => !v)}>
              ⚠ 실패만 {failures}건
            </button>
          )}
          <span className="muted" style={{ fontSize: 11 }}>⟳ 5초 자동갱신 · 주기 {intervalText(a?.poller?.intervalMs)}</span>
        </span>
      </div>

      {/* 폴링 오류는 배너로만 — 직전 데이터를 지우지 않는다(CLAUDE.md 웹 폴링 뷰 오류 처리). */}
      {err && <div style={{ color: 'var(--amber)', fontSize: 12, marginBottom: 8 }}>⚠ 작업 로그 조회 실패(재시도 중): {err}</div>}

      {/* 진행중 */}
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: inFlight.length ? 6 : 10 }}>
        ▸ 진행중{' '}
        {inFlight.length
          ? <span className="badge" style={{ background: 'rgba(245,158,11,.2)', color: 'var(--amber)' }}>{inFlightText(inFlight.length)}</span>
          : <span className="muted" style={{ fontWeight: 400 }}>— {inFlightText(0)}</span>}
      </div>
      {inFlight.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12 }}>
          {inFlight.map((f) => (
            <div key={f.id} className="muted" style={{ padding: '2px 0' }}>
              <span style={{ color: 'var(--text)' }}>{f.name}</span> — 수집 중…
              {f.at ? <span style={{ fontSize: 11 }}> (시작 {hms(f.at)})</span> : null}
            </div>
          ))}
        </div>
      )}

      {/* 완료(최근) */}
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-dim)', margin: '4px 0 6px' }}>
        ▸ 완료 <span className="muted" style={{ fontWeight: 400 }}>
          (최근 {events.length}건{onlyFail ? ` · 실패 ${shown.length}건만 표시 중` : ''})
        </span>
      </div>
      <div className="table-wrap" style={{ maxHeight: '32vh' }}>
        <STable>
          <thead>
            <tr>
              <th>시각</th><th>장비</th><th>출처</th><th>결과</th>
              {metricCols.map((c) => <th key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.label}</th>)}
              <th style={{ textAlign: 'right' }}>소요</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6 + metricCols.length} className="center muted" style={{ padding: 16 }}>
                {onlyFail ? '실패한 수집이 없습니다.' : emptyText}
              </td></tr>
            )}
            {shown.map((e, i) => {
              const k = keyOf(e, i);
              const rb = resultBadge(e.ok);
              const src = sourceLabel(e.source);
              const eb = errorBlock(e.error);
              const expandable = hasDetail(e);
              const isOpen = open === k;
              return (
                <React.Fragment key={k}>
                  <tr>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }} data-sort={String(e.at || '')}>{hms(e.at)}</td>
                    <td><b>{e.name}</b>{e.host ? <div className="muted" style={{ fontSize: 10.5 }}>{e.host}</div> : null}</td>
                    <td data-sort={src.text}>{src.edge
                      ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{src.text}</span>
                      : <span className="muted">{src.text}</span>}</td>
                    <td data-sort={e.ok ? '1' : '0'}>
                      {/* 실패는 **클릭 가능한 버튼** — 툴팁만으로는 복사·공유가 안 되고 모바일에서 볼 수 없다. */}
                      {expandable
                        ? <button type="button" className={`badge ${rb.cls}`} style={{ cursor: 'pointer', border: 0 }}
                            title={isOpen ? '접기' : '클릭하면 이 수집의 상세 로그를 펼칩니다'}
                            onClick={() => setOpen(isOpen ? null : k)}>{rb.text} {isOpen ? '▴' : 'ⓘ'}</button>
                        : <span className={`badge ${rb.cls}`}>{rb.text}</span>}
                    </td>
                    {metricCols.map((c) => (
                      <td key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}
                        data-sort={c.sort ? c.sort(e) : undefined} className={c.muted ? 'muted' : undefined}>
                        {c.render(e)}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right' }} className="muted" data-sort={String(e.durationMs ?? '')}>{durationText(e.durationMs) || '—'}</td>
                    <td className="muted" style={{ fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{eb.text}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6 + metricCols.length} style={{ background: 'rgba(96,165,250,.05)' }}>
                        <div style={{ padding: '8px 4px', fontSize: 12 }}>
                          <div className="flex gap wrap" style={{ gap: 14, marginBottom: eb.text ? 8 : 0 }}>
                            {detailLines(e, { metrics: metricCols.filter((c) => c.detail).map((c) => ({ label: c.label, value: c.detail(e) })) })
                              .map((l) => <span key={l.label} className="muted">{l.label} <b style={{ color: 'var(--text)', fontWeight: 600 }}>{l.value}</b></span>)}
                          </div>
                          {eb.text
                            ? <>
                              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>수집 오류 원문</div>
                              {/* 선택·복사가 되도록 pre 로 — 사용자가 사유를 붙여 문의할 수 있어야 한다. */}
                              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, color: 'var(--red)' }}>{eb.text}</pre>
                              {eb.truncated && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>ℹ {eb.note}</div>}
                            </>
                            : <div className="muted" style={{ fontSize: 11.5 }}>이 수집은 정상이라 오류 원문이 없습니다.</div>}
                        </div>
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
  );
}
