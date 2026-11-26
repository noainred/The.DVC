import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchHeavy } from './cvpHeavy.js';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Seg, Tiles, Spark, Pill, Pending } from './CvpNetParts.jsx';
import { idleText, RECLAIM_NOTE, forecastText, FORECAST_TONE, FORECAST_NOTE, perMonthText, speedText, pctText, dateText, rowKey, horizonText } from './cvpNetText.js';

/** 화면에 그리는 행 상한(서버는 더 많이 줄 수 있다 — 표가 정렬한 뒤 자른다). */
const SHOW_MAX = 300;

/**
 * CVP › 포트 구성도 › 회수 후보(⑤) · 고갈 · 포화 예측(⑨) — v3.38. 마운트 1회 + 새로고침(폴링 없음). 판정은 서버 cvp/portplan.js.
 */
export function ReclaimView({ onOpen }) {
  const [idle, setIdle] = useState('90');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [never, setNever] = useState(true);
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    const ac = new AbortController();   // v3.42(3회차 A5-F1): 화면이 버린 무거운 조회는 취소한다(서버 줄을 끝까지 차지하지 않게)
    fetchHeavy('/tools/cvp/portplan/reclaim', { idle }, ac.signal).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; ac.abort(); };
  }, [idle, reload]);
  if (err || !r) return <Pending err={err} onRetry={() => setReload((x) => x + 1)} />;
  const rows = (Array.isArray(r.rows) ? r.rows : []).filter((x) => never || !x.never);
  const c = r.counts || {};
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <span style={NOTE}>마지막 사용</span>
          <Seg label="기간" value={idle} onChange={setIdle} items={(r.choices || [30, 90, 180]).map((d) => [String(d), `${d}일 넘음`])} />
          <button type="button" className={`tab${never ? ' active' : ''}`} aria-pressed={never} onClick={() => setNever((x) => !x)}>기록 시작 뒤 사용 없음 포함 <b style={MONO}>{c.never ?? 0}</b></button>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={RECLAIM_NOTE} /></div>
        {r.backfilling && <div className="banner">이전 기록에서 마지막 사용일을 옮기는 중입니다(처음 한 번) — 잠시 뒤 새로고침하면 더 정확해집니다.</div>}
      </div>
      <Tiles tiles={[
        ['링크 없는 포트', c.down ?? 0, '관리 포트 제외', 'var(--text)'],
        [`${idle}일 넘게 미사용`, c.idle ?? 0, '마지막 사용일이 있는 포트', '#fbbf24'],
        ['기록 시작 뒤 사용 없음', c.never ?? 0, '일수로 세지 않습니다', '#93c5fd'],
        ['장비 기록 없음', c.noHistory ?? 0, '일 기록이 아직 없는 장비의 포트(후보 아님)', 'var(--text-dim)'],
        ...Object.entries(c.byIdle || {}).map(([d, n]) => [`${d}일 넘음`, n, '마지막 사용일 기준', 'var(--text)']),
      ]} />
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <STable className="v3-table" minWidth={960} limit={SHOW_MAX}>
          <thead><tr><th>법인</th><th>스위치</th><th>포트</th><th>속도</th><th>지금</th><th>마지막 사용</th><th>설명</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={rowKey(x)}>
                <td>{x.corpName || '법인 미지정'}</td>
                <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen(x)}>{x.hostname}</button></td>
                <td style={MONO}>{x.port}</td>
                <td data-sort={x.speedBps ?? ''}>{speedText(x.speedBps)}</td>
                <td>{x.admin === 'down' ? '관리상 꺼짐' : x.oper === 'nolink' ? '링크 없음' : '내려감'}</td>
                <td data-sort={x.never ? 100000 : (x.idleDays ?? '')}>{x.never ? <span style={{ color: '#93c5fd' }}>{idleText(x)}</span> : <>{idleText(x)} <span style={NOTE}>({dateText(x.lastLink)})</span></>}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 160, overflowWrap: 'anywhere', fontSize: 12.5 }}>{x.desc == null ? '(못 읽음)' : x.desc || '(설명 없음)'}{x.desc ? <span style={{ ...NOTE, marginLeft: 6 }}>— 설명이 있어 연결 예정일 수 있음</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!rows.length && <div style={NOTE}>조건에 맞는 포트가 없습니다.</div>}
        <div style={NOTE}>{rows.length > SHOW_MAX ? `${rows.length}개 중 정렬 순서 앞 ${SHOW_MAX}개 표시(제목을 눌러 정렬을 바꾸면 그 순서로 자릅니다)` : `${rows.length}개 표시`}{r.omitted ? ` · ⚠ 상위 ${r.rows.length}개만(${r.omitted}개 생략)` : ''}{r.truncated ? ' · ⚠ 포트 행이 상한을 넘어 일부만 봤습니다' : ''}{r.lastLinkTruncated ? ' · ⚠ 마지막 사용일 기록이 상한을 넘어 일부만 읽었습니다(‘기록 시작 뒤 사용 없음’ 중 일부는 실제로 쓴 포트일 수 있습니다)' : ''}{r.portsUnread ? ` · 포트 목록을 못 읽은 장비 ${r.portsUnread}대는 빠졌습니다` : ''}</div>
      </div>
    </div>
  );
}

/** 예측 표 각주 — 보고 있는 표(part)의 것만. */
function forecastNotes(part, ex, sat, r) {
  const out = [];
  if (part === 'exhaust') {
    if (ex.pointsRows && ex.rows.length > ex.pointsRows) out.push(`추이 그림은 위험한 순서 앞 ${ex.pointsRows}대만 싣습니다(그 뒤는 ‘—’)`);
  } else {
    if (sat.truncated) out.push(`⚠ 업링크가 상한을 넘어 ${sat.seriesUnread ? `${sat.seriesUnread}개는 기록을 읽지 않았습니다(예측에서 뺌 — 기록 부족이 아님)` : '일부만 봤습니다'}`);
    if (sat.omitted) out.push(`업링크 ${sat.omitted}개는 응답 상한을 넘어 뺐습니다(위험한 순서로 앞부분만)`);
    if (sat.pointsRows && sat.rows.length > sat.pointsRows) out.push(`추이 그림은 위험한 순서 앞 ${sat.pointsRows}개만 싣습니다(그 뒤는 ‘—’)`);
    if (r.portsUnread) out.push(`포트 목록을 못 읽은 장비 ${r.portsUnread}대는 업링크에서 뺐습니다`);
  }
  return out.length ? ` · ${out.join(' · ')}` : '';
}
export function ForecastView({ onOpen }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [part, setPart] = useState('exhaust');
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    const ac = new AbortController();   // v3.42(3회차 A5-F1): 화면이 버린 무거운 조회는 취소한다(서버 줄을 끝까지 차지하지 않게)
    fetchHeavy('/tools/cvp/portplan/forecast', {}, ac.signal).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; ac.abort(); };
  }, [reload]);
  if (err || !r) return <Pending err={err} onRetry={() => setReload((x) => x + 1)} />;
  const ex = r.exhaust || { rows: [], counts: {} }; const sat = r.saturation || { rows: [], counts: {} };
  const cur = part === 'exhaust' ? ex : sat;
  const cc = cur.counts || {};
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <Seg label="예측" value={part} onChange={setPart} items={[['exhaust', '포트 고갈'], ['saturation', sat.satPct == null ? '업링크 포화' : `업링크 포화(${sat.satPct}%)`]]} />
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={FORECAST_NOTE} /> 기록 {r.minDays}일 이상일 때 최근 {r.windowDays}일로 봅니다.</div>
      </div>
      <Tiles tiles={[
        ['이미 넘음', cc.already ?? 0, part === 'exhaust' ? '사용 포트 = 전체' : `일 최대 ${sat.satPct}% 이상`, FORECAST_TONE.already],
        [`${horizonText(r.horizonDays)} 안 도달`, cc.eta ?? 0, '직선 추세 기준', FORECAST_TONE.eta],
        [`${horizonText(r.horizonDays)} 넘게`, cc.far ?? 0, '', FORECAST_TONE.far],
        ['늘지 않음', cc.flat ?? 0, '예측 없음', 'var(--text-dim)'],
        ['기록 부족 · 끊김', (cc.short ?? 0) + (cc.none ?? 0) + (cc.stale ?? 0), `${r.minDays}일 미만 ${(cc.short ?? 0) + (cc.none ?? 0)} · 최근 기록 끊김 ${cc.stale ?? 0}`, 'var(--text-dim)'],
      ]} />
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {part === 'exhaust' ? (
          <STable className="v3-table" minWidth={980} limit={SHOW_MAX}>
            <thead><tr><th>법인</th><th>스위치</th><th>모델</th><th>사용 / 전체</th><th data-nosort>최근 사용 포트</th><th>증가</th><th>고갈 예상</th></tr></thead>
            <tbody>
              {ex.rows.map((x) => (
                <tr key={rowKey(x)}>
                  <td>{x.corpName || '법인 미지정'}</td>
                  <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen(x)}>{x.hostname}</button></td>
                  <td>{x.model || '—'}</td>
                  {/* v3.42(2회차 F1): 기록이 끊긴 장비는 used 가 null — 'null / 48' 이나 0% 로 보이지 않게 */}
                  <td data-sort={x.total && x.used != null ? x.used / x.total : ''} style={MONO}>{x.total == null || x.used == null ? (x.total == null ? '—' : `— / ${x.total}`) : `${x.used} / ${x.total}`}</td>
                  <td><Spark points={x.points} min={0} max={x.total ?? null} title="사용 포트 수" /></td>
                  <td data-sort={x.perMonth ?? ''} style={MONO}>{perMonthText(x.perMonth, '개')}</td>
                  <td data-sort={x.eta ?? (x.state === 'already' ? 0 : '')}><Pill color={FORECAST_TONE[x.state] || 'var(--text-dim)'}>{forecastText(x, { minDays: r.minDays, horizonDays: r.horizonDays })}</Pill></td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : (
          <STable className="v3-table" minWidth={980} limit={SHOW_MAX}>
            <thead><tr><th>스위치 · 법인</th><th>포트</th><th>속도</th><th>상대</th><th>최근 30일 최대</th><th data-nosort>일 최대 사용률</th><th>증가</th><th>포화 예상</th></tr></thead>
            <tbody>
              {sat.rows.map((x) => (
                <tr key={rowKey(x)}>
                  <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen(x)}>{x.hostname}</button><div style={{ ...NOTE, fontSize: 11.5 }}>{x.corpName || '법인 미지정'}</div></td>
                  <td style={MONO}>{x.port}</td>
                  <td data-sort={x.speedBps ?? ''}>{speedText(x.speedBps)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 120 }}>{x.peer || (x.basis === 'speed' ? <span style={NOTE}>(LLDP 못 읽음 — 속도로 추정)</span> : '—')}</td>
                  <td data-sort={x.max30 ?? ''} style={MONO}>{pctText(x.max30)}</td>
                  <td><Spark points={x.points} min={0} max={100} refLine={sat.satPct} title="일 최대 사용률(%)" /></td>
                  <td data-sort={x.perMonth ?? ''} style={MONO}>{perMonthText(x.perMonth, '%p')}</td>
                  <td data-sort={x.eta ?? (x.state === 'already' ? 0 : '')}><Pill color={FORECAST_TONE[x.state] || 'var(--text-dim)'}>{forecastText(x, { minDays: r.minDays, horizonDays: r.horizonDays })}</Pill></td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        {cur.rows.length > SHOW_MAX && <div style={NOTE}>{cur.rows.length}개 중 정렬 순서 앞 {SHOW_MAX}개 표시(제목을 눌러 정렬을 바꾸면 그 순서로 자릅니다)</div>}
        {!cur.rows.length && <div style={NOTE}>{part === 'exhaust' ? '장비가 없습니다.' : '업링크를 찾지 못했습니다(LLDP 이웃이 CVP 스위치인 포트 · LLDP 를 못 읽은 장비의 40G 이상 포트).'}</div>}
        {/* v3.42(3회차 A5-F3): 각주는 보고 있는 표의 것만 — 포화 표 각주가 고갈 탭에도 나오고 '추이 그림은 …' 이 두 번 나왔다 */}
        <div style={NOTE}>예상 날짜는 직선 추세의 추정이며 오늘 {dateText(Date.now())} 기준입니다{forecastNotes(part, ex, sat, r)}.</div>
      </div>
    </div>
  );
}
