import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, downloadFile, canCsv } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import STable from '../components/STable.jsx';
import BoldText from '../components/boldText.jsx';
import Select from '../components/Select.jsx';
import { useHashTab } from '../hooks/useHashTab.js';
import {
  PERIODS, VIEWS, KIND_BADGE, BUCKETS, ROLE_BADGE, SRC_LABEL, PURGE_SCOPES, DROP_LABEL, HINT_RULES,
  keyMeta, allUsageKeys, fmtInt, fmtDur, fmtBytes, FEATURE_LIMIT, avgPerView, pctText, trendOf, fmtWhen, bucketShares, perDay, usageHints, filterUsers, filterFeatures,
} from './featureUsageText.js';
import './featureUsage.css';

/**
 * 설정 › 사용자 › 기능 사용 현황(v2.913 · 설계 docs/design/feature-usage · 사용자 요청 "사용자별로 어떤 기능을 사용하는지 트래킹 — UI 개선을 위해").
 *
 * 탭 4개(#/settings/feature-usage/<탭>): 개요 · 기능별 · 사용자별 · 수집 설정. 서버는 설정 소유자(소유자 ∧ 전체 범위)만 통과시킨다 — 403 은 ErrorBox 가
 * 권한 안내로 그린다. 폴링하지 않는다(마운트 1회 + 기간 변경 + 새로고침 — 집계는 날마다 DB 를 읽는다). 늦게 온 이전 기간 응답은 버린다.
 * 판정 · 문구는 featureUsageText.js 하나. 표는 STable(제목 클릭 정렬 · minWidth). 못 센 것은 0 이 아니다('—').
 * @param {{ settingsMeta: {k:string,label:string,groupLabel:string,superOnly?:boolean}[] }} props  Settings.jsx 가 넘기는 설정 하위 목록
 */
export default function FeatureUsage({ settingsMeta = [] }) {
  const [view, setView] = useHashTab({ base: ['settings', 'feature-usage'], valid: VIEWS.map((v) => v.k), fallback: 'overview' });
  const [days, setDays] = useState(30);
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [seq, setSeq] = useState(0);
  const [drawer, setDrawer] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState('');
  const reqId = useRef(0);
  const ctx = useMemo(() => ({ settingsMeta }), [settingsMeta]);

  useEffect(() => {
    if (view === 'settings') return undefined;
    const id = ++reqId.current;
    setLoading(true); setErr(null);
    fetchJson('/admin/usage/report', { days })
      .then((r) => { if (id === reqId.current) setRep(r); })
      .catch((e) => { if (id === reqId.current) { setErr(e); setRep(null); } })
      .finally(() => { if (id === reqId.current) setLoading(false); });
    return undefined;
  }, [days, seq, view]);

  const exportCsv = async () => {
    setCsvBusy(true); setCsvErr('');
    try { await downloadFile(`/admin/usage/export.csv?days=${days}`); }
    catch (e) { setCsvErr(String(e?.message || e)); }
    finally { setCsvBusy(false); }
  };

  return (
    <div className="fu">
      <div className="fu-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="fu-title">기능 사용 현황</h2>
          <div className="muted fu-sub">이 포탈에서 연 화면(탭 · 특수 기능 도구 · 설정 하위 · 관제 콘솔)을 사용자 · 날짜별로 셉니다. 입력 내용 · 검색어 · 본 데이터는 기록하지 않습니다.</div>
        </div>
        {view !== 'settings' && (
          <div className="fu-tools">
            <span className="fu-seg" role="group" aria-label="기간">
              {PERIODS.map((d) => <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>{d}일</button>)}
            </span>
            {rep?.range && <span className="muted mono fu-range">{rep.range.from} ~ {rep.range.to} (KST)</span>}
            {canCsv() && <button type="button" className="btn" onClick={exportCsv} disabled={csvBusy}>{csvBusy ? 'CSV 만드는 중…' : 'CSV'}</button>}
            <button type="button" className="btn" onClick={() => setSeq((n) => n + 1)} disabled={loading}>새로고침</button>
          </div>
        )}
      </div>
      {csvErr && <div className="fu-band crit">CSV 를 받지 못했습니다 — {csvErr}</div>}

      <div className="fu-tabs" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.k} type="button" role="tab" aria-selected={view === v.k} className={view === v.k ? 'on' : ''} onClick={() => setView(v.k)}>
            {v.label}
            {v.k === 'features' && rep && <span className="muted fu-cnt">{rep.totals.usedKeys} / {allUsageKeys(ctx).length}</span>}
            {v.k === 'users' && rep && <span className="muted fu-cnt">{rep.totals.activeUsers}</span>}
          </button>
        ))}
      </div>

      {view === 'settings' ? <UsageSettings /> : (
        <>
          {err && <ErrorBox error={err} />}
          {!err && !rep && <Loading />}
          {!err && rep && (
            <>
              <Bands rep={rep} onSettings={() => setView('settings')} />
              {view === 'overview' && <Overview rep={rep} ctx={ctx} onFeatures={() => setView('features')} />}
              {view === 'features' && <Features rep={rep} ctx={ctx} />}
              {view === 'users' && <Users rep={rep} ctx={ctx} onOpen={setDrawer} />}
            </>
          )}
        </>
      )}
      {drawer && <UserDrawer user={drawer} days={days} ctx={ctx} overall={rep} onClose={() => setDrawer('')} />}
    </div>
  );
}

/* ── 띠(알림) ─────────────────────────────────────────────────────────────── */
function Bands({ rep, onSettings }) {
  const off = !rep.settings?.enabled;
  return (
    <>
      {off && (
        <div className="fu-band warn">
          <b>기능 사용 기록이 꺼져 있습니다</b> — 아래는 지금까지 쌓인 기록입니다. <button type="button" className="fu-link" onClick={onSettings}>수집 설정에서 켜기 →</button>
        </div>
      )}
      {(rep.gaps || []).length > 0 && !off && (
        <div className="fu-band warn">
          이 기간 안에 기록이 없던 구간이 있습니다 — {rep.gaps.slice(0, 3).map((g) => `${fmtWhen(g.from)} ~ ${fmtWhen(g.to)}${g.beforeStart ? ' (기록 시작 전)' : g.by ? ` (${g.by} 가 끔)` : ' (꺼짐)'}`).join(' · ')}{rep.gaps.length > 3 ? ` 외 ${rep.gaps.length - 3}건` : ''}. 그 사이는 어떤 값에도 넣지 않았고 0 으로 세지 않습니다.
        </div>
      )}
      <div className="fu-band info">
        엣지 포탈(법인)에서 연 화면은 들어 있지 않습니다 — 이 포탈 것만 셉니다. ‘머문 시간’ 은 창이 보이고 마지막 입력 뒤 {rep.settings?.idleMin ?? '—'}분 이내인 시간만 더합니다(창을 닫는 순간의 마지막 몇 초는 빠질 수 있습니다).
        {rep.range?.partialToday ? ` 오늘(${rep.range.today})은 아직 진행 중이라 부분이고 추이 막대를 빗금으로 구분합니다.` : ''}
      </div>
    </>
  );
}

/* ── 개요 ─────────────────────────────────────────────────────────────────── */
function Overview({ rep, ctx, onFeatures }) {
  const t = rep.totals;
  const all = allUsageKeys(ctx);
  const used = new Set(rep.byKey.map((r) => r.k));
  const unused = all.filter((k) => !used.has(k) && !keyMeta(k, ctx).notReady);
  const kindCount = (kind) => rep.byKey.filter((r) => keyMeta(r.k, ctx).kind === kind).length;
  const pd = perDay(t.views, t.recDays);
  const shares = bucketShares(rep.byKey, ctx);
  const hints = usageHints(rep, ctx);
  const roles = roleRows(rep.users);
  const maxDay = Math.max(1, ...rep.daily.map((d) => d.views));
  const peak = rep.daily.reduce((a, d) => (d.views > (a?.views ?? -1) ? d : a), null);
  return (
    <>
      <div className="fu-kpis">
        <Kpi label="활성 사용자" value={fmtInt(t.activeUsers)} unit={`/ ${fmtInt(t.activeUsers + rep.idle.length)} 명`} meta={`기간 안에 한 번 이상 열람 · 미접속 ${rep.idle.length}명`} />
        <Kpi label="열람" value={fmtInt(t.views)} unit="회" meta={pd == null ? '기록이 켜진 날 없음' : `기록한 날 ${t.recDays}일 · 하루 평균 ${fmtInt(pd)}회`} />
        <Kpi label="머문 시간" value={fmtDur(t.ms)} meta={`1회 평균 ${avgPerView(t.ms, t.views)}`} />
        <Kpi label="쓰인 기능" value={fmtInt(t.usedKeys)} unit={`/ ${all.length}`} meta={`탭 ${kindCount('tab')} · 도구 ${kindCount('tool')} · 설정 하위 ${kindCount('settings')} · 콘솔 ${kindCount('console')}`} />
        <Kpi label="이 기간 0회" value={fmtInt(t.recDays > 0 ? unused.length : null)} warn meta={<button type="button" className="fu-link" onClick={onFeatures}>기능별에서 보기 →</button>} />
      </div>

      <div className="card fu-panel">
          <div className="fu-ph"><b>많이 쓰는 기능 — 상위 15</b><span className="muted">열람 내림차순 · 제목을 누르면 정렬 · 전체는 ‘기능별’ 탭</span></div>
          {rep.byKey.length === 0 ? <div className="muted fu-empty">이 기간에 기록된 열람이 없습니다.</div> : (
            <STable className="fu-table" minWidth={860} limit={15}>
              <thead><tr><th>기능</th><th>위치</th><th className="r">열람</th><th className="r">사용자</th><th className="r">머문 시간</th><th className="r">1회 평균</th><th>비중</th><th className="r">지난 {rep.range.days}일 대비</th></tr></thead>
              <tbody>
                {rep.byKey.map((r) => {
                  const m = keyMeta(r.k, ctx); const tr = trendOf(r.views, r.prevViews, t.recDays, rep.prev?.onDays);
                  return (
                    <tr key={r.k}>
                      <td><b>{m.label}</b></td>
                      <td className="fu-pos">{m.where} <span className={`badge ${KIND_BADGE[m.kind] || 'gray'}`}>{m.kindLabel}</span></td>
                      <td className="r mono" data-sort={r.views}>{fmtInt(r.views)}</td>
                      <td className="r mono" data-sort={r.users}>{fmtInt(r.users)}</td>
                      <td className="r mono" data-sort={r.ms}>{fmtDur(r.ms)}</td>
                      <td className="r mono" data-sort={r.views ? r.ms / r.views : ''}>{avgPerView(r.ms, r.views)}</td>
                      <td data-sort={r.views}><Share part={r.views} total={t.views} max={rep.byKey[0]?.views} /></td>
                      <td className={`r fu-trend ${tr.dir}`} data-sort={r.prevViews == null ? '' : r.views - r.prevViews}>{tr.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          )}
          {rep.byKey.length > 15 && <div className="muted fu-note">나머지 {rep.byKey.length - 15}개 기능 {fmtInt(rep.byKey.slice(15).reduce((a, r) => a + r.views, 0))}회 · ‘지난 기간 대비’ 는 바로 앞 같은 길이 기간과 비교(기록한 날 하루 평균끼리) · 그 기간의 모든 날에 기록이 있지 않으면 ‘—’</div>}
      </div>

      <div className="fu-row3">
          <div className="card fu-panel">
            <div className="fu-ph"><b>메뉴 묶음별 비중</b><span className="muted">열람 기준</span></div>
            <div className="fu-stack" role="img" aria-label="메뉴 묶음별 열람 비중">
              {shares.rows.filter((b) => b.views > 0).map((b) => <i key={b.id} style={{ width: `${(b.views / Math.max(1, shares.total)) * 100}%`, background: b.color }} />)}
            </div>
            <div className="fu-lgd">
              {shares.rows.map((b) => (
                <React.Fragment key={b.id}>
                  <i style={{ background: b.color }} />
                  <span>{b.label}{b.id === 'etc' && shares.etc.length ? <span className="muted">({shares.etc.slice(0, 3).map(([g, v]) => `${g} ${fmtInt(v)}`).join(' · ')})</span> : null}</span>
                  <span className="mono">{fmtInt(b.views)}</span>
                  <span className="mono muted">{pctText(b.views, shares.total)}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="card fu-panel">
            <div className="fu-ph"><b>일별 열람 추이</b><span className="muted">{peak && peak.views > 0 ? `최고 ${peak.day.slice(5)} ${fmtInt(peak.views)}회` : '기록 없음'}</span></div>
            <DayBars daily={rep.daily} max={maxDay} label="일별 열람 추이" />
          </div>

          <div className="card fu-panel">
            <div className="fu-ph"><b>역할별</b><span className="muted">열람 · 활성 인원</span></div>
            {roles.length === 0 ? <div className="muted fu-empty">기록 없음</div> : (
              <div className="fu-rb">
                {roles.map((r) => (
                  <React.Fragment key={r.role}>
                    <span>{r.role || '—'}</span>
                    <div className="fu-bar"><i style={{ width: `${(r.views / Math.max(1, roles[0].views)) * 100}%` }} /></div>
                    <span className="mono r">{fmtInt(r.views)} · {r.users}명</span>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
      </div>

      <div className="card fu-panel">
        <div className="fu-ph"><b>UI 개선 단서</b><span className="muted">아래 규칙으로 집계에서 뽑습니다 — 판단은 사람이 합니다</span></div>
        <div className="fu-hints">
          <Hint tag="승격 후보" color="green" title="메뉴에 없는데 많이 쓰는 도구" rule={HINT_RULES.promote}
            items={hints.promote.map((h) => <><b>{h.label}</b> {fmtInt(h.views)}회 · {h.users}명</>)} />
          <Hint tag="정리 후보" color="amber" title="메뉴에 있는데 이 기간 0회" rule={HINT_RULES.prune}
            items={hints.prune.items.map((h) => <><b>{h.where || h.label}</b></>)} more={hints.prune.total - hints.prune.items.length} />
          <Hint tag="깊이" color="blue" title="자주 쓰는데 두 번 이상 들어가야 하는 화면" rule={HINT_RULES.depth}
            items={hints.depth.map((h) => <><b>{h.label}</b> {fmtInt(h.views)}회 · 주 3회 이상 {h.users}명</>)} />
        </div>
      </div>
    </>
  );
}

function roleRows(users) {
  const m = new Map();
  for (const u of users || []) { const r = m.get(u.role) || { role: u.role, views: 0, users: 0 }; r.views += u.views; r.users += 1; m.set(u.role, r); }
  return [...m.values()].sort((a, b) => b.views - a.views);
}

function Kpi({ label, value, unit, meta, warn }) {
  return (
    <div className="card fu-kpi">
      <div className="lb">{label}</div>
      <div className={`val${warn ? ' warn' : ''}`}>{value}{unit && <small>{unit}</small>}</div>
      <div className="sub">{meta}</div>
    </div>
  );
}

function Share({ part, total, max }) {
  return (
    <div className="fu-ub"><div className="fu-bar"><i style={{ width: `${(part / Math.max(1, max || 1)) * 100}%` }} /></div><span className="mono muted">{pctText(part, total)}</span></div>
  );
}

function Hint({ tag, color, title, rule, items, more = 0 }) {
  return (
    <div className="fu-hint">
      <h4><span className={`badge ${color}`}>{tag}</span> {title}</h4>
      {items.length === 0 ? <div className="muted">해당 없음</div> : (
        <ul>{items.map((it, i) => <li key={i}>{it}</li>)}{more > 0 && <li className="muted">+ {more}개 더(기능별 탭 › ‘안 씀’)</li>}</ul>
      )}
      <div className="fu-pos">{rule}</div>
    </div>
  );
}

/** 일별 막대 — 기록 꺼짐 날은 빗금(값 없음, 0 아님) · 오늘은 부분 빗금 · 주말은 어둡게. */
function DayBars({ daily, max, label, compact = false }) {
  const first = daily[0]?.day || ''; const last = daily[daily.length - 1]?.day || '';
  const mid = daily[Math.floor(daily.length / 2)]?.day || '';
  return (
    <>
      <div className={`fu-bars${compact ? ' sm' : ''}`} role="img" aria-label={label}>
        {daily.map((d) => {
          const we = [0, 6].includes(new Date(`${d.day}T00:00:00Z`).getUTCDay());
          const cls = d.rec === 'off' ? 'gap' : d.today ? 'part' : we ? 'we' : '';
          const h = d.rec === 'off' ? 100 : Math.max(2, (d.views / Math.max(1, max)) * 100);
          return <i key={d.day} className={cls} style={{ height: `${h}%` }} title={d.rec === 'off' ? `${d.day} · 기록 꺼짐(값 없음)` : `${d.day} · 열람 ${fmtInt(d.views)}회 · 머문 ${fmtDur(d.ms)}${d.today ? ' · 오늘(부분)' : ''}`} />;
        })}
      </div>
      <div className="fu-axis"><span>{first.slice(5)}</span><span>{mid.slice(5)}</span><span>{last.slice(5)}</span></div>
      <div className="fu-lgd inline">
        <i style={{ background: '#3b82f6' }} /><span>평일</span>
        <i style={{ background: '#1e3a5f' }} /><span>주말</span>
        <i className="part" /><span>오늘(부분)</span>
        <i className="gap" /><span>기록 꺼짐(값 없음)</span>
      </div>
    </>
  );
}

/* ── 기능별 ───────────────────────────────────────────────────────────────── */
function Features({ rep, ctx }) {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => {
    const by = new Map(rep.byKey.map((r) => [r.k, r]));
    const prevOnly = new Map((rep.prevKeys || []).map((r) => [r.k, r.prevViews]));
    const keys = new Set([...allUsageKeys(ctx), ...rep.byKey.map((r) => r.k)]);
    return [...keys].map((k) => {
      const r = by.get(k);
      const prev = r ? r.prevViews : (rep.prev?.available ? (prevOnly.get(k) || 0) : null);
      return { k, meta: keyMeta(k, ctx), views: r?.views || 0, users: r?.users || 0, ms: r?.ms ?? 0, last: r?.last ?? null, prevViews: prev };
    }).sort((a, b) => b.views - a.views || (a.meta.label < b.meta.label ? -1 : 1));
  }, [rep, ctx]);
  const shown = filterFeatures(rows, { kind, status, q });
  const cnt = (f) => rows.filter(f).length;
  const total = rep.totals.views;
  return (
    <>
      <div className="card fu-panel">
        <div className="fu-fl">
          <span className="lb">종류</span>
          <Chips value={kind} onChange={setKind} items={[['', '전체', rows.length], ['tab', '탭', cnt((r) => r.meta.kind === 'tab')], ['tool', '도구', cnt((r) => r.meta.kind === 'tool')], ['settings', '설정 하위', cnt((r) => r.meta.kind === 'settings')], ['console', '관제 콘솔', cnt((r) => r.meta.kind === 'console')]]} />
          <span className="lb">상태</span>
          <Chips value={status} onChange={setStatus} items={[['', '전체'], ['used', '쓰임', cnt((r) => r.views > 0)], ['unused', '안 씀(0회)', rep.totals.recDays > 0 ? cnt((r) => !(r.views > 0) && !r.meta.notReady) : null], ['admin', '관리자 전용', cnt((r) => r.meta.adminOnly)], ['notReady', '준비 중', cnt((r) => r.meta.notReady)]]} />
          <label className="lb" htmlFor="fu-fq">검색</label>
          <input id="fu-fq" className="input fu-q" placeholder="기능 이름 · 메뉴 경로 · 화면 키" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="muted fu-note">‘안 씀’ 은 이 기간 0회입니다 — 권한 때문에 아무도 열 수 없는 화면일 수도 있습니다(권한 열 참고). 기록이 켜진 날이 없으면 ‘안 씀’ 을 세지 않습니다.</div>
      </div>
      <div className="card fu-panel">
        <div className="fu-ph"><b>기능 {shown.length}개</b><span className="muted">열람 내림차순 · 0회는 뒤 · 제목을 누르면 정렬</span></div>
        <STable className="fu-table" minWidth={960} limit={showAll ? 0 : FEATURE_LIMIT}>
          <thead><tr><th>기능</th><th>종류</th><th>어디서 여나</th><th>권한</th><th className="r">열람</th><th className="r">사용자</th><th className="r">머문 시간</th><th className="r">비중</th><th className="r">지난 기간 대비</th><th className="r">마지막 사용</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const tr = trendOf(r.views, r.prevViews, rep.totals.recDays, rep.prev?.onDays);
              const zero = !(r.views > 0);
              return (
                <tr key={r.k} className={zero ? 'z' : ''}>
                  <td title={r.k}><b>{r.meta.label}</b></td>
                  <td><span className={`badge ${KIND_BADGE[r.meta.kind] || 'gray'}`}>{r.meta.kindLabel}</span></td>
                  <td className="fu-pos">{r.meta.where}{r.meta.notReady && <> <span className="badge gray">준비 중</span></>}</td>
                  <td className="fu-pos">{r.meta.auth || '—'}</td>
                  <td className="r mono" data-sort={r.views}>{fmtInt(r.views)}</td>
                  <td className="r mono" data-sort={zero ? '' : r.users}>{zero ? '—' : fmtInt(r.users)}</td>
                  <td className="r mono" data-sort={zero ? '' : r.ms}>{zero ? '—' : fmtDur(r.ms)}</td>
                  <td className="r mono muted" data-sort={r.views}>{zero ? '—' : pctText(r.views, total)}</td>
                  <td className={`r fu-trend ${tr.dir}`} data-sort={r.prevViews == null ? '' : r.views - r.prevViews}>{zero && r.prevViews != null ? `직전 ${fmtInt(r.prevViews)}` : tr.text}</td>
                  <td className="r mono muted" data-sort={r.last ?? ''}>{fmtWhen(r.last)}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        {shown.length > FEATURE_LIMIT && (
          <div className="fu-more">
            <span className="muted">{showAll ? `${shown.length}개 전부 보는 중` : `정렬한 순서로 ${FEATURE_LIMIT}개만 보입니다 — 나머지 ${shown.length - FEATURE_LIMIT}개`}</span>
            <button type="button" className="btn btn-sm" onClick={() => setShowAll((v) => !v)}>{showAll ? `${FEATURE_LIMIT}개만 보기` : '전부 보기'}</button>
          </div>
        )}
      </div>
    </>
  );
}

function Chips({ value, onChange, items }) {
  return (
    <span className="fu-chips">
      {items.map(([k, label, c]) => (
        <button key={k || 'all'} type="button" className={value === k ? 'on' : ''} aria-pressed={value === k} onClick={() => onChange(k)}>
          {label}{c != null && <span className="c">{c}</span>}
        </button>
      ))}
    </span>
  );
}

/* ── 사용자별 ─────────────────────────────────────────────────────────────── */
function Users({ rep, ctx, onOpen }) {
  const [role, setRole] = useState('');
  const [scope, setScope] = useState('');
  const [src, setSrc] = useState('');
  const [q, setQ] = useState('');
  const users = filterUsers(rep.users, { role, scope, src, q });
  const idle = filterUsers(rep.idle, { role, scope, src, q });
  const views = rep.users.map((u) => u.views).sort((a, b) => a - b);
  const keysN = rep.users.map((u) => u.keys).sort((a, b) => a - b);
  const med = (a) => (a.length ? a[Math.floor((a.length - 1) / 2)] : null);
  const single = rep.users.filter((u) => u.keys === 1).length;
  const roles = [...new Set([...rep.users, ...rep.idle].map((u) => u.role).filter(Boolean))].sort();
  const maxSpark = (u) => Math.max(1, ...u.spark);
  return (
    <>
      <div className="fu-kpis four">
        <Kpi label="활성 사용자" value={fmtInt(rep.users.length)} unit={`/ ${fmtInt(rep.users.length + rep.idle.length)}`} meta={`미접속 ${rep.idle.length}명 — 표 맨 아래에 따로`} />
        <Kpi label="1인당 열람(중앙값)" value={fmtInt(med(views))} unit="회" meta={rep.users.length ? `평균 ${fmtInt(rep.totals.views / rep.users.length)}회` : '기록 없음'} />
        <Kpi label="1인당 쓰는 기능(중앙값)" value={fmtInt(med(keysN))} unit="개" meta="기간 안에 한 번이라도 연 화면 수" />
        <Kpi label="한 기능만 쓰는 사용자" value={fmtInt(rep.users.length ? single : null)} unit="명" meta="랜딩 화면만 보는 사용자가 많으면 첫 화면 기본값의 근거" />
      </div>
      <div className="card fu-panel">
        <div className="fu-fl">
          <span className="lb">역할</span>
          <Chips value={role} onChange={setRole} items={[['', '전체'], ...roles.map((r) => [r, r])]} />
          <span className="lb">범위</span>
          <Chips value={scope} onChange={setScope} items={[['', '전체'], ['full', '전 법인'], ['scoped', '법인 지정']]} />
          <span className="lb">출처</span>
          <Chips value={src} onChange={setSrc} items={[['', '전체'], ['local', '로컬'], ['ad', 'AD']]} />
          <label className="lb" htmlFor="fu-uq">검색</label>
          <input id="fu-uq" className="input fu-q" placeholder="계정 · 이름" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card fu-panel">
        <div className="fu-ph"><b>사용자 {users.length}명</b><span className="muted">열람 내림차순 · 계정을 누르면 개인 상세 · 마지막 접속은 이 기록의 마지막 열람(KST)</span></div>
        <STable className="fu-table" minWidth={1000}>
          <thead><tr><th>계정 · 이름</th><th>역할</th><th className="r">열람</th><th className="r">머문 시간</th><th className="r">활동일</th><th className="r">기능 수</th><th data-nosort>상위 3 기능</th><th data-nosort>일별</th><th className="r">마지막 접속</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user}>
                <td data-sort={u.user}><button type="button" className="fu-link mono" onClick={() => onOpen(u.user)}>{u.user}</button>{u.name && u.name !== u.user && <span className="muted"> {u.name}</span>}{u.src === 'ad' && <> <span className="badge gray">AD</span></>}{u.scoped && <> <span className="badge amber">법인 지정</span></>}</td>
                <td><span className={`badge ${ROLE_BADGE[u.role] || 'gray'}`}>{u.role || '—'}</span></td>
                <td className="r mono" data-sort={u.views}>{fmtInt(u.views)}</td>
                <td className="r mono" data-sort={u.ms}>{fmtDur(u.ms)}</td>
                <td className="r mono" data-sort={u.days}>{u.days} / {rep.range.days}</td>
                <td className="r mono" data-sort={u.keys}>{fmtInt(u.keys)}</td>
                <td><span className="fu-top3">{u.top.map((t) => { const lb = keyMeta(t.k, ctx).label; return <span key={t.k} title={`${lb} ${fmtInt(t.views)}회`}><i>{lb}</i><b>{fmtInt(t.views)}</b></span>; })}</span></td>
                <td><span className="fu-spark" aria-hidden="true">{u.spark.slice(-14).map((v, i) => <i key={i} style={{ height: `${(v / maxSpark(u)) * 100}%` }} />)}</span></td>
                <td className="r mono muted" data-sort={u.last ?? ''}>{fmtWhen(u.last)}</td>
              </tr>
            ))}
            {idle.map((u) => (
              <tr key={`idle-${u.user}`} className="z" data-pin="bottom">
                <td data-sort={u.user}><span className="mono">{u.user}</span>{u.name && u.name !== u.user && <span className="muted"> {u.name}</span>}{u.src === 'ad' && <> <span className="badge gray">AD</span></>}{u.scoped && <> <span className="badge amber">법인 지정</span></>}</td>
                <td><span className={`badge ${ROLE_BADGE[u.role] || 'gray'}`}>{u.role || '—'}</span></td>
                <td className="r mono" data-sort={0}>0</td><td className="r mono muted">—</td><td className="r mono">0 / {rep.range.days}</td><td className="r mono muted">—</td>
                <td className="muted">이 기간 미접속</td><td />
                <td className="r mono muted" data-sort={u.last ?? ''}>{u.last ? fmtWhen(u.last) : '기록 없음'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        <div className="muted fu-note">AD 계정은 계정 목록에 없어 이름 · 역할을 마지막 기록 시점의 값으로 보여 줍니다. 제외 계정(수집 설정)은 표에 나오지 않습니다. 일별은 최근 14일입니다.</div>
      </div>
    </>
  );
}

/* ── 개인 상세 드로어 ─────────────────────────────────────────────────────── */
function UserDrawer({ user, days, ctx, overall, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    setD(null); setErr(null);
    fetchJson(`/admin/usage/user/${encodeURIComponent(user)}`, { days })
      .then((r) => { if (id === reqId.current) setD(r); })
      .catch((e) => { if (id === reqId.current) setErr(e); });
  }, [user, days]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const mine = d ? bucketShares(d.byKey, ctx) : null;
  const all = overall ? bucketShares(overall.byKey, ctx) : null;
  return (
    <div className="fu-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="fu-drawer" role="dialog" aria-label={`${user} 상세`}>
        <div className="fu-dh">
          <div style={{ minWidth: 0 }}>
            <div className="fu-dname"><span className="mono">{user}</span> {d?.account?.name && d.account.name !== user && <span className="muted">{d.account.name}</span>}</div>
            {d && <div className="fu-pos"><span className={`badge ${ROLE_BADGE[d.account.role] || 'gray'}`}>{d.account.role || '—'}</span> · {d.account.scoped ? '법인 지정' : '전 법인'} · {SRC_LABEL[d.account.src] || '—'} 계정 · 마지막 열람 {fmtWhen(d.account.last)}</div>}
          </div>
          <button type="button" className="fu-x" aria-label="닫기" onClick={onClose}>×</button>
        </div>
        {err && <ErrorBox error={err} />}
        {!err && !d && <Loading />}
        {d && (
          <>
            <div className="fu-dk">
              <div><div className="lb">열람</div><div className="v mono">{fmtInt(d.totals.views)}<small>회</small></div></div>
              <div><div className="lb">머문 시간</div><div className="v">{fmtDur(d.totals.ms)}</div></div>
              <div><div className="lb">활동일</div><div className="v mono">{d.totals.days}<small>/ {d.range.days}</small></div></div>
              <div><div className="lb">쓴 기능</div><div className="v mono">{d.totals.keys}</div></div>
            </div>
            <div className="card fu-panel">
              <div className="fu-ph"><b>기능별</b><span className="muted">{d.byKey.length > 10 ? `상위 10 · 전체 ${d.byKey.length}개는 CSV` : `${d.byKey.length}개`}</span></div>
              <STable className="fu-table" minWidth={460} limit={10}>
                <thead><tr><th>기능</th><th className="r">열람</th><th className="r">머문</th><th className="r">비중</th><th className="r">마지막</th></tr></thead>
                <tbody>
                  {d.byKey.map((r) => (
                    <tr key={r.k}>
                      <td><b>{keyMeta(r.k, ctx).label}</b> <span className="fu-pos">{keyMeta(r.k, ctx).where.split(' › ')[0]}</span></td>
                      <td className="r mono" data-sort={r.views}>{fmtInt(r.views)}</td>
                      <td className="r mono" data-sort={r.ms}>{fmtDur(r.ms)}</td>
                      <td className="r mono muted" data-sort={r.views}>{pctText(r.views, d.totals.views)}</td>
                      <td className="r mono muted" data-sort={r.last ?? ''}>{fmtWhen(r.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
            <div className="card fu-panel">
              <div className="fu-ph"><b>일별 열람</b></div>
              <DayBars daily={d.daily} max={Math.max(1, ...d.daily.map((x) => x.views))} label={`${user} 일별 열람`} compact />
            </div>
            {mine && all && (
              <div className="card fu-panel">
                <div className="fu-ph"><b>메뉴 묶음별 · 전체와 비교</b></div>
                <div className="fu-cmp">
                  <span className="h">묶음</span><span className="h r">이 사용자</span><span className="h r">전체</span>
                  {BUCKETS.map((b) => {
                    const a = mine.rows.find((x) => x.id === b.id); const o = all.rows.find((x) => x.id === b.id);
                    return (
                      <React.Fragment key={b.id}>
                        <span><i style={{ background: b.color }} />{b.label}</span>
                        <span className="r mono">{pctText(a?.views, mine.total)}</span>
                        <span className="r mono muted">{pctText(o?.views, all.total)}</span>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/* ── 수집 설정 ────────────────────────────────────────────────────────────── */
function UsageSettings() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [exIn, setExIn] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [seq, setSeq] = useState(0);
  const [purge, setPurge] = useState({ scope: 'user', user: '', before: '', otp: '' });
  const [purgeMsg, setPurgeMsg] = useState('');
  const [purging, setPurging] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchJson('/admin/usage/settings').then((r) => { if (!alive) return; setData(r); setForm(r.settings); setErr(null); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [seq]);
  if (err) return <ErrorBox error={err} />;
  if (!data || !form) return <Loading />;
  const st = data.status || {};
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const r = await putJson('/admin/usage/settings', { enabled: form.enabled, idleMin: Number(form.idleMin), keepDays: Number(form.keepDays), excluded: form.excluded, noticeEnabled: form.noticeEnabled, notice: form.notice || null });
      if (r && r.ok === false) setMsg(`저장하지 못했습니다 — ${r.reason || '형식 오류'}`);
      else { setMsg('저장했습니다.'); setSeq((n) => n + 1); }
    } catch (e) { setMsg(`저장하지 못했습니다 — ${e?.message || e}`); } finally { setSaving(false); }
  };
  const addEx = () => {
    const v = exIn.trim();
    if (!v || form.excluded.some((x) => x.toLowerCase() === v.toLowerCase())) { setExIn(''); return; }
    set({ excluded: [...form.excluded, v] }); setExIn('');
  };
  const doPurge = async () => {
    const what = purge.scope === 'all' ? '모든 기록' : purge.scope === 'user' ? `‘${purge.user}’ 의 기록` : `${purge.before} 이전 기록`;
    if (!window.confirm(`${what}을 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) return;
    setPurging(true); setPurgeMsg('');
    try {
      const r = await postJson('/admin/usage/purge', purge);
      setPurgeMsg(r?.ok ? `${fmtInt(r.deleted)}행을 지웠습니다(감사 로그에 남겼습니다).` : `지우지 못했습니다 — ${r?.reason || '오류'}`);
      setPurge((p) => ({ ...p, otp: '' })); setSeq((n) => n + 1);
    } catch (e) { setPurgeMsg(`지우지 못했습니다 — ${e?.message || e}`); } finally { setPurging(false); }
  };
  const purgeReady = purge.scope === 'all' || (purge.scope === 'user' && purge.user.trim()) || (purge.scope === 'before' && /^\d{4}-\d{2}-\d{2}$/.test(purge.before));
  const dropped = Object.entries(st.dropped || {});
  return (
    <div className="fu-sgrid">
      <div className="card fu-panel">
        <div className="fu-ph"><b>수집</b><span className="muted">저장은 설정 소유자 · 감사 로그에 무엇이 어떻게 바뀌었는지 남습니다</span></div>
        {data.loadError && <div className="fu-band crit">설정 파일을 읽지 못했습니다({data.loadError.reason}) — 지금은 꺼짐으로 동작합니다. 손상본은 .corrupt.&lt;시각&gt; 으로 보존했습니다. 저장하면 이 값으로 다시 시작합니다.</div>}
        <div className="fu-row">
          <div className="l">기능 사용 기록<small>끄면 그 순간부터 신호를 받지 않습니다. 켜고 끈 시각과 계정을 남깁니다.</small></div>
          <div className="c">
            <label className="fu-toggle"><input type="checkbox" checked={!!form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <span>{form.enabled ? '켜짐' : '꺼짐'}</span></label>
            <div className="note">기본은 켜짐입니다(설치 · 업그레이드 직후부터 셉니다). 켜고 끈 것은 각 사용자가 다시 로그인하거나 새로고침한 뒤 화면 추적기에 반영되고, 그 사이 신호는 서버가 버립니다. 꺼져 있던 구간은 어떤 합계에도 0 으로 넣지 않습니다.</div>
          </div>
        </div>
        <div className="fu-row">
          <div className="l">머문 시간의 기준<small>‘보고 있다’ 로 치는 조건</small></div>
          <div className="c">
            <div className="fu-inl">
              <span>창이 보이고, 마지막 입력(마우스 · 키 · 스크롤 · 터치) 뒤</span>
              <input className="input fu-num" type="number" min={data.limits.idleMin[0]} max={data.limits.idleMin[1]} aria-label="유휴 한도(분)" value={form.idleMin} onChange={(e) => set({ idleMin: e.target.value })} />
              <span>분 이내인 시간만 더합니다</span>
            </div>
            <div className="note">벽면 모니터에 띄워 둔 화면이 하루 종일을 채우지 않게 하는 장치입니다({data.limits.idleMin[0]}~{data.limits.idleMin[1]}분). 화면이 30초마다 조각을 보내고 창이 가려질 때 남은 몫을 보내지만, 창을 닫는 순간의 마지막 조각은 빠질 수 있습니다.</div>
          </div>
        </div>
        <div className="fu-row">
          <div className="l">보관 기간<small>일 단위 집계만 보관합니다(원본 이벤트는 남기지 않습니다)</small></div>
          <div className="c">
            <div className="fu-inl"><input className="input fu-num" type="number" min={data.limits.keepDays[0]} max={data.limits.keepDays[1]} aria-label="보관 기간(일)" value={form.keepDays} onChange={(e) => set({ keepDays: e.target.value })} /><span>일 · 지난 것은 약 1시간마다 조각으로 지웁니다</span></div>
            <div className="note">{data.limits.keepDays[0]}~{data.limits.keepDays[1]}일. 포탈 백업에는 이 기록(usage.db)이 들어가지 않습니다.</div>
          </div>
        </div>
        <div className="fu-row">
          <div className="l">제외 계정<small>이 계정의 신호는 받지 않습니다</small></div>
          <div className="c">
            <div className="fu-inl">
              {form.excluded.map((x) => (
                <span key={x} className="fu-chipx">{x}<button type="button" aria-label={`${x} 제외 해제`} onClick={() => set({ excluded: form.excluded.filter((y) => y !== x) })}>×</button></span>
              ))}
              <input className="input fu-exin" placeholder="계정 추가 후 Enter" aria-label="제외할 계정" value={exIn} onChange={(e) => setExIn(e.target.value)} onKeyDown={(e) => { if (e.nativeEvent?.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); addEx(); } }} />
              <button type="button" className="btn btn-sm" onClick={addEx}>추가</button>
            </div>
            <div className="note">데모 계정은 기본으로 제외되어 있습니다. 제외를 풀어도 지난 기록은 생기지 않습니다(최대 {data.limits.excluded}개).</div>
          </div>
        </div>
        <div className="fu-row">
          <div className="l">무엇을 세나<small>범위 — 설명</small></div>
          <div className="c"><div className="note"><BoldText text={'상단 탭 · 특수 기능 도구 · 설정 하위 탭 · 관제 콘솔 페이지 — 즉 **주소가 바뀌는 화면 전환**만 셉니다. 1초 넘게 머문 화면만 열람 1회로 셉니다. 검색어 · 입력 값 · 조회한 장비 · 화면 안 버튼은 세지 않습니다. 엣지 포탈(법인) 사용은 들어오지 않습니다.'} /></div></div>
        </div>
        <div className="fu-row">
          <div className="l">사용자 고지<small>로그인 화면 아래에 보이는 문구</small></div>
          <div className="c">
            <label className="fu-toggle"><input type="checkbox" checked={!!form.noticeEnabled} onChange={(e) => set({ noticeEnabled: e.target.checked })} /> <span>기록이 켜져 있을 때 로그인 화면에 고지 문구 표시</span></label>
            <textarea className="input fu-ta" maxLength={data.limits.notice} aria-label="고지 문구" placeholder={data.defaultNotice} value={form.notice || ''} onChange={(e) => set({ notice: e.target.value })} />
            <div className="note">비워 두면 기본 문구를 씁니다 — 기본 문구의 보관 일수는 저장된 보관 기간을 따라갑니다.</div>
          </div>
        </div>
        <div className="fu-sv">
          <span className="muted">{data.settings.updatedAt ? `마지막 저장 ${fmtWhen(data.settings.updatedAt)} · ${data.settings.updatedBy || '—'}` : '아직 저장한 적이 없습니다(기본값)'}</span>
          {msg && <span className={msg.startsWith('저장했습니다') ? 'fu-ok' : 'fu-bad'}>{msg}</span>}
          <button type="button" className="btn" disabled={!dirty || saving} onClick={() => setForm(data.settings)}>되돌리기</button>
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? '저장 중…' : '저장'}</button>
        </div>
      </div>

      <div className="fu-col">
        <div className="card fu-panel">
          <div className="fu-ph"><b>지금 상태</b><span className={`badge ${st.enabled ? 'green' : 'gray'}`}>{st.enabled ? '기록 중' : '꺼짐'}</span></div>
          <div className="fu-kv">
            <span className="k">마지막 신호</span><span className="v">{st.lastSignal ? `${fmtWhen(st.lastSignal.at)} · ${st.lastSignal.user} · ${keyMeta(st.lastSignal.k).label}` : '—'}</span>
            <span className="k">오늘</span><span className="v">열람 {fmtInt(st.today?.views)} · 사용자 {fmtInt(st.today?.users)}</span>
            <span className="k">받은 · 반영한 신호</span><span className="v">{fmtInt(st.received)} · {fmtInt(st.accepted)} (서버 기동 {fmtWhen(st.since)} 이후)</span>
            <span className="k">버린 신호</span><span className="v">{dropped.length ? dropped.map(([k, v]) => `${DROP_LABEL[k] || k} ${fmtInt(v)}`).join(' · ') : '없음'}</span>
            <span className="k">저장 방식</span><span className="v">메모리에 모아 {Math.round((st.flushEveryMs || 60000) / 1000)}초마다 한 트랜잭션으로 일 집계에 더함 · 대기 {fmtInt(st.pending)}칸</span>
            <span className="k">마지막 저장</span><span className="v">{st.lastFlush ? `${fmtWhen(st.lastFlush.at)} · ${fmtInt(st.lastFlush.rows)}행${st.lastFlush.ok ? '' : ` · 실패(${st.lastFlush.reason})`}` : '—'}</span>
            <span className="k">DB</span><span className="v">{st.db?.ok ? `usage.db · ${fmtBytes(st.db.size)} · 가장 오래된 날 ${st.db.oldest || '—'}` : `열지 못함 — ${st.db?.error || '원인 미상'}`}</span>
          </div>
          {(data.settings.toggles || []).length > 0 && (
            <div className="muted fu-note">켜고 끈 기록: {data.settings.toggles.slice(-5).reverse().map((t) => `${fmtWhen(t.at)} ${t.on ? '켬' : '끔'}(${t.by || '—'})`).join(' · ')}</div>
          )}
        </div>

        <div className="card fu-panel">
          <div className="fu-ph"><b>기록 지우기</b></div>
          <div className="fu-band warn">되돌릴 수 없습니다. 설정 소유자 + <b>본인 OTP 재인증</b>(OTP 가 없는 계정은 설정 소유자만) + 감사 로그(범위 · 행 수 · 누가).</div>
          <div className="fu-inl">
            <label className="muted" htmlFor="fu-ps">범위</label>
            <Select sort={false} id="fu-ps" className="select" value={purge.scope} onChange={(e) => setPurge((p) => ({ ...p, scope: e.target.value }))}>
              {PURGE_SCOPES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
            </Select>
            {purge.scope === 'user' && <input className="input fu-exin" placeholder="계정" aria-label="지울 계정" value={purge.user} onChange={(e) => setPurge((p) => ({ ...p, user: e.target.value }))} />}
            {purge.scope === 'before' && <input className="input fu-exin" type="date" aria-label="이 날짜 이전" value={purge.before} onChange={(e) => setPurge((p) => ({ ...p, before: e.target.value }))} />}
          </div>
          <div className="fu-inl">
            <input className="input fu-otp mono" inputMode="numeric" autoComplete="one-time-code" placeholder="본인 OTP 6자리" aria-label="본인 OTP" value={purge.otp} onChange={(e) => setPurge((p) => ({ ...p, otp: e.target.value.replace(/\D/g, '').slice(0, 8) }))} />
            <button type="button" className="btn fu-danger" disabled={!purgeReady || purging} onClick={doPurge}>{purging ? '지우는 중…' : '지우기…'}</button>
          </div>
          {purgeMsg && <div className={purgeMsg.includes('지웠습니다') ? 'fu-ok' : 'fu-bad'}>{purgeMsg}</div>}
          <div className="muted fu-note">퇴직자 기록만 지우려면 ‘한 사용자’ 를 고릅니다. 보관 기간을 줄이는 것으로도 오래된 날은 지워집니다.</div>
        </div>
      </div>
    </div>
  );
}
