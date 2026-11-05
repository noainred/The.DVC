import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import {
  LOGIN_PERIOD_KEYS, periodLabel, accountText, fmtDateTime, agoText, dayRangeToQuery, defaultCustomDays, periodSpanText, partialNote,
} from './loginHistoryText.js';

/**
 * 설정 › 로그 › 최근 로그인 · 로그인 횟수(v2.911). 두 화면이 같은 API(GET /admin/login-history)를 쓴다.
 * 숫자는 서버(security/loginHistory.js)가 만든다. 화면은 열 때 한 번 + '새로고침' 버튼으로만 부른다(폴링하지 않는다).
 */
function useLoginHistory(range) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    // 세대 가드 — 기간을 빠르게 바꿨을 때 늦게 온 이전 응답이 방금 결과를 덮지 않게.
    const my = ++seq.current;
    setBusy(true);
    const q = range ? `?from=${range.from}&to=${range.to}` : '';
    fetchJson(`/admin/login-history${q}`)
      .then((d) => { if (my === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (my === seq.current) setError(e); })
      .finally(() => { if (my === seq.current) setBusy(false); });
  }, [range]);
  useEffect(() => { load(); }, [load]);
  return { data, error, busy, load };
}

// 안내 줄(호박색 · 작은 글씨). 큰 오류 상자(error-box)는 화면 절반을 차지해 표를 밀어낸다(v2.911 Chromium 1440 확인).
const WARN = { fontSize: 12, lineHeight: 1.6, marginBottom: 8, color: 'var(--amber,#d97706)' };
// 숫자 열은 머리글도 오른쪽 정렬(값과 같은 줄에 선다).
// 요약 카드 — 400px 에서도 두 장씩(기본 .kpis 의 180px 최소폭이면 한 장씩 쌓여 표가 한참 아래로 밀린다).
const KPIS = { marginBottom: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' };
const NUM = { textAlign: 'right' };

/** 기록 상태 안내(인증 꺼짐 · 읽기 실패 · 첫 이관 · 깨진 줄 · 가장 오래된 기록). */
function HistoryNotes({ data }) {
  return (
    <>
      {data.authEnabled === false && (
        <div style={WARN}>⚠ 인증이 꺼져 있어(AUTH_ENABLED=false) 로그인 자체가 없으므로 기록이 쌓이지 않습니다.</div>
      )}
      {data.loadError && (
        <div style={{ ...WARN, color: 'var(--red,#ef4444)' }}>⚠ 로그인 기록 파일을 읽지 못했습니다({data.loadError}) — 원본은 보존했고 이번 기동 뒤의 로그인부터 다시 셉니다. 아래 횟수는 그 이전을 포함하지 않습니다.</div>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.6 }}>
        {data.coverageFrom != null
          ? <>가장 오래된 기록 {fmtDateTime(data.coverageFrom)} · 기록 {Number(data.records || 0).toLocaleString()}건 · 보관 {data.retainDays}일</>
          : <>아직 로그인 기록이 없습니다 · 보관 {data.retainDays}일</>}
        {data.backfilled > 0 && <> · 처음 켜질 때 감사 로그에 남아 있던 로그인 {data.backfilled}건을 옮겨 왔습니다(그 이전 기록은 없습니다)</>}
        {data.skippedLines > 0 && <> · 읽지 못한 줄 {data.skippedLines}개는 건너뛰었습니다</>}
      </div>
    </>
  );
}

const roleText = (r) => r || '—';

/** 설정 › 로그 › 최근 로그인 — 사용자별 마지막 로그인 + 최근 로그인 이력. */
export function RecentLogins() {
  const { data, error, busy, load } = useLoginHistory(null);
  const [q, setQ] = useState('');
  const users = useMemo(() => {
    const list = data?.users || [];
    const t = q.trim().toLowerCase();
    return t ? list.filter((u) => `${u.user} ${u.name || ''} ${u.lastIp || ''}`.toLowerCase().includes(t)) : list;
  }, [data, q]);
  const recent = useMemo(() => {
    const list = data?.recent || [];
    const t = q.trim().toLowerCase();
    return t ? list.filter((r) => `${r.user} ${r.ip || ''}`.toLowerCase().includes(t)) : list;
  }, [data, q]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const all = data.users || [];
  const active = (k) => all.filter((u) => u[k] > 0).length;
  const never = all.filter((u) => u.last == null).length;

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>최근 로그인</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
        이 포탈에 로그인한 기록을 사용자별로 보여 줍니다. 등록된 로컬 계정은 로그인한 적이 없어도 목록에 나옵니다.
        성공한 로그인만 셉니다 — 실패는 감사 로그와 특수 기능 › 로그인 실패 분석에서 봅니다. 엣지 포탈의 로그인은 그 엣지에만 기록됩니다.
      </div>
      <HistoryNotes data={data} />
      {error && <ErrorBox error={error} />}
      <div className="kpis" style={KPIS}>
        <Kpi label="사용자" value={all.length.toLocaleString()} meta="로컬 계정 + 기록에 있는 계정" />
        <Kpi label="최근 1일 로그인" value={active('d1').toLocaleString()} unit="명" meta={`${Number(data.totals?.d1 || 0).toLocaleString()}회`} />
        <Kpi label="최근 7일 로그인" value={active('d7').toLocaleString()} unit="명" meta={`${Number(data.totals?.d7 || 0).toLocaleString()}회`} />
        <Kpi label="기록 없음" value={never.toLocaleString()} unit="명" meta="보관 기간 안에 로그인 기록이 없는 계정" />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <SearchBox className="input" style={{ maxWidth: 260, minWidth: 0 }} placeholder="사용자 · 이름 · IP 검색" value={q} onChange={setQ} />
        <button className="logout-btn" style={{ padding: '6px 12px' }} disabled={busy} onClick={load}>{busy ? '불러오는 중…' : '새로고침'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{users.length.toLocaleString()}명</span>
      </div>
      <STable minWidth={760}>
        <thead><tr><th>사용자</th><th>마지막 로그인</th><th>경과</th><th>마지막 접속 IP</th><th style={NUM}>{periodLabel('d30', data.windows)}</th><th>역할</th><th>계정</th></tr></thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 22 }}>표시할 사용자가 없습니다.</td></tr>}
          {users.map((u) => (
            <tr key={u.user}>
              <td><b>{u.user}</b>{u.name ? <span className="muted" style={{ fontSize: 11 }}> · {u.name}</span> : null}</td>
              <td data-sort={u.last ?? ''} style={{ whiteSpace: 'nowrap' }}>{u.last != null ? fmtDateTime(u.last) : <span className="muted">기록 없음</span>}</td>
              <td data-sort={u.last != null ? data.now - u.last : ''} className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{agoText(u.last, data.now)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{u.lastIp || '—'}</td>
              <td data-sort={u.d30} style={NUM}>{u.d30.toLocaleString()}회</td>
              <td className="muted" style={{ fontSize: 12 }}>{roleText(u.role)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{accountText(u.account)}</td>
            </tr>
          ))}
        </tbody>
      </STable>

      <div className="section-title" style={{ margin: '18px 0 6px' }}>최근 로그인 이력</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>최신 {Number(data.recent?.length || 0).toLocaleString()}건{data.recentMax ? `(최대 ${data.recentMax}건)` : ''}입니다. 더 오래된 이력은 감사 로그에서 봅니다.</div>
      <div className="table-wrap" style={{ maxHeight: '50vh' }}>
        <STable minWidth={560} wrap={false}>
          <thead><tr><th>시각</th><th>사용자</th><th>접속 IP</th><th>역할</th><th>계정</th></tr></thead>
          <tbody>
            {recent.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 22 }}>기록이 없습니다.</td></tr>}
            {recent.map((r, i) => (
              <tr key={`${r.ts}-${r.user}-${i}`}>
                <td data-sort={r.ts} className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDateTime(r.ts)}</td>
                <td><b>{r.user}</b></td>
                <td className="muted" style={{ fontSize: 12 }}>{r.ip || '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>{roleText(r.role)}</td>
                <td className="muted" style={{ fontSize: 12 }}>{r.src === 'local' ? '로컬' : r.src === 'ad' ? 'AD' : '모름'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    </>
  );
}

/** 설정 › 로그 › 로그인 횟수 — 최근 1일 · 7일 · 1달(30일) · 사용자 정의 기간의 사용자별 로그인 횟수. */
export function LoginCounts() {
  const [period, setPeriod] = useState('d7');
  const [days, setDays] = useState(() => defaultCustomDays());
  const [applied, setApplied] = useState(null);     // 조회에 쓰인 사용자 정의 기간 { from, to }
  const [formErr, setFormErr] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const { data, error, busy, load } = useLoginHistory(period === 'range' ? applied : null);

  const applyCustom = () => {
    const r = dayRangeToQuery(days.fromDay, days.toDay);
    if (r.error) { setFormErr(r.error); return; }
    setFormErr('');
    setApplied(r);
  };
  const pick = (k) => {
    setPeriod(k);
    if (k === 'range' && !applied) {
      const r = dayRangeToQuery(days.fromDay, days.toDay);
      if (!r.error) setApplied(r);
    }
  };
  const key = period === 'range' && !data?.range ? null : period;
  const rows = useMemo(() => {
    const list = [...(data?.users || [])];
    if (!key) return list;
    const val = (u) => u[key] ?? -1;
    list.sort((a, b) => val(b) - val(a) || (b.last ?? -1) - (a.last ?? -1) || a.user.localeCompare(b.user));
    return onlyActive ? list.filter((u) => (u[key] || 0) > 0) : list;
  }, [data, key, onlyActive]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const showRange = !!data.range;
  const total = key ? data.totals?.[key] : null;
  const activeUsers = key ? (data.users || []).filter((u) => (u[key] || 0) > 0).length : null;
  const note = key ? partialNote(data, key) : '';
  const hi = (k) => (k === key ? { background: 'rgba(37,99,235,.10)' } : undefined);
  const label = periodLabel(period, data.windows);

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>로그인 횟수</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
        사용자별로 기간 안에 몇 번 로그인했는지 셉니다(성공한 로그인만). 최근 구간은 지금부터 거꾸로 센 {(data.windows || []).map((w) => `${w.days}일`).join(' · ')}이고,
        사용자 정의는 고른 시작일 0시부터 종료일 끝까지입니다(브라우저 시각 기준).
      </div>
      <HistoryNotes data={data} />
      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        {LOGIN_PERIOD_KEYS.map((k) => (
          <button key={k} className={period === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px' }}
            aria-pressed={period === k} onClick={() => pick(k)}>{periodLabel(k, data.windows)}</button>
        ))}
        <button className="logout-btn" style={{ padding: '6px 12px' }} disabled={busy} onClick={load}>{busy ? '불러오는 중…' : '새로고침'}</button>
      </div>
      {period === 'range' && (
        <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>시작일
            <input className="input" type="date" style={{ minWidth: 0 }} value={days.fromDay} onChange={(e) => setDays((d) => ({ ...d, fromDay: e.target.value }))} />
          </label>
          <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>종료일
            <input className="input" type="date" style={{ minWidth: 0 }} value={days.toDay} onChange={(e) => setDays((d) => ({ ...d, toDay: e.target.value }))} />
          </label>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy} onClick={applyCustom}>조회</button>
          {formErr && <span className="badge red">{formErr}</span>}
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {key ? (
        <div className="kpis" style={KPIS}>
          <Kpi label={`${label} 로그인`} value={Number(total || 0).toLocaleString()} unit="회" meta={periodSpanText(data, key)} />
          <Kpi label="로그인한 사용자" value={Number(activeUsers || 0).toLocaleString()} unit="명" meta={`전체 ${(data.users || []).length.toLocaleString()}명 중`} />
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>시작일과 종료일을 고르고 조회를 누르세요.</div>
      )}
      {note && <div style={WARN}>⚠ {note}</div>}
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyActive} disabled={!key} onChange={(e) => setOnlyActive(e.target.checked)} /> 선택 기간에 로그인한 사용자만
        </label>
        <span className="muted" style={{ fontSize: 12 }}>{rows.length.toLocaleString()}명</span>
      </div>
      <STable minWidth={showRange ? 860 : 720}>
        <thead>
          <tr>
            <th>사용자</th>
            {['d1', 'd7', 'd30'].map((k) => <th key={k} style={{ ...NUM, ...hi(k) }}>{periodLabel(k, data.windows)}</th>)}
            {showRange && <th style={{ ...NUM, ...hi('range') }}>{periodLabel('range')}</th>}
            <th>마지막 로그인</th><th>역할</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={showRange ? 7 : 6} className="center muted" style={{ padding: 22 }}>표시할 사용자가 없습니다.</td></tr>}
          {rows.map((u) => (
            <tr key={u.user}>
              <td><b>{u.user}</b>{u.name ? <span className="muted" style={{ fontSize: 11 }}> · {u.name}</span> : null}</td>
              {['d1', 'd7', 'd30'].map((k) => (
                <td key={k} data-sort={u[k]} style={{ ...NUM, ...hi(k) }}>{u[k] > 0 ? `${u[k].toLocaleString()}회` : <span className="muted">0회</span>}</td>
              ))}
              {showRange && (
                <td data-sort={u.range ?? ''} style={{ ...NUM, ...hi('range') }}>
                  {u.range > 0 ? `${u.range.toLocaleString()}회` : <span className="muted">0회</span>}
                </td>
              )}
              <td data-sort={u.last ?? ''} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                {u.last != null ? <>{fmtDateTime(u.last)} <span className="muted">· {agoText(u.last, data.now)}</span></> : <span className="muted">기록 없음</span>}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{roleText(u.role)}</td>
            </tr>
          ))}
        </tbody>
      </STable>
    </>
  );
}
