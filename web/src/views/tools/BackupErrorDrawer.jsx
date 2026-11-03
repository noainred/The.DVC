/**
 * Backup › Summary 통합 에러 로그의 로그 서랍(v2.871 · 시안 docs/design/bareos-errlog ①②④ · 사용자 컨펌 2026-11-04 '구현해').
 *   ErrorLogDrawer — 실패한 Bareos 실행 하나의 작업 로그(운영 화면 LogModal 과 같은 본문 JobLogPanel — 요약 · 타임라인 · 원문). ‹ › 로 지금 목록(따로 보기)
 *     또는 그 묶음(묶어 보기)의 다음 실행으로 옮긴다 · 늦게 온 이전 응답은 본문이 버린다 · '이력 →' 은 진행 · 이력에서 그 VM · jobid 를 연다.
 *   BulkLogDrawer — 같은 모양 묶음의 로그를 서버가 차례로 읽어(POST /tools/bareos-backup/logs/bulk — Director 세션 하나 · 15건) 첫 오류 줄을 대조한 결과.
 *     같은 원인인지는 이 대조로만 말한다(원장만으로는 모른다). 원문은 건마다 [로그] 로 낱건 서랍에서.
 *   좁은 폭(720px 이하)은 전체 화면 시트(styles.css .err-drawer). 문구에 백틱 금지 · 값이 없으면 '—'.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { JobLogPanel } from './BareosJobLog.jsx';
import { saveRunFocus } from './bareosViewText.js';
import { relayWaitMs } from './bareosText.js';
import { ERROR_KIND, mdhm, logJobOf, logDirOf, errorHistory, MATCH_TEXT, bulkLogItems, bulkSummaryText, BULK_LOG_MAX } from './backupSummaryPlan.js';

const Pill = ({ s, children }) => <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>{children ?? s.text}</span>;
const TONE = { bad: { color: '#fca5a5', bg: 'rgba(239,68,68,.16)' }, warn: { color: '#fcd34d', bg: 'rgba(245,158,11,.16)' }, muted: { color: 'var(--text-dim)', bg: 'rgba(139,155,180,.14)' } };
const HEAD = { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' };
const FOOT = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' };
const BTN = { padding: '4px 10px', fontSize: 12 };
const MONO = { fontFamily: 'var(--mono)', fontSize: 12 };

function goHistory(r) {
  saveRunFocus(r.vc, r.vmId, r.jobid);
  window.location.hash = '#/tools/bareos-backup/runs';
}

/** 실행 하나의 로그 서랍. list = ‹ › 로 옮길 실행들(로그를 읽을 수 있는 것만) · index = 지금. */
export function ErrorLogDrawer({ list, index, onIndex, onClose, limits = null, canBareos = false, scope = '' }) {
  const [mode, setMode] = useState('summary');
  const r = list[index];
  if (!r) return null;
  const n = list.length;
  const hist = errorHistory(r, { canBareos });
  const kind = ERROR_KIND[r.kind] || ERROR_KIND.fail;
  const onKey = (e) => { if (e.key === 'Escape') onClose(); };
  return (
    <aside className="err-drawer" aria-label="작업 로그 서랍" data-err-drawer="" onKeyDown={onKey}>
      <div style={HEAD}>
        <div style={{ minWidth: 0, flex: '1 1 0' }}>
          <div style={{ fontSize: 14, fontWeight: 800, overflowWrap: 'anywhere' }}>작업 로그 — jobid {r.jobid} · <span style={{ ...MONO, fontSize: 13 }}>{r.job || '—'}</span></div>
          <div className="flex wrap" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
            <Pill s={{ text: 'Bareos', color: '#5eead4', bg: 'rgba(20,184,166,.18)' }} />
            <Pill s={TONE.muted}>{r.vcName || '법인 모름'}{r.relay ? ' · 엣지 대행' : ''}</Pill>
            <Pill s={kind} />
            <span className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>VM {r.vm || '—'} · 끝 {mdhm(r.at)}{n > 1 ? ` · ${scope || '이 목록'} ${n}건 중 ${index + 1}번째` : ''}</span>
          </div>
        </div>
        <button type="button" className="logout-btn" style={BTN} onClick={onClose} aria-label="닫기">닫기</button>
      </div>
      <div style={{ flex: '1 1 0', overflow: 'auto', padding: '10px 16px 12px', minWidth: 0 }}>
        <JobLogPanel key={`${r.jobKey}|${r.jobid}`} job={logJobOf(r)} jobid={r.jobid} mode={mode} onMode={setMode} dir={logDirOf(r)} limits={limits} paneH="calc(100vh - 280px)" canRunFull={false} />
      </div>
      <div style={FOOT}>
        <button type="button" className="logout-btn" style={BTN} disabled={index <= 0} onClick={() => onIndex(index - 1)} aria-label="이전 실행">‹ 이전</button>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{n ? `${index + 1} / ${n}` : ''}</span>
        <button type="button" className="logout-btn" style={BTN} disabled={index >= n - 1} onClick={() => onIndex(index + 1)} aria-label="다음 실행">다음 ›</button>
        <span style={{ flex: '1 1 0' }} />
        {hist && <button type="button" className="logout-btn" style={BTN} onClick={() => goHistory(r)} title="진행 · 이력에서 이 VM 을 대상으로 고르고 이 실행의 로그를 연 채로 엽니다(Full 실행 · 복원 지점은 거기서)">이력에서 열기 →</button>}
      </div>
    </aside>
  );
}

/** 묶음 로그 서랍 — 같은 모양 묶음의 첫 오류 줄 대조. onOpenRow(row) = 건마다 [로그](낱건 서랍). */
export function BulkLogDrawer({ group, onClose, onOpenRow, limits = null }) {
  const { items, rows, more } = bulkLogItems(group);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(null);
  const gen = useRef(0);
  const relay = rows.some((x) => x.relay);
  const waitMs = Math.max(120_000, (relay ? relayWaitMs(limits, 'logs') : null) || 0);
  const key = items.map((x) => `${x.id}:${x.jobid}`).join(',');
  const load = useCallback(() => {
    if (!items.length) return;
    const my = ++gen.current;
    setBusy(true); setErr(null); setRes(null);
    postJson('/tools/bareos-backup/logs/bulk', { items }, { timeoutMs: waitMs, retries: 0 })
      .then((x) => { if (my === gen.current) { setRes(x); setAt(Date.now()); } })
      .catch((e) => { if (my === gen.current) setErr(e); })
      .finally(() => { if (my === gen.current) setBusy(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, waitMs]);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load]);
  const head = group?.head || {};
  const byKey = new Map((res?.items || []).map((x) => [`${x.id}:${x.jobid}`, x]));
  const s = res?.summary || null;
  return (
    <aside className="err-drawer" aria-label="묶음 로그 서랍" data-err-drawer="bulk" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div style={HEAD}>
        <div style={{ minWidth: 0, flex: '1 1 0' }}>
          <div style={{ fontSize: 14, fontWeight: 800, overflowWrap: 'anywhere' }}>묶음 로그 — {head.vcName || '법인 모름'} · {(ERROR_KIND[head.kind] || ERROR_KIND.fail).text} · {group?.n ?? 0}건</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, overflowWrap: 'anywhere' }}>
            {group?.target || '—'} · 실행 {rows.length}건의 작업 로그를 차례로 읽어 첫 오류 줄을 대조합니다(Director 세션 하나 · 한 번에 {BULK_LOG_MAX}건까지{relay ? ' · 엣지 대행 — 엣지가 한 작업으로' : ''})
          </div>
        </div>
        <button type="button" className="logout-btn" style={BTN} onClick={onClose} aria-label="닫기">닫기</button>
      </div>
      <div style={{ flex: '1 1 0', overflow: 'auto', padding: '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        {more > 0 && <div className="banner warn" style={{ fontSize: 12.5 }}>한 번에 {BULK_LOG_MAX}건까지 읽습니다 — 새것부터 {rows.length}건만 읽었습니다(나머지 {more}건은 낱건 로그로).</div>}
        {!items.length && <div className="muted" style={{ fontSize: 12.5 }}>이 묶음에는 로그를 읽을 수 있는 Bareos 실행이 없습니다.</div>}
        {busy && <div className="muted" style={{ fontSize: 12.5 }}><Loading /> 읽는 중 — {rows.length}건{relay ? ' · 엣지 회신 시한까지 기다립니다' : ''}</div>}
        {err && <ErrorBox error={err} />}
        {s && (
          <>
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, fontWeight: 700, fontSize: 13,
              border: `1px solid ${s.same ? 'rgba(239,68,68,.45)' : 'rgba(245,158,11,.45)'}`, background: s.same ? 'rgba(239,68,68,.10)' : 'rgba(245,158,11,.10)', color: s.same ? '#fca5a5' : '#fcd34d' }}>
              <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{bulkSummaryText(s)}</span>
            </div>
            {s.topLine && (
              <div style={{ border: '1px solid rgba(239,68,68,.35)', borderLeft: '3px solid #f87171', borderRadius: 8, background: 'var(--panel)', padding: '9px 12px', minWidth: 0 }}>
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>가장 많은 첫 오류 줄({s.same}건)</div>
                <div style={{ ...MONO, color: '#fca5a5', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{s.topLine}</div>
              </div>
            )}
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>건마다 — 첫 오류 줄(VM 이름 · 숫자는 지우고 비교)</div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, minWidth: 0 }}>
              {rows.map((r) => {
                const x = byKey.get(`${r.jobKey}:${r.jobid}`);
                const m = MATCH_TEXT[x?.match] || MATCH_TEXT.unread;
                const line = x?.ok ? (x.firstError || '오류 줄 없음 — 로그에 Fatal error · Error 줄이 없습니다') : (x?.reason || '읽지 못했습니다');
                return (
                  <div key={`${r.jobKey}|${r.jobid}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, minWidth: 0, flexWrap: 'wrap' }}>
                    <span style={{ ...MONO, fontSize: 11.5, minWidth: 0, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${r.vm || ''} · ${r.job || ''}`}>{r.vm || r.job} · {r.jobid}</span>
                    <Pill s={TONE[m.tone] || TONE.muted}>{m.text}</Pill>
                    <span title={line} style={{ flex: '1 1 220px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: x?.ok ? 'var(--text-dim)' : 'var(--text-faint)' }}>{line}</span>
                    <button type="button" className="logout-btn" style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => onOpenRow(r)}>로그</button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div style={FOOT}>
        <span className="muted" style={{ fontSize: 11.5 }}>{at ? `${mdhm(at)} 읽음 · ` : ''}다시 읽으면 Director 에 {rows.length}건을 다시 묻습니다</span>
        <span style={{ flex: '1 1 0' }} />
        <button type="button" className="logout-btn" style={BTN} disabled={busy || !items.length} onClick={load}>다시 읽기</button>
      </div>
    </aside>
  );
}
