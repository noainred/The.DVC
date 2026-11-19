/**
 * SnapshotTool.jsx — 특수 기능 ‘스냅샷 있는 VM’(#/tools/snapshots) v3.26.0 · 시안 docs/design/snapshots(⑪).
 *
 * 1단계(이 판): 법인 카드 · 나이 × 크기 그림 · 신호 · 빠른 보기 · 묶어 보기(법인 · 클러스터 · 나이) · 줄기 펼침 · 정리 요청 글 · 고르기 · CSV ·
 *   주소에 보기 · 고른 법인을 싣는다(‘오래된 스냅샷’ 카드의 ‘모두 보기’ 가 `#/tools/snapshots/old/<vCenter id>` 로 연다).
 *   VM 별 스냅샷 이력 DB 는 이 판부터 기록만 한다(상태 칸) — 추이 · 7일 변화 · 정리된 것은 다음 판.
 * 판정은 서버(snaphist/view.js — hygieneFindings) · 화면은 거르고 묶고 세기만(snapText.js). 보기 전용 — 지우기 · 되돌리기 단추는 두지 않는다.
 * 무거운 집계라 15초 폴링하지 않는다 — 들어올 때 한 번 + ‘다시 받기’(루트 CLAUDE.md 프론트 규칙). 늦게 온 이전 응답은 버린다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, canCsv, toolAllowed } from '../../../api.js';
import { Loading, ErrorBox } from '../../../components/ui.jsx';
import { STable } from '../../../components/STable.jsx';
import { numOrNull } from '../../../numOrNull.js';
import { csvCell } from '../../../util/csv.js';
import { saveBlob } from '../../../util/saveBlob.js';
import { dayStamp } from '../../../dayStamp.js';
import { copyText } from '../../../util/copyText.js';
import { vcHash } from '../../vcd/vcdRoute.js';
import {
  BANDS, BAND_COLOR, BAND_FG, bandLabels, VIEWS, signalDefs, matchKey, sortItems, gbSum, groupItems, GROUPS, bandGradient, summaryOf, corpCards,
  logPos, gbText, daysText, dateText, requestText, CSV_HEAD, csvRow, parseSnapHash, buildSnapHash,
} from './snapText.js';
import './snapshots.css';

const KIND = (n) => (n.mem ? '메모리까지 담음' : n.quiesced ? '파일 시스템을 멈추고 찍음' : '디스크만');
const SKIP_TEXT = { template: '템플릿', exception: '예외', 'no-settings': '설정 없음' };

function exportCsv(rows) {
  const csv = [CSV_HEAD.map(csvCell).join(','), ...rows.map((r) => csvRow(r).map(csvCell).join(','))].join('\n');
  saveBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `snapshots-${dayStamp()}.csv`);
}

export default function SnapshotTool({ scope = '', initial = null, initialHist = null }) {   // initial* = 시험용(서버 렌더 — 효과가 돌지 않는다)
  const init = useMemo(() => parseSnapHash(typeof window === 'undefined' ? '' : window.location.hash), []);
  const [view, setView] = useState(init.view || 'all');
  const [vcPick, setVcPick] = useState(init.vcIds);
  const [corp, setCorp] = useState('');
  const [band, setBand] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(() => (init.view ? { key: 'days', dir: 'desc' } : { key: 'gb', dir: 'desc' }));
  const [group, setGroup] = useState('corp');
  const [closed, setClosed] = useState({});
  const [open, setOpen] = useState('');
  const [sel, setSel] = useState({});
  const [req, setReq] = useState('');
  const [msg, setMsg] = useState('');
  const [state, setState] = useState(() => (initial ? { loading: false, data: initial, at: null } : { loading: true }));
  const [hist, setHist] = useState(initialHist);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  const params = useMemo(() => (scope ? { vcenterId: scope } : vcPick.length ? { vcenterIds: vcPick.map((id) => encodeURIComponent(id)).join(',') } : {}), [scope, vcPick]);
  const pkey = JSON.stringify(params);
  useEffect(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fetchJson('/tools/snapshots', params)
      .then((d) => { if (my === seq.current) setState({ loading: false, data: d, at: Date.now() }); })
      .catch((e) => { if (my === seq.current) setState((s) => ({ loading: false, data: s.data, error: e.message })); });
    fetchJson('/tools/snapshots/history', { ...params, days: 7 })
      .then((d) => { if (my === seq.current) setHist(d); })
      .catch(() => { if (my === seq.current) setHist({ ok: false }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkey, tick]);
  // 보기 · 고른 법인을 주소에 싣는다(새로고침 · 북마크 · ‘이 보기 주소 복사’). 이력을 쌓지 않게 replaceState.
  useEffect(() => {
    if (!/^#\/tools\/snapshots(\/|$)/.test(window.location.hash)) return;
    const h = buildSnapHash(view, vcPick);
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
  }, [view, vcPick]);

  const data = state.data;
  const th = data?.thresholds || {};
  const labels = useMemo(() => bandLabels(data?.thresholds || {}), [data]);
  const items = useMemo(() => data?.items || [], [data]);
  const sigDefs = signalDefs(th).filter(([k]) => k !== 'grow');   // 7일 변화는 이력이 쌓인 뒤(다음 판)
  const scoped = useMemo(() => (corp ? items.filter((x) => x.corpId === corp) : items), [items, corp]);
  const ql = q.trim().toLowerCase();
  const shown = useMemo(() => sortItems(scoped
    .filter((x) => matchKey(x, view))
    .filter((x) => !band || x.band === band)
    .filter((x) => !ql || [x.name, x.corpName, x.vcName, x.cluster, x.host, x.oldestDesc, ...(x.names || []), ...((x.tree || []).map((n) => n.name))]
      .some((s) => s && String(s).toLowerCase().includes(ql))), sort.key, sort.dir), [scoped, view, band, ql, sort]);
  const sum = summaryOf(scoped);
  const cards = useMemo(() => corpCards(items, data?.corps), [items, data]);
  const groups = useMemo(() => groupItems(shown, group, labels), [shown, group, labels]);
  const selItems = items.filter((x) => sel[`${x.vcenterId}\n${x.id}`]);
  const allOn = shown.length > 0 && shown.every((x) => sel[`${x.vcenterId}\n${x.id}`]);

  if (state.loading && !data) return <Loading />;
  if (state.error && !data) return <ErrorBox message={state.error} />;

  const corpName = cards.find((c) => c.id === corp)?.name || '';
  const pills = [];
  if (vcPick.length && !scope) pills.push({ k: 'vc', label: `고른 vCenter ${vcPick.length}곳`, clear: () => { setVcPick([]); setCorp(''); } });
  if (corp) pills.push({ k: 'corp', label: `법인 · ${corpName}`, clear: () => setCorp('') });
  if (view !== 'all') pills.push({ k: 'view', label: (VIEWS.find((v) => v[0] === view) || sigDefs.find((s) => s[0] === view) || [, view])[1], clear: () => setView('all') });
  if (band) pills.push({ k: 'band', label: `나이 · ${labels[band]}`, clear: () => setBand('') });
  if (ql) pills.push({ k: 'q', label: `찾기 · ${q.trim()}`, clear: () => setQ('') });

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500); };
  const keyOf = (x) => `${x.vcenterId}\n${x.id}`;
  const toggleSel = (x) => setSel((s) => { const n = { ...s }; if (n[keyOf(x)]) delete n[keyOf(x)]; else n[keyOf(x)] = true; return n; });
  const sortBy = (key, first) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first }));
  const head = (key, label, first, cls = '') => (
    <th className={`${cls}${sort.key === key ? ' on' : ''}`} onClick={() => sortBy(key, first)} title={`${label} 순으로 정렬`}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const maxD = Math.max(1, ...shown.map((x) => numOrNull(x.days) ?? 0));
  const maxG = Math.max(1, ...shown.map((x) => numOrNull(x.snapGB) ?? 0));
  const w = (n, m) => (numOrNull(n) == null ? 0 : Math.max(2, Math.round((n / m) * 100)));
  const inShown = new Set(shown.map(keyOf));
  const plotted = scoped.filter((x) => numOrNull(x.days) != null && numOrNull(x.snapGB) != null);
  const offPlot = scoped.length - plotted.length;
  const status = hist?.status;
  const canHyg = toolAllowed('vm-hygiene');

  return (
    <div className="snp">
      <div className="snp-top">
        <span className="snp-note">스냅샷이 있는 VM — 법인별로, 오래된 것 · 큰 것부터 봅니다. 이 화면은 보기 전용입니다(정리는 그 법인의 vCenter 에서).</span>
        <span className="rt">
          <span>받은 시각 {state.at ? new Date(state.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '—'}{state.loading ? ' · 받는 중…' : ''}</span>
          <button type="button" className="snp-btn" onClick={() => setTick((t) => t + 1)} disabled={state.loading}>다시 받기</button>
          <button type="button" className="snp-btn" onClick={() => copyText(window.location.href).then((ok) => flash(ok ? '이 보기의 주소를 복사했습니다.' : '복사하지 못했습니다 — 주소 표시줄에서 복사해 주세요.'))}>이 보기 주소 복사</button>
          {canCsv() && <button type="button" className="snp-btn" onClick={() => exportCsv(shown)} disabled={!shown.length}>CSV 내려받기({shown.length})</button>}
        </span>
      </div>
      {msg && <div className="snp-note">{msg}</div>}
      {state.error && <div className="snp-note warn">다시 받지 못했습니다 — 앞서 받은 값을 보여 줍니다({state.error}).</div>}

      <div className="snp-rules" aria-label="판정 기준과 알림">
        <div className="snp-rule"><span className="t">사내 기준</span>
          <span>{numOrNull(th.snapAgeDays) == null ? '기준 설정을 받지 못해 판정하지 않았습니다' : <>나이 <b>{th.snapAgeDays}일</b> · 한 VM 에 <b>{th.snapCount}개</b> · 크기 <b>{th.snapSizeGB} GB</b> · 예외 목록 <b>{th.exceptions}건</b> · 템플릿은 판정하지 않음</>}</span>
          {th.hygieneUnreadable && <span className="snp-note warn">설정 파일을 읽지 못해 기본값으로 판정 중입니다.</span>}
          {canHyg && <a href="#/tools/vm-hygiene">‘VM 구성 점검’ 설정에서 바꿉니다 →</a>}
        </div>
        <div className="snp-rule"><span className="t">VMware 권고(참고선)</span>
          <span>한 스냅샷은 <b>{th.adviseHours ?? 72}시간</b> 안에 · 줄기는 <b>2~{th.adviseChain ?? 3}개</b> · 스냅샷은 백업이 아님</span>
          <span className="snp-note">판정이 아니라 참고로만 보입니다(Broadcom KB 318825).</span>
        </div>
        <div className="snp-rule"><span className="t">알림</span>
          <span>{th.notify ? (th.notify.enabled ? <>매일 <b>{th.notify.hour}시</b> 기준을 넘긴 VM 목록을 알림 — <b>켜짐</b></> : <>알림 <b>꺼짐</b></>) : '알림 설정을 받지 못했습니다'}</span>
          <span className="snp-note">‘VM 구성 점검’ 의 알림 설정을 보여 주기만 합니다.</span>
        </div>
        <div className="snp-rule"><span className="t">스냅샷 이력 DB</span>
          {!hist ? <span>확인하는 중…</span>
            : !status ? <span>상태를 받지 못했습니다.</span>
              : !status.available ? <span>쓸 수 없습니다{status.error ? ` — ${status.error}` : ''}</span>
                : <span>하루 <b>1번</b>({status.recordHour}시 뒤) 기록 · 시작 <b>{status.started || '아직 없음'}</b> · 보관 <b>{status.retentionDays}일</b></span>}
          <span className="snp-note">추이 · 7일 변화 · 정리된 스냅샷은 기록이 쌓인 뒤 다음 판에서 보입니다. 기록 시작 전의 과거는 채우지 않습니다.</span>
        </div>
      </div>

      <div className="snp-kpis" aria-label="요약">
        <div className="snp-kp"><span className="l">스냅샷이 있는 VM</span><span className="v">{sum.vms.toLocaleString('en-US')}</span>
          <span className="s">{corp ? `${corpName} 법인` : '전체 법인'} · 판정하지 않는 VM {sum.skip}대 포함{sum.stale ? ` · 값이 낡은 vCenter 의 ${sum.stale}대는 뺐습니다` : ''}</span></div>
        <div className="snp-kp"><span className="l">사내 기준{numOrNull(th.snapAgeDays) != null ? `(${th.snapAgeDays}일)` : ''}을 넘긴 VM</span><span className="v" style={{ color: sum.over ? '#fbbf24' : '#86efac' }}>{sum.over.toLocaleString('en-US')}</span>
          <span className="s">72시간(권고) 넘김 {sum.h72}대{sum.ageUnknown ? ` · 생성일 못 읽음 ${sum.ageUnknown}대는 따로` : ''}</span></div>
        <div className="snp-kp"><span className="l">스냅샷 크기</span><span className="v" style={{ color: '#67e8f9' }}>{gbText(sum.gb)}</span>
          <span className="s">기준을 넘긴 VM 을 정리하면 약 {gbText(sum.overGb)}{sum.gbUnknown ? ` · 크기 못 읽음 ${sum.gbUnknown}대는 합에 없음` : ''}</span></div>
        <div className="snp-kp"><span className="l">스냅샷 수</span><span className="v">{sum.snaps.toLocaleString('en-US')}개</span>
          <span className="s">{sum.maxAge != null ? `가장 오래된 것 ${daysText(sum.maxAge)} 전` : '생성일을 읽은 스냅샷이 없습니다'}</span></div>
        <div className="snp-kp"><span className="l">유령 스냅샷 후보</span><span className="v">{(data?.ghost ?? 0).toLocaleString('en-US')}대</span>
          <span className="s">스냅샷은 없는데 델타 파일이 남은 VM{canHyg ? <> — <a href="#/tools/vm-hygiene">‘VM 구성 점검’ 에서 →</a></> : ''}</span></div>
      </div>

      <div className="snp-sec"><h3>법인별</h3><span className="hint">카드를 누르면 그 법인만 봅니다 · 막대 = 나이 구간</span></div>
      <div className="snp-cards" role="group" aria-label="법인별 요약">
        {cards.map((c) => (
          <button key={c.id} type="button" className={`snp-cc${corp === c.id ? ' on' : ''}`} aria-pressed={corp === c.id} onClick={() => { setCorp(corp === c.id ? '' : c.id); setOpen(''); }}
            title={`${c.name} — 스냅샷이 있는 VM ${c.n}대(기준 넘김 ${c.over}대) · ${gbText(c.gb.gb)} — 누르면 이 법인만 봅니다`}>
            <span className="cn"><span>{c.name}</span><em className={c.over ? '' : 'none'}>{c.over ? `넘김 ${c.over}` : '넘김 없음'}</em></span>
            <span className="tx">{c.n}대 · {gbText(c.gb.gb)}{c.over ? ` · 정리하면 ${gbText(c.overGb.gb)}` : ''}</span>
            <span className="snp-gbar" style={{ background: bandGradient(c.items) }} aria-hidden="true" />
            <span className="tx">{c.oldest != null ? `가장 오래된 것 ${daysText(c.oldest)}` : c.n ? '판정한 스냅샷 없음' : '스냅샷 없음'}{c.stale ? ' · 값이 낡음' : ''}</span>
          </button>
        ))}
      </div>

      <div className="snp-two">
        <section className="snp-panel" aria-label="나이와 크기">
          <div className="snp-ph"><h3>어느 것부터 볼까</h3><span className="hint">가로 = 가장 오래된 스냅샷이 지난 일수 · 세로 = 그 VM 의 스냅샷 크기(둘 다 로그 눈금) · 점을 누르면 아래 표에서 펼쳐집니다</span></div>
          <div className="snp-plot" role="group" aria-label="지난 일수와 크기 그림">
            {[[1, '1일', 0, ''], [(th.adviseHours ?? 72) / 24, `${th.adviseHours ?? 72}시간(권고)`, 1, ' adv'], [numOrNull(th.snapAgeDays), `${th.snapAgeDays}일(사내)`, 1, ''], [30, '30일', 0, ''], [90, '90일', 0, ''], [365, '1년', 0, ''], [1000, '1,000일', 0, ' far']]
              .filter(([n]) => n != null).map(([n, label, hl, cls]) => (
                <React.Fragment key={`x${label}`}>
                  <span className={`snp-xg${hl ? ' th' : ''}`} style={{ left: `${logPos(n)}%` }} />
                  <span className={`snp-xt${hl ? ' th' : ''}${cls}`} style={{ left: `${logPos(n)}%` }}>{label}</span>
                </React.Fragment>
              ))}
            {[[1, '1 GB'], [10, '10 GB'], [100, '100 GB'], [1000, '1,000 GB']].map(([n, label]) => (
              <React.Fragment key={`y${label}`}>
                <span className="snp-yg" style={{ bottom: `${logPos(n)}%` }} />
                <span className={`snp-yt${n === numOrNull(th.snapSizeGB) ? ' th' : ''}`} style={{ bottom: `${logPos(n)}%` }}>{label}</span>
              </React.Fragment>
            ))}
            {numOrNull(th.snapAgeDays) != null && numOrNull(th.snapSizeGB) != null && (
              <div className="snp-zone" style={{ left: `${logPos(th.snapAgeDays)}%`, bottom: `${logPos(th.snapSizeGB)}%` }}><span>먼저 볼 것 — 기준을 넘겼고 큰 스냅샷</span></div>
            )}
            {plotted.map((x) => {
              const k = keyOf(x); const tip = `${x.name} · ${x.corpName} — ${daysText(x.days)} · ${gbText(x.snapGB)} · 스냅샷 ${x.snapshotCount}개${x.skip ? ` · ${SKIP_TEXT[x.skip]}(판정 안 함)` : ''}`;
              return (
                <button key={k} type="button" className={`snp-dot${x.judged === false ? ' ex' : ''}${open === k ? ' sel' : ''}${inShown.has(k) ? '' : ' dim'}`}
                  style={{ left: `${logPos(x.days)}%`, bottom: `${logPos(x.snapGB)}%`, background: x.judged === false ? 'transparent' : BAND_COLOR[x.band] }}
                  title={tip} aria-label={tip}
                  onClick={() => { if (!inShown.has(k)) { setView('all'); setBand(''); setQ(''); setClosed({}); } setOpen(open === k ? '' : k); }} />
              );
            })}
          </div>
          <div className="snp-lgd" role="group" aria-label="나이 구간(누르면 그 구간만)">
            {BANDS.map((b) => ({ b, n: scoped.filter((x) => x.band === b).length })).filter((o) => o.n || band === o.b).map(({ b, n }) => (
              <button key={b} type="button" className={`snp-lg${band === b ? ' on' : ''}`} aria-pressed={band === b} onClick={() => { setBand(band === b ? '' : b); setOpen(''); }}>
                <i style={{ background: BAND_COLOR[b] }} />{labels[b]} <b>{n}</b>
              </button>
            ))}
            {offPlot > 0 && <span>그림에 없는 VM {offPlot}대 — 생성일 또는 크기를 못 읽었습니다(표에는 있습니다)</span>}
          </div>
        </section>

        <section className="snp-panel" aria-label="신호">
          <div className="snp-ph"><h3>신호</h3><span className="hint">누르면 그 신호가 있는 VM 만 봅니다</span></div>
          <div>
            {sigDefs.map(([k, label, hint, color]) => {
              const n = scoped.filter((x) => !x.stale && matchKey(x, k)).length;
              return (
                <button key={k} type="button" className={`snp-sg${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => { setView(view === k ? 'all' : k); setOpen(''); }}>
                  <span className="l">{label}<small>{hint}</small></span><span className="n" style={{ color: n ? color : '#64748b' }}>{n}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="snp-panel" aria-label="스냅샷이 있는 VM">
        <div className="snp-ph"><h3>스냅샷이 있는 VM</h3><span className="hint">제목을 누르면 정렬 · VM 이름을 누르면 스냅샷 줄기가 펼쳐집니다 · 왼쪽 칸으로 골라 정리 요청을 만듭니다</span></div>
        <div className="snp-flt">
          <span className="lb">빠른 보기</span>
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" className={`snp-chip${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => { setView(k); setOpen(''); }}>
              {label}<b>{scoped.filter((x) => matchKey(x, k)).length}</b>
            </button>
          ))}
          <input className="snp-find" type="search" aria-label="VM · 법인 · 클러스터 · 호스트 · 스냅샷 이름으로 찾기" placeholder="VM · 법인 · 클러스터 · 스냅샷 이름" value={q} onChange={(e) => { setQ(e.target.value); setOpen(''); }} />
        </div>
        <div className="snp-flt">
          <span className="lb">묶어 보기</span>
          <span className="snp-seg" role="group" aria-label="묶어 보기">
            {GROUPS.filter(([k]) => k !== 'who').map(([k, label]) => (
              <button key={k} type="button" className={group === k ? 'on' : ''} aria-pressed={group === k} onClick={() => { setGroup(k); setClosed({}); if (req.startsWith('g:')) setReq(''); }}>{label}</button>
            ))}
          </span>
          {pills.length > 0 && <span className="lb">지금 건 조건</span>}
          {pills.map((p) => <button key={p.k} type="button" className="snp-pill" onClick={p.clear} title="이 조건 풀기">{p.label} ✕</button>)}
        </div>
        {selItems.length > 0 && (
          <>
            <div className="snp-selbar" aria-live="polite">
              <span>고른 VM {selItems.length}대 · 스냅샷 {selItems.reduce((a, x) => a + (numOrNull(x.snapshotCount) ?? 0), 0)}개 · 정리하면 약 {gbText(gbSum(selItems).gb)}{gbSum(selItems).unknown ? `(크기 못 읽음 ${gbSum(selItems).unknown}대 제외)` : ''}</span>
              <button type="button" className="snp-btn sm" onClick={() => setReq(req === 'sel' ? '' : 'sel')}>{req === 'sel' ? '정리 요청 닫기' : '정리 요청 보기'}</button>
              {canCsv() && <button type="button" className="snp-btn sm" onClick={() => exportCsv(selItems)}>고른 것만 CSV</button>}
              <button type="button" className="snp-btn sm" onClick={() => { setSel({}); if (req === 'sel') setReq(''); }}>선택 풀기</button>
            </div>
            {req === 'sel' && <ReqBox text={requestText('고른 VM', selItems, th, { onlyOver: false })} onCopied={flash} />}
          </>
        )}
        <STable className="snp-tbl" minWidth={1180}>
          <thead>
            <tr>
              <th className="nos"><button type="button" className={`snp-ck${allOn ? ' on' : ''}`} aria-pressed={allOn} aria-label="보이는 VM 모두 고르기"
                onClick={() => setSel((s) => { const n = { ...s }; for (const x of shown) { if (allOn) delete n[keyOf(x)]; else n[keyOf(x)] = true; } return n; })}>{allOn ? '✓' : ''}</button></th>
              {head('name', 'VM', 'asc')}
              {head('oldest', '가장 오래된 스냅샷', 'asc')}
              {head('days', '지난 일수', 'desc')}
              {head('count', '개수', 'desc', 'r')}
              {head('gb', '크기', 'desc')}
              {head('power', '전원', 'desc')}
              {head('sig', '신호', 'desc')}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isClosed = !!closed[g.key];
              const rows = [];
              if (group !== 'none') {
                const o = g.items.filter((x) => x.sig?.age === true); const gs = gbSum(g.items); const reqOn = req === `g:${g.key}`;
                rows.push(
                  <tr key={`g:${g.key}`} className="grp"><td colSpan={8}>
                    <button type="button" className="snp-gt" aria-expanded={!isClosed} onClick={() => setClosed((c) => ({ ...c, [g.key]: !isClosed }))}>
                      <i className="snp-cv">{isClosed ? '▸' : '▾'}</i><b>{g.label}</b>
                      <span>{g.items.length}대 · 기준 넘김 {o.length}대 · {gbText(gs.gb)}{o.length ? ` · 정리하면 약 ${gbText(gbSum(o).gb)}` : ''}</span>
                    </button>
                    <span className="snp-grow-bar" style={{ background: bandGradient(g.items) }} aria-hidden="true" />
                    {o.length > 0 && <button type="button" className="snp-btn sm" onClick={() => setReq(reqOn ? '' : `g:${g.key}`)}>{reqOn ? '정리 요청 닫기' : '정리 요청 보기'}</button>}
                  </td></tr>,
                );
                if (reqOn) rows.push(<tr key={`r:${g.key}`} className="foot"><td colSpan={8}><ReqBox text={requestText(g.label, g.items, th)} onCopied={flash} /></td></tr>);
                if (isClosed) return rows;
              }
              for (const x of g.items) {
                const k = keyOf(x); const isOpen = open === k; const s = x.sig || {};
                const notes = [];
                if (numOrNull(x.days) == null) notes.push('생성일 못 읽음');
                if (numOrNull(x.snapGB) == null) notes.push('크기 못 읽음');
                if (x.stale) notes.push('값이 낡음');
                rows.push(
                  <tr key={k} className={`vm${isOpen ? ' open' : ''}`}>
                    <td><button type="button" className={`snp-ck${sel[k] ? ' on' : ''}`} aria-pressed={!!sel[k]} aria-label={`${x.name} 고르기`} onClick={() => toggleSel(x)}>{sel[k] ? '✓' : ''}</button></td>
                    <td data-sort={x.name}><button type="button" className="snp-vm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : k)} title={`${x.name} — 누르면 스냅샷 ${x.snapshotCount}개가 펼쳐집니다`}>
                      <b><i className="snp-cv">{isOpen ? '▾' : '▸'}</i>{x.name}</b><span className="snp-sub">{group === 'corp' ? '' : `${x.corpName} · `}{x.cluster || '클러스터 없음'} · {x.host || '호스트 모름'}</span></button></td>
                    <td><span className="snp-sub" style={{ color: 'var(--text)', fontSize: 12.5 }}>{x.oldestName || '—'}</span>
                      <span className="snp-sub">{numOrNull(x.oldestTs) != null ? `${dateText(x.oldestTs)} 만듦` : '생성일 못 읽음'}{x.oldestDesc ? ` · ${x.oldestDesc}` : ' · 설명 없음'}</span></td>
                    <td><span className="snp-bar"><span className="snp-track"><i style={{ width: `${w(x.days, maxD)}%`, background: BAND_COLOR[x.band] }} /></span><b style={{ color: BAND_FG[x.band] }}>{daysText(x.days)}</b></span></td>
                    <td className="r snp-mono" style={{ color: s.count ? '#fdba74' : undefined }}>{x.snapshotCount}</td>
                    <td><span className="snp-bar"><span className="snp-track"><i style={{ width: `${w(x.snapGB, maxG)}%`, background: '#3b82f6' }} /></span><b>{gbText(x.snapGB)}</b></span></td>
                    <td><em className={`snp-pw${x.powerState === 'POWERED_ON' ? ' on' : ''}`}>{x.powerState === 'POWERED_ON' ? '켜짐' : '꺼짐'}</em></td>
                    <td><span className="snp-tags">
                      {s.age && <em className="snp-tg a" title="사내 기준 나이를 넘김">나이</em>}
                      {s.h72 && !s.age && <em className="snp-tg h" title="사내 기준 안이지만 VMware 권고 시간을 넘김">72시간</em>}
                      {s.count && <em className="snp-tg n" title="한 VM 에 스냅샷이 기준보다 많음">개수</em>}
                      {s.size && <em className="snp-tg g" title="크기 기준을 넘김">크기</em>}
                      {s.ds && x.ds && <em className="snp-tg r" title={`데이터스토어 ${x.ds.name} 사용률이 높음`}>DS {x.ds.pct}%</em>}
                      {s.cons && <em className="snp-tg r" title="디스크 통합 필요">통합</em>}
                      {s.backup && <em className="snp-tg p" title="백업 도구가 남긴 임시 스냅샷">백업</em>}
                      {s.mem && <em className="snp-tg p" title="메모리까지 담은 스냅샷이 있음">메모리</em>}
                      {x.skip && <em className="snp-tg x" title={x.exceptedBy ? `예외 목록 ‘${x.exceptedBy}’` : undefined}>{SKIP_TEXT[x.skip]}</em>}
                      {notes.length > 0 && <span>{notes.join(' · ')}</span>}
                    </span></td>
                  </tr>,
                );
                if (isOpen) {
                  for (const [i, n] of (x.tree || []).entries()) {
                    rows.push(
                      <tr key={`${k}:n${i}`} className="node">
                        <td />
                        <td colSpan={2}><span className="snp-node" style={{ paddingLeft: Math.min(n.d, 6) * 16 }}><i className="br" /><b>{n.name || '(이름 없음)'}</b>
                          {n.current && <em className="snp-tg ok" style={{ marginLeft: 8 }}>지금 위치</em>}</span>
                          {n.desc && <span className="snp-sub" style={{ paddingLeft: Math.min(n.d, 6) * 16 + 18 }}>{n.desc}</span>}</td>
                        <td className="snp-mono">{n.ts ? daysText(Math.floor((Date.now() - n.ts) / 86_400_000)) : '—'}</td>
                        <td colSpan={2}>{n.ts ? `${dateText(n.ts)} 만듦` : '생성일 못 읽음'}</td>
                        <td colSpan={2}>{KIND(n)}</td>
                      </tr>,
                    );
                  }
                  rows.push(
                    <tr key={`${k}:f`} className="foot"><td /><td colSpan={7}><span className="snp-foot">
                      {!x.tree && <span>스냅샷 줄기를 받지 못했습니다{x.names?.length ? ` — 이름: ${x.names.join(', ')}` : ''}.</span>}
                      {x.treeCut && <span>줄기가 길어 앞 {x.tree.length}개만 받았습니다(전체 {x.snapshotCount}개).</span>}
                      <span>{x.ds ? `데이터스토어 ${x.ds.name} — 사용 ${x.ds.pct}%${s.ds ? '(높음 — 스냅샷이 커지면 찹니다)' : ''}` : '데이터스토어 사용률을 받지 못했습니다'}</span>
                      {x.depth != null && <span>줄기 깊이 {x.depth}(권고 2~{th.adviseChain ?? 3})</span>}
                      <span className="snp-note">크기는 VM 한 대의 합계입니다 — 스냅샷 하나하나의 크기는 수집하지 않습니다.</span>
                      {x.vcenterId && x.id && <a href={vcHash(x.vcenterId, { type: 'vm', id: x.id })}>VM 상세 열기 →</a>}
                    </span></td></tr>,
                  );
                }
              }
              return rows;
            })}
          </tbody>
        </STable>
        {!shown.length && <div className="snp-empty">{items.length ? '이 조건에 맞는 VM 이 없습니다.' : '스냅샷이 있는 VM 이 없습니다.'}</div>}
        <div className="snp-sum"><span>{scoped.length}대 중 {shown.length}대 · 스냅샷 {shown.reduce((a, x) => a + (numOrNull(x.snapshotCount) ?? 0), 0)}개 · 크기 합 {gbText(gbSum(shown).gb)}{gbSum(shown).unknown ? ` · 크기 못 읽음 ${gbSum(shown).unknown}대는 합에 없음` : ''}</span></div>
      </section>
    </div>
  );
}

function ReqBox({ text, onCopied }) {
  return (
    <div className="snp-req">
      <pre>{text}</pre>
      <span className="snp-flt"><button type="button" className="snp-btn sm" onClick={() => copyText(text).then((ok) => onCopied(ok ? '정리 요청 글을 복사했습니다.' : '복사하지 못했습니다 — 글을 끌어 선택해 복사해 주세요.'))}>복사</button>
        <span className="snp-note">그 법인 담당자에게 보낼 글입니다 — 포탈이 보내지는 않습니다.</span></span>
    </div>
  );
}
