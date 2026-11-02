/**
 * Bareos 현황 — 특수 기능 `bareos-summary`(v2.828 · v2.860 개편 — 사용자 요청 'Bareos UI 전폭 개선 · 직관적이고 복잡하지 않게' + 시안 docs/design/bareos-ui-v2 ①).
 *   메뉴: 서버 › Backup → 화면 위 'Bareos' 탭 → Bareos 탭 '현황'(BareosTabs). 값은 서버 GET /api/tools/bareos-summary(routes/api/bareosViews.js —
 *   원장·백업 표시·폴러 상태만, Director 에 접속하지 않는다). 판정·문구는 bareosViewText.js 하나.
 *   v2.860: 상태 띠 4장(법인 · 보호 VM · 마지막 결과 막대 · 확인 필요) · 법인 표 7열 · 칩 4(전체 · 확인 필요 · 정상 · 모름) · 바로가기 칩 바는 없앴다(표가 바로가기다).
 *   정책 · 일정과 보존 · 풀은 한 화면(BareosPolicyPage — '정책 · 보존')이다(옛 주소 …/pools 는 그 화면의 풀 구획).
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 부분 합에는 '*' · 훅은 조기 return 위 · 늦게 온 이전 응답은 버린다 · 마운트 1회 + 새로고침 + 60초.
 */
import React, { useRef, useState } from 'react';
import { usePolling, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import BareosPolicyPage from './BareosPolicyPage.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { CritIcon } from './BackupMarkIcons.jsx';
import { Note, ReadGuide, Stat, STAT_GRID, Dot, ResultBar, FilterChip } from './BareosBits.jsx';
import {
  directorStateOf, numText, resultBar, shortTs, fmtGb, PRIORITY_TEXT, PRIORITY_TONE, BAREOS_RPO_DAYS, BAREOS_DETAIL_VC_KEY, stText, priorityChips, priorityEmptyText,
  corpAttention, corpBucket, CORP_BUCKETS, partialText,
} from './bareosViewText.js';

const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', run: '#93c5fd', muted: 'var(--text-dim)', bareos: '#fdba74' };
const TAG = {
  bad: { background: 'rgba(239,68,68,.16)', color: '#fca5a5' }, warn: { background: 'rgba(245,158,11,.16)', color: '#fcd34d' },
  muted: { background: 'rgba(148,163,184,.12)', color: 'var(--text-dim)' },
};
const RPO_KEY = 'bareos-summary-rpo';
const loadRpo = () => { try { const v = Number(localStorage.getItem(RPO_KEY)); return BAREOS_RPO_DAYS.includes(v) ? v : 1; } catch { return 1; } };
const UNKNOWN_WHY = { auth: '인증이 실패해 조회를 멈췄습니다', error: '마지막 조회가 실패했습니다', unset: 'Director 가 없거나 접속값이 비어 있습니다' };

export function openBareosDetail(vcId) {
  try { localStorage.setItem(BAREOS_DETAIL_VC_KEY, vcId); } catch { /* 저장 못 해도 법인 화면은 첫 법인으로 열린다 */ }
  window.location.hash = '#/tools/bareos-detail';
}

function Tag({ tone = 'muted', children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...(TAG[tone] || TAG.muted) }}>{children}</span>;
}

/** v2.839 정책 · 일정 · v2.840 보존 · 풀 — v2.860 부터 한 화면(정책 · 보존). 통합 현황(overview)은 아래 화면 그대로. */
export default function BareosSummaryTool() {
  const [tab] = useHashTab({ base: ['tools', 'bareos-summary'], valid: ['overview', 'policy', 'pools'], fallback: 'overview' });
  return tab === 'overview' ? <BareosSummaryView /> : <BareosPolicyPage focus={tab} />;
}

function BareosSummaryView() {
  const [tick, setTick] = useState(0);
  const [rpoDays, setRpoDays] = useState(loadRpo);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [pKind, setPKind] = useState('all');
  const [pAll, setPAll] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  // 공용 usePolling(60초 · 403 이면 멈춤 · 늦은 응답 버림 — WEB2613-09 '도구 화면의 수제 setInterval 금지'). 새로고침(_r)은 데이터를 비우므로
  //   직전 응답을 들고 있는다(BareosBackupTool 과 같은 이유 — 비면 필터·찾기가 다시 마운트돼 사라진다). 기준 일수를 바꾸면 새 값이 올 때까지 이전 값.
  const { data: polled, error, loading } = usePolling('/tools/bareos-summary', { rpoDays, _r: tick }, 60_000);
  const lastRef = useRef(null);
  if (polled) lastRef.current = polled;
  const data = polled || lastRef.current;
  const load = () => setTick((t) => t + 1);
  const changeRpo = (v) => { setRpoDays(v); try { localStorage.setItem(RPO_KEY, String(v)); } catch { /* 이 브라우저에만 — 못 쓰면 기본 1일 */ } };
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/bareos-summary.csv?rpoDays=${rpoDays}`); } catch (e) { setCsvErr(e); }
  };

  const head = (
    <>
      <VeeamHeader active="bareos" desc="Bareos — 법인(vCenter)마다 Director · 잡 · 결과를 포탈이 마지막으로 받아 둔 값으로 봅니다(Director 에 접속하지 않습니다)." />
      <BareosTabs active="summary" right={(
        <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'center', rowGap: 6 }}>
          {data && <span className="muted" style={{ fontSize: 12 }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>}
          <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
            <span className="muted">오래된 백업 기준</span>
            <Select className="input" sort={false} value={rpoDays} onChange={(e) => changeRpo(Number(e.target.value))} style={{ fontSize: 12, padding: '3px 6px', minWidth: 0, width: 'auto' }}>
              {BAREOS_RPO_DAYS.map((d) => <option key={d} value={d}>{d}일 초과</option>)}
            </Select>
          </label>
          {canCsv() && <button type="button" className="tab" onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </div>
      )} />
    </>
  );
  const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
  if (!data && error) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};
  const ds = data.directorStates || {};
  const bucketN = { all: rows.length, attn: 0, ok: 0, unknown: 0 };
  for (const r of rows) bucketN[corpBucket(r)] += 1;
  const needle = q.trim().toLowerCase();
  const order = { attn: 0, unknown: 1, ok: 2 };
  const shown = rows.filter((r) => (chip === 'all' || corpBucket(r) === chip) && (!needle || r.name.toLowerCase().includes(needle)))
    .slice().sort((a, b) => order[corpBucket(a)] - order[corpBucket(b)]);   // 확인 필요 · 모름이 위(정렬은 제목을 누르면 바뀐다)
  const prio = Array.isArray(data.priority) ? data.priority : [];
  const pShown = prio.filter((x) => pKind === 'all' || x.kind === pKind);
  const anyPartial = Object.keys(t.partial || {}).some((k) => ['ok', 'warn', 'fail', 'run', 'old', 'never', 'bareosMethod', 'missing', 'mismatch'].includes(k));
  const totAttn = corpAttention(t);
  const totAttnText = totAttn.n === null ? (['fail', 'missing', 'old', 'never'].every((k) => Number.isFinite(t[k])) ? numText((t.fail || 0) + (t.missing || 0) + (t.old || 0) + (t.never || 0)) : '—') : numText(totAttn.n);
  const attnPartial = ['fail', 'missing', 'old', 'never'].some((k) => t.partial?.[k]);
  const totBar = resultBar({ jobs: t.jobs, ok: t.ok, warn: t.warn, fail: t.fail, run: t.run });

  return (
    <div data-bareos-summary="" style={WRAP}>
      {head}
      {data.demo && <Note>데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다(백업 방식 표시는 실제 파일).</Note>}
      {data.marksUnreadable && <Note tone="bad">백업 표시 파일(backup-marks.json)을 읽지 못해 Bareos 방식 VM·미등록·방식 불일치 수를 모릅니다(—).</Note>}
      {data.registryUnreadable && <Note tone="bad">Bareos 백업 대상 원장(bareos-jobs.json)을 읽지 못해 잡·결과 수를 모릅니다(—) — 손상본은 설정 폴더에 보존돼 있습니다.</Note>}
      {csvErr && <Note tone="bad">CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</Note>}

      <div data-bareos-stats="" style={STAT_GRID}>
        <Stat label="법인 · Director" value={numText(rows.length)}
          sub={['ok', 'relay', 'pending', 'error', 'auth', 'unset'].filter((k) => ds[k]).map((k) => (
            <span key={k} className="flex" style={{ gap: 5, alignItems: 'center' }}><Dot color={directorStateOf(k).color} unknown={k === 'unset'} />{directorStateOf(k).text} {ds[k]}</span>
          ))} />
        <Stat label="보호 VM (Bareos 방식)" value={partialText(t, 'bareosMethod')}
          sub={<><span>잡 등록 {partialText(t, 'jobs')}</span><span>켜짐 {partialText(t, 'on')} · 꺼짐 {partialText(t, 'off')}</span>{t.mismatch ? <span>방식 불일치 {partialText(t, 'mismatch')}</span> : null}{t.vm ? <span>전체 VM {numText(t.vm)} 중</span> : null}</>} />
        <Stat label={`마지막 결과 (잡 ${partialText(t, 'jobs')})`}
          sub={<><span style={{ color: TONE.ok }}>성공 {partialText(t, 'ok')}</span><span style={{ color: TONE.warn }}>경고 {partialText(t, 'warn')}</span><span style={{ color: TONE.bad }}>실패 {partialText(t, 'fail')}</span><span style={{ color: TONE.run }}>진행 {partialText(t, 'run')}</span>{t.unknown ? <span>모름 {numText(t.unknown)}</span> : null}</>}>
          {totBar ? <ResultBar b={totBar} label={`성공 ${t.ok} · 경고 ${t.warn} · 실패 ${t.fail} · 진행 ${t.run}`} /> : <span className="muted" style={{ fontSize: 12 }}>{t.jobs ? '모름' : '잡 없음'}</span>}
        </Stat>
        <Stat label="확인 필요" value={`${totAttnText}${attnPartial ? '*' : ''}`} tone={totAttnText !== '0' && totAttnText !== '—' ? 'bad' : undefined}
          sub={<><span>실패 {partialText(t, 'fail')}</span><span>미등록 {partialText(t, 'missing')}</span><span>오래됨({data.rpoDays}일+) {partialText(t, 'old')}</span><span>백업 없음 {partialText(t, 'never')}</span>{bucketN.unknown ? <Tag>결과 모름 {bucketN.unknown}곳 제외</Tag> : null}</>} />
      </div>
      {anyPartial && <div className="muted" style={{ fontSize: 12 }}>* 일부 법인을 모름(Director 인증 정지·조회 실패·미설정 또는 파일 손상) — 아는 법인만 더한 부분 합입니다.</div>}

      <div className="card" data-bareos-sites="" style={{ minWidth: 0, padding: 0, overflow: 'hidden' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', padding: '12px 16px', rowGap: 8, borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontSize: 14 }}>법인별</b>
          <span className="muted" style={{ fontSize: 12 }}>법인 이름을 누르면 법인 화면 · 막대 = 잡의 마지막 결과 · 모르는 값은 —</span>
          <div className="flex gap wrap" role="group" aria-label="보기" style={{ marginLeft: 'auto', rowGap: 6, alignItems: 'center' }}>
            {CORP_BUCKETS.map(([k, label]) => <FilterChip key={k} on={chip === k} onClick={() => setChip(k)}>{label} {bucketN[k]}</FilterChip>)}
            <SearchBox className="input" style={{ maxWidth: 200, minWidth: 140 }} value={q} onChange={setQ} placeholder="법인 이름" />
          </div>
        </div>
        <STable minWidth={1000} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '8px 16px' }}>법인</th>
              <th style={{ padding: '8px 6px' }}>Director</th>
              <th style={{ padding: '8px 6px', textAlign: 'right' }} title="잡이 등록된 VM / 백업 방식을 Bareos 로 정한 VM">보호 VM</th>
              <th data-nosort="" style={{ padding: '8px 10px', width: 240 }}>마지막 결과</th>
              <th style={{ padding: '8px 6px', textAlign: 'right' }} title="실패 + 미등록 + 오래됨 + 백업 없음">확인 필요</th>
              <th style={{ padding: '8px 6px', textAlign: 'right' }} title="Bareos 관련 VM 디스크 사용(vCenter 인벤토리)">용량</th>
              <th style={{ padding: '8px 16px 8px 6px' }}>마지막 백업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const c = r.counts; const st = directorStateOf(r.director.state); const bucket = corpBucket(r);
              const a = corpAttention(c); const bar = resultBar(c);
              const parts = [['실패', a.parts.fail], ['미등록', a.parts.missing], ['오래됨', a.parts.old], ['백업 없음', a.parts.never]].filter(([, v]) => v);
              return (
                <tr key={r.id} data-bareos-row={r.id} style={{ borderTop: '1px solid var(--border-soft)', background: bucket === 'attn' || r.director.state === 'auth' ? 'rgba(239,68,68,.05)' : undefined }}>
                  <td data-sort={r.name} style={{ padding: '8px 6px 8px 12px' }}>
                    <button type="button" onClick={() => openBareosDetail(r.id)} title="법인 화면으로" style={{ background: 'none', border: 0, padding: '2px 4px', color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap' }}>
                      <b style={{ textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }}>{r.name}</b> <span className="muted" style={{ fontSize: 12 }}>{numText(r.vm)} VM</span>
                    </button>
                  </td>
                  <td data-sort={st.text} style={{ padding: '8px 6px', fontSize: 12.5 }}>
                    <span className="flex" style={{ gap: 7, alignItems: 'center', whiteSpace: 'nowrap' }}><Dot color={st.color} unknown={r.director.state === 'unset'} />{st.text}</span>
                    {r.director.name && <div className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{r.director.name} · {r.director.via === 'edge' ? '엣지 대행' : '중앙 직접'}</div>}
                  </td>
                  <td data-sort={c.jobs ?? ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {numText(c.jobs)} <span className="muted" style={{ fontSize: 12 }}>/ {numText(c.bareosMethod)}</span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    {bar ? (
                      <>
                        <ResultBar b={bar} label={`성공 ${c.ok} · 경고 ${c.warn} · 실패 ${c.fail} · 진행 ${c.run} / 잡 ${c.jobs}`} />
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 4, whiteSpace: 'nowrap' }}>성공 {c.ok} · 경고 {c.warn} · 실패 {c.fail}{c.run ? ` · 진행 ${c.run}` : ''}</div>
                      </>
                    ) : <span className="muted" style={{ fontSize: 12 }}>{bucket === 'unknown' ? `결과 모름 — ${UNKNOWN_WHY[r.director.state] || '조회 전입니다'}` : c.jobs > 0 ? '모름' : '잡 없음'}</span>}
                  </td>
                  <td data-sort={a.n ?? ''} style={{ padding: '8px 6px', textAlign: 'right' }}>
                    {a.n === null
                      ? <span className="flex" style={{ gap: 6, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}><Tag>모름</Tag>{a.parts.missing ? <span className="muted" style={{ fontSize: 11.5 }}>미등록 {a.parts.missing}</span> : null}</span>
                      : <span style={{ whiteSpace: 'nowrap' }}><b style={{ color: a.n ? TONE.bad : undefined, fontVariantNumeric: 'tabular-nums' }}>{a.n}</b>{parts.length ? <div className="muted" style={{ fontSize: 11.5 }}>{parts.map(([l, v]) => `${l} ${v}`).join(' · ')}</div> : null}</span>}
                  </td>
                  <td data-sort={c.gb} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c.rows ? fmtGb(c.gb) : '—'}</td>
                  <td data-sort={r.lastAt || ''} style={{ padding: '8px 16px 8px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(r.lastAt)}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>{rows.length ? '조건에 맞는 법인이 없습니다.' : '볼 수 있는 vCenter 가 없습니다.'}</td></tr>}
          </tbody>
        </STable>
      </div>

      <div className="card" data-bareos-priority="" style={{ minWidth: 0, padding: 0, overflow: 'hidden' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', padding: '12px 16px', rowGap: 8, borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontSize: 14 }}>지금 확인할 것</b>
          <span className="muted" style={{ fontSize: 12 }}>중요도 상 먼저 · 실패 → 미등록 → 오래된 백업 → 백업 없음{data.priorityTotal > prio.length ? ` · 상한으로 ${data.priorityTotal - prio.length}건 생략(CSV · 법인 화면에서 보세요)` : ''}</span>
          <div className="flex gap wrap" role="group" aria-label="종류" style={{ marginLeft: 'auto', rowGap: 6 }}>
            {priorityChips(data).map(([k, label]) => (   // U-8(v2.846): 권한이 없어 목록을 받지 못했으면 수는 '—'
              <FilterChip key={k} on={pKind === k} onClick={() => setPKind(k)}>{label}</FilterChip>
            ))}
          </div>
        </div>
        <STable minWidth={820} limit={pAll ? 0 : 8} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '8px 16px' }}>VM</th>
              <th style={{ padding: '8px 6px' }}>법인 · 폴더</th>
              <th style={{ padding: '8px 6px' }}>왜</th>
              <th style={{ padding: '8px 6px' }}>중요도</th>
              <th style={{ padding: '8px 6px' }}>마지막 백업</th>
              <th data-nosort="" style={{ padding: '8px 16px 8px 6px' }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>열기</span></th>
            </tr>
          </thead>
          <tbody>
            {pShown.map((x) => (
              <tr key={`${x.vcenterId}|${x.id}`} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <td data-sort={x.name} style={{ padding: '8px 16px', fontWeight: 600, overflowWrap: 'anywhere' }}>{x.name}</td>
                <td style={{ padding: '8px 6px', fontSize: 12, overflowWrap: 'anywhere' }}>{x.vcName} · <span className="muted">{x.folder || '—'}</span></td>
                <td data-sort={PRIORITY_TEXT[x.kind]} style={{ padding: '8px 6px' }}>
                  <Tag tone={PRIORITY_TONE[x.kind]}>{PRIORITY_TEXT[x.kind] || x.kind}</Tag>
                  {x.kind === 'fail' && x.st && <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>{stText(x.st)} {shortTs(x.at)}</span>}
                </td>
                <td data-sort={x.crit === 'high' ? 3 : x.crit === 'mid' ? 2 : x.crit === 'low' ? 1 : ''} style={{ padding: '8px 6px' }}>{x.crit ? <CritIcon crit={x.crit} withText /> : <span className="muted">—</span>}</td>
                <td data-sort={x.ok || ''} style={{ padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(x.ok)}</td>
                <td style={{ padding: '8px 16px 8px 6px' }}><button type="button" className="tab" onClick={() => openBareosDetail(x.vcenterId)} style={{ padding: '3px 10px', fontSize: 12 }}>열기 →</button></td>
              </tr>
            ))}
            {!pShown.length && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>{priorityEmptyText(data)}</td></tr>}
          </tbody>
        </STable>
        {pShown.length > 8 && <div style={{ padding: '8px 16px 12px' }}><button type="button" className="tab" onClick={() => setPAll((v) => !v)} style={{ padding: '4px 12px', fontSize: 12 }}>{pAll ? '8건만 보기' : `전부 보기(${pShown.length}건)`}</button></div>}
      </div>

      <ReadGuide note="숫자 = 포탈 원장(등록한 백업 대상) + Backup › Detail 의 백업 방식 표시. 포탈이 등록하지 않은 Bareos 잡은 세지 않습니다.">
        <div><b style={{ color: TONE.ok }}>성공</b> · <b style={{ color: TONE.warn }}>경고</b> · <b style={{ color: TONE.bad }}>실패</b> · <b style={{ color: TONE.run }}>진행</b> — 잡마다 마지막으로 끝난 실행(폴러가 반영한 Director 카탈로그 값). 진행은 지금 도는 실행이라 한 잡이 둘 다 셀 수 있습니다.</div>
        <div><b>보호 VM</b> 잡이 등록된 VM / 백업 방식을 Bareos 로 정한 VM · <b>미등록</b> 방식은 Bareos 인데 잡이 없음 · <b>방식 불일치</b> 잡은 있는데 방식이 Bareos 가 아님</div>
        <div><b>확인 필요</b> 실패 + 미등록 + 오래됨(기준 {data.rpoDays}일 초과) + 백업 없음(잡이 켜져 있는데 백업이 한 번도 없음) — 아래 ‘지금 확인할 것’ 과 같은 종류입니다.</div>
        <div><b>모름</b> Director 인증 정지 · 조회 실패 · 미설정 법인은 결과를 마지막으로 읽은 값이라 합계에서 뺍니다(0 이 아닙니다) · 숫자 뒤 * 는 그런 법인을 뺀 부분 합입니다.</div>
      </ReadGuide>
    </div>
  );
}
