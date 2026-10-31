/**
 * Backup › Summary '통합 에러 로그'(v2.838 — 시안 ① 맨 아래 구획).
 *   GET /tools/backup-summary/errors?days=1|7|30 — Veeam VM 마지막 결과 · EM 세션(전체 범위 계정만) · Bareos 원장의 끝난 실행 · 멈춤 의심(진행 현황이 신선할 때만) ·
 *   포탈 수집 오류를 서버가 한 모양으로 모은다(veeam/backupErrors.js). 화면은 거르고 그린다.
 *   무거운 집계라 폴링하지 않는다 — 처음 한 번 · 기간을 바꿀 때 · 위 '새로고침'(reloadKey) 때만 · 늦게 온 이전 응답은 버린다.
 *   오류 원문은 관리자 판본만(서버가 가린다) · joblog 원문은 열기(Bareos 실행 이력)에서.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, hasRole, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtNum } from './backupViewText.js';
import { ERROR_KIND, ERROR_SRC, ERROR_DAY_OPTS, filterErrors, errorTarget, errorOpen, sameText, mdhm } from './backupSummaryPlan.js';

const PAD = { padding: '8px 8px' };
const Pill = ({ s, children }) => <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>{children ?? s.text}</span>;
const linkBtn = { background: 'none', border: 0, padding: 0, color: '#93c5fd', font: 'inherit', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' };
const CHIP = { padding: '3px 12px', fontSize: 12, fontWeight: 700 };
const KINDS = [['', '전체', 'all'], ['fail', '실패', 'fail'], ['warn', '경고', 'warn'], ['stuck', '멈춤 의심', 'stuck'], ['collect', '수집 오류', 'collect']];

export default function BackupSummaryErrors({ reloadKey, onOpenDetail }) {
  const [days, setDays] = useState(1);
  const [kind, setKind] = useState('');
  const [src, setSrc] = useState('');
  const [all, setAll] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-summary/errors', { days: String(days) })
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, [days]);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load, reloadKey]);

  const c = data?.counts || {};
  const rows = filterErrors(data?.rows, { kind, src });
  const dayText = (ERROR_DAY_OPTS.find(([d]) => d === (data?.days || days)) || [0, '24시간'])[1];
  const opt = { canBareos: toolAllowed('bareos-backup'), canBareosView: toolAllowed('bareos-summary'), admin: hasRole('admin') };
  const go = (r, o) => { if (o.key === 'detail') onOpenDetail?.(r.vc); else window.location.hash = o.hash; };

  return (
    <section className="card" aria-label="통합 에러 로그" data-backup-errors="" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 8px', padding: '12px 14px', borderBottom: '1px solid var(--border-soft)' }}>
        <b style={{ fontSize: 14 }}>통합 에러 로그 — 최근 {dayText}</b>
        <span className="muted" style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' }}>Veeam(VM 마지막 결과 · EM 세션) + Bareos(실패 · 경고 · 취소 실행 · 멈춤 의심) + 포탈 수집 오류 · 같은 모양으로</span>
        <div className="flex wrap" role="group" aria-label="거르기" style={{ marginLeft: 'auto', gap: 6 }}>
          {KINDS.filter(([k]) => k !== 'stuck' || c.stuck > 0).map(([k, t, ck]) => (
            <button key={k || 'all'} type="button" className={`tab${kind === k ? ' active' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)} style={CHIP}>{t} {data ? fmtNum(c[ck] ?? 0) : ''}</button>
          ))}
          {[['veeam', 'Veeam'], ['bareos', 'Bareos']].map(([k, t]) => (
            <button key={k} type="button" className={`tab${src === k ? ' active' : ''}`} aria-pressed={src === k} onClick={() => setSrc((v) => (v === k ? '' : k))} title={`${t} 만(다시 누르면 둘 다)`} style={CHIP}>{t}</button>
          ))}
          <Select className="input" sort={false} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label="기간" style={{ minWidth: 0, width: 'auto', fontSize: 12 }}>
            {ERROR_DAY_OPTS.map(([d, t]) => <option key={d} value={String(d)}>{t}</option>)}
          </Select>
        </div>
      </div>
      {error ? <div style={{ padding: '10px 14px', fontSize: 12.5, color: error?.status === 403 ? 'var(--text-dim)' : '#fca5a5' }}>{error?.status === 403 ? '이 계정은 Detail 화면이 허용되지 않아 VM 별 에러 로그를 볼 수 없습니다.' : `읽지 못했습니다 — ${String(error?.message || error).slice(0, 160)}`}</div>
        : !data ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{loading ? '읽는 중…' : ''}</div>
          : rows.length ? (
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={1000} limit={all ? 0 : 50}>
                <thead><tr>{['시각', '법인', '솔루션', '대상(잡 · VM)', '결과'].map((h) => <th key={h} style={PAD}>{h}</th>)}<th style={{ ...PAD, minWidth: 280 }}>메시지(요약 — 원문은 열기)</th><th style={PAD}>같은 원인</th><th data-nosort style={PAD}>열기</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const tg = errorTarget(r); const o = errorOpen(r, opt);
                    const s = r.src === 'collect' ? ERROR_SRC.collect : ERROR_SRC[r.src] || ERROR_SRC.collect;
                    return (
                      <tr key={`${r.at}|${r.src}|${r.vmId || r.uid || r.job}|${r.jobid || ''}|${i}`}>
                        <td data-sort={r.at} style={{ ...PAD, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{mdhm(r.at)}</td>
                        <td data-sort={r.vcName || ''} style={PAD}><div title={r.vcName || ''} style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vcName || <span className="muted">—</span>}</div></td>
                        <td data-sort={s.text} style={PAD}><Pill s={s} />{r.src === 'collect' && r.via ? <span className="muted" style={{ fontSize: 11 }}> {r.via === 'bareos' ? 'Bareos' : 'Veeam'}</span> : null}</td>
                        <td data-sort={tg.main} style={{ ...PAD, fontSize: 12 }}><div style={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[tg.main, tg.sub].filter(Boolean).join(' · ')}><b>{tg.main}</b>{tg.sub ? <span className="muted"> {tg.sub}</span> : null}</div></td>
                        <td data-sort={r.kind} style={PAD}><Pill s={ERROR_KIND[r.kind] || ERROR_KIND.collect} /></td>
                        <td style={{ ...PAD, fontSize: 12 }}><div style={{ minWidth: 260, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{r.msg}</div></td>
                        <td data-sort={r.same ?? 0} style={{ ...PAD, whiteSpace: 'nowrap', fontSize: 12 }}>{sameText(r.same)}</td>
                        <td style={PAD}>{o ? <button type="button" onClick={() => go(r, o)} style={linkBtn}>{o.text}</button> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>{c.all ? '거른 조건에 맞는 항목이 없습니다.' : `최근 ${dayText} 동안 실패 · 경고 · 수집 오류가 없습니다(읽은 출처 기준 — 아래 안내).`}</div>}
      {rows.length > 50 && (
        <div className="flex" style={{ padding: '6px 14px', fontSize: 12, alignItems: 'center', gap: 8 }}>
          <span className="muted">{fmtNum(rows.length)}건 중 {fmtNum(all ? rows.length : 50)}건 · 열 제목으로 정렬</span>
          <button type="button" className="tab" onClick={() => setAll((v) => !v)} style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 12 }}>{all ? '50건만 보기' : '전부 보기'}</button>
        </div>
      )}
      {data && (
        <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, borderTop: '1px solid var(--border-soft)', lineHeight: 1.6 }}>
          {data.truncated ? `서버가 새것부터 ${fmtNum(data.rows.length)}건만 보냈습니다(수는 전부 셉니다) · ` : ''}
          Veeam VM = 그 VM 의 마지막 task 결과만(그 앞 실패는 B&amp;R 결과에 없습니다) · EM 세션 = {data.sources?.em ? 'EM 이 읽은 최근 실패 · 경고 세션(EM 이 최근 7일만 읽습니다)' : '전체 범위 계정만 봅니다'} ·
          Bareos = 포탈 원장의 끝난 실행(잡마다 최근 5건 — joblog 원문은 실행 이력에서) · 멈춤 의심 = Bareos 진행 현황이 최근 조회된 법인만 ·
          같은 원인 = 출처 · 결과 · 잡 · 메시지 앞머리가 같은 항목 수{data.bareosUnknownSites ? ` · Bareos 원장을 못 읽은 법인 ${fmtNum(data.bareosUnknownSites)}곳은 Bareos 행이 없습니다(모름)` : ''}.
        </div>
      )}
    </section>
  );
}
