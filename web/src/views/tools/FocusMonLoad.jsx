/**
 * FocusMonLoad.jsx — 서버 집중 모니터링 '수집 부하' 탭(v2.983 — 사용자 2026-11-12 "이렇게 데이터를 수집하는게 엣지노드와 수집 대상 서버에 부하를 얼마나 주는지
 * 확인하는 방법, 서버에서 상태 수집해서 수집방법에 따른 분석해서 보여주는 기능" → 시안 ⑪ · 컨펌 '구현해줘' + 구획 비용 '늘 잼 · 세 묶음').
 *
 *  · 값은 응답 `/tools/focus-mon/load` 그대로 — 판정 · 추정 · 평균은 서버 load.js 하나(웹은 묶음 합 sumEstimates 만).
 *  · 최근 구간이면 30초마다 다시 묻는다(메모리 값 — 가볍다). 과거 구간은 DB 평균이라 구간이 바뀔 때 한 번만.
 *  · 값이 없으면 '—'(0 아님) · 2분 넘은 창은 '오래됨' 으로 따로 · 데모 값은 데모라고 밝힌다.
 */
import React, { useMemo, useState } from 'react';
import { putJson } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Seg, Badge } from './FocusMonBulk.jsx';
import { usePoll } from './focusMonPoll.js';
import {
  DASH, MODE_TEXT, pctText, msText, bytesText, numText, byteRateText, LOAD_JUDGE, loadJudgeNote, loadGroupLabel, LOAD_GROUPS, LOAD_GROUP_WHAT, loadReduceTips, LOAD_HOW,
  NODE_LOAD_NOTE, sumEstimates, clockText, nameTitle,
} from './focusMonText.js';

const BASE = '#/tools/focus-mon';

function JudgeBadge({ j }) { return j ? <Badge b={LOAD_JUDGE[j]} /> : <span className="fm-dim">{DASH}</span>; }

/** 줄 아래 패널 — 묶음별 CPU · 1회 비용 · 보내는 양 · 줄이는 방법 · 어떻게 쟀나. */
function LoadDetail({ r, onClose, d }) {
  const l = r.load;
  const topoSec = d.cadence?.topoSec;
  const tips = loadReduceTips(r, d.choices, topoSec);
  return (
    <div className="fm-pd">
      <div className="fm-row fm-between fm-pd-head">
        <span className="fm-row"><b>{r.name}</b><span className="fm-dim">{r.host} · {r.agent ? `엣지 ${r.agent}` : '중앙'}{l?.windowS ? ` · ${l.windows ? `분당 기록 ${l.windows}개 평균` : `최근 ${Math.round(l.windowS)}초 창`}` : ''}</span></span>
        <button type="button" className="fm-btn sm" onClick={onClose}>닫기</button>
      </div>
      {/* 반증 F6: 값이 없는 까닭을 단정하지 않는다 — 가능한 까닭을 늘어놓는다 */}
      {!l ? <span className="fm-dim">{r.staleS != null ? `마지막 창이 ${r.staleS}초 전이라(오래됨) 싣지 않았습니다.` : '이 서버의 수집 부하 창이 아직 없습니다.'} 가능한 까닭: 수집을 시작한 지 {d.cadence?.windowSec ?? DASH}초가 안 됨 · 이 서버를 맡은 엣지가 v2.983 전 판 · 원격 셸이 측정 줄을 내지 못함 · 연결이 끊김.</span> : (
        <div className="fm-pd-grid">
          <div className="fm-card">
            <h4 className="fm-h3">묶음별 — 이 서버에서 쓴 CPU</h4>
            {/* 좁은 카드 안이라 표 대신 묶음마다 두 줄(1440px 에서도 표가 카드보다 넓어 1회 · 횟수 · 보내는 양 열이 잘렸다 — 2026-11-12 화면 확인) */}
            <div className="fm-lgroups">
              {LOAD_GROUPS.map((g) => {
                const x = l.groups?.[g] || {};
                return (
                  <div key={g} className="fm-lgroup" title={LOAD_GROUP_WHAT[g]}>
                    <div className="fm-row fm-between"><span>{loadGroupLabel(g, r.procEvery, topoSec)}</span><b className="fm-num">{pctText(x.pct, 2)}</b></div>
                    <span className="fm-dim fm-num">1회 {msText(x.msPerRun)} × {x.runs ?? DASH}회 · 보내는 양 {byteRateText(l.bpsBy?.[g])}</span>
                  </div>
                );
              })}
            </div>
            <span className="fm-dim">합 {pctText(l.cpuPct, 2)} = 묶음 셋(묶음 사이의 반복 · sleep 은 기본 지표에 듭니다). sshd 몫 {pctText(l.sshdPct, 2)} 은 따로입니다.</span>
          </div>
          <div className="fm-card">
            <h4 className="fm-h3">줄이는 방법(이 서버 · 추정)</h4>
            {tips.length ? <ul className="fm-list">{tips.map((t) => <li key={t}>{t}</li>)}</ul> : <span className="fm-dim">추정할 값이 아직 없습니다.</span>}
            <span className="fm-dim">메모리: 반복문 셸 {bytesText(l.rssBytes)} · sshd 세션 {bytesText(l.sshdRssBytes)}{l.ncpu ? ` · 코어 ${l.ncpu}개` : ''}{l.procs != null ? ` · 프로세스 ${l.procs}개` : ''}</span>
          </div>
          <div className="fm-card">
            <h4 className="fm-h3">어떻게 쟀나</h4>
            <ul className="fm-list">{LOAD_HOW.map((t) => <li key={t}>{t}</li>)}</ul>
            {l.demo ? <span className="fm-why">데모 서버 — 값은 모형입니다(실측이 아닙니다).</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** 설정 — 프로세스 표본 주기 · 판정 문턱. 쓰기 문은 서버(admin · 전체 쓰기 범위 · 데모 차단)가 집행한다. */
function LoadSettings({ d, onSaved }) {
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const s = d.settings;
  const save = async (patch) => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/focus-mon/settings', patch);
      if (r?.ok === false) setMsg({ tone: 'bad', text: r.reason || '설정을 저장하지 못했습니다.' });
      else { setMsg({ tone: 'ok', text: r?.changed?.length ? '저장했습니다 — 수집 중인 서버는 다음 틱에 새 명령으로 다시 엽니다.' : '바뀐 값이 없습니다.' }); setForm(null); onSaved(); }
    } catch (e) { setMsg({ tone: 'bad', text: e?.body?.reason || e?.message || '설정을 저장하지 못했습니다.' }); }
    setBusy(false);
  };
  return (
    <div className="fm-card">
      <div className="fm-row fm-between"><h3 className="fm-h3">부하 손잡이</h3><span className="fm-dim">모든 서버 공통 · 중앙 설정</span></div>
      <div className="fm-row">
        <span className="fm-lbl">프로세스 표본 주기</span>
        <Seg label="프로세스 표본 주기" value={s.procEvery} onChange={(v) => { if (!busy && v !== s.procEvery) save({ procEvery: v }); }} options={d.choices.procEvery.map((p) => [p, `${p}초`])} />
      </div>
      <span className="fm-dim">프로세스가 많은 서버는 이 묶음이 부하를 정합니다. 늘리면 프로세스 표 · 세부 차트가 그만큼 성기게 갱신됩니다. 바꾸면 수집 중인 서버는 새 명령으로 다시 접속합니다(로그인 기록 한 줄).</span>
      <div className="fm-row">
        <span className="fm-lbl">판정</span>
        {loadJudgeNote(s).map(([k, t]) => <span key={k} className="fm-row fm-nowrap"><Badge b={LOAD_JUDGE[k]} /><span className="fm-dim">{t}</span></span>)}
        <span className="fm-dim">(코어 1개 기준)</span>
        <button type="button" className="fm-btn sm" onClick={() => setForm(form ? null : { loadWarnPct: String(s.loadWarnPct), loadCritPct: String(s.loadCritPct) })}>{form ? '닫기' : '문턱 바꾸기'}</button>
      </div>
      {form ? (
        <div className="fm-form">
          {[['loadWarnPct', '보통부터(%)'], ['loadCritPct', '큼부터(%)']].map(([k, label]) => (
            <label key={k} className="fm-fld"><span>{label} <small className="fm-dim">{d.ranges[k][0]}~{d.ranges[k][1]}</small></span><input className="fm-input" inputMode="numeric" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} /></label>
          ))}
          <button type="button" className="fm-btn pri" disabled={busy || !form.loadWarnPct || !form.loadCritPct} onClick={() => save({ loadWarnPct: Number(form.loadWarnPct), loadCritPct: Number(form.loadCritPct) })}>저장</button>
        </div>
      ) : null}
      {msg ? <span className={msg.tone === 'bad' ? 'fm-why' : 'fm-dim'}>{msg.text}</span> : null}
    </div>
  );
}

export function LoadTab({ main, tb }) {
  const params = useMemo(() => ({ win: tb.win, end: tb.end ?? '' }), [tb.win, tb.end]);
  const q = usePoll('/tools/focus-mon/load', params, tb.end == null ? 30_000 : 0, true);
  const [open, setOpen] = useState(null);
  const d = q.data;
  const rows = d?.targets || [];
  const measured = rows.filter((r) => r.load);
  const tById = useMemo(() => new Map((main.targets || []).map((t) => [t.id, t])), [main.targets]);
  const intervalSums = useMemo(() => (d ? d.choices.intervals.map((i) => ({ i, s: sumEstimates(measured, (r) => r.est?.byInterval?.[i]) })) : []), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const peSums = useMemo(() => (d ? d.choices.procEvery.map((p) => ({ p, s: sumEstimates(measured, (r) => r.est?.byProcEvery?.[p]) })) : []), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error && !d) return <ErrorBox error={q.error} />;
  if (!d) return <Loading />;
  const tt = d.totals;
  const central = d.nodes.find((x) => x.kind === 'central');
  const curSum = measured.length ? measured.reduce((a, r) => a + (r.load.cpuPct ?? 0), 0) : null;
  const curBps = measured.length ? measured.reduce((a, r) => a + (r.load.bps ?? 0), 0) : null;
  const maxSum = Math.max(1e-9, ...intervalSums.map((x) => x.s?.cpuPct ?? 0), ...peSums.map((x) => x.s?.cpuPct ?? 0), curSum ?? 0);
  const bar = (v) => (v == null ? null : <span className="fm-lbar"><i style={{ width: `${Math.max(1, Math.min(100, (v / maxSum) * 100))}%` }} /></span>);
  return (
    <>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {d.mock ? <div className="fm-ban">데모 모드 — 데모 서버 · 데모 엣지의 값은 모형입니다(실측이 아닙니다). 등록한 실제 서버는 실제로 잽니다.</div> : null}
      {!d.dbOk ? <div className="fm-ban w">기록 DB 를 읽지 못해 지난 구간 값을 보여 드릴 수 없습니다.</div> : null}
      <div className="fm-kpis">
        <div className="fm-card fm-kpi"><span className="l">대상 서버 — 수집 CPU 평균</span><span className="v">{tt.cpuAvg == null ? DASH : numText(tt.cpuAvg, 2)}{tt.cpuAvg == null ? null : <small>%</small>}</span><span className="s">{tt.cpuMax ? `코어 1개 기준 · 최고 ${tt.cpuMax.name} ${pctText(tt.cpuMax.pct, 2)}` : '값이 있는 서버가 없습니다'}{tt.missing ? ` · 값 없음 ${tt.missing}대` : ''}</span></div>
        <div className="fm-card fm-kpi"><span className="l">노드 — 중앙 포탈 CPU</span><span className="v">{central?.load?.cpuPct == null ? DASH : numText(central.load.cpuPct, 1)}{central?.load?.cpuPct == null ? null : <small>%</small>}</span><span className="s">{central?.load ? `그중 집중 모니터링 해석 ${pctText(central.load.fmPct, 2)} · 루프 사용률 ${pctText(central.load.eluPct, 1)} · 가장 긴 멈춤 ${msText(central.load.elMaxMs)}` : '이 노드에 수집기가 없어 재지 않습니다'}</span></div>
        <div className="fm-card fm-kpi"><span className="l">보내는 양 — 대상 → 노드</span><span className="v fm-v-sm">{byteRateText(tt.bps)}</span><span className="s">중앙 직접 {byteRateText(tt.centralDirectBps)} · 엣지 법인 안 {byteRateText(tt.edgeLocalBps)} · 엣지 → 중앙 {byteRateText(tt.edgeToCentralBps)}</span></div>
        <div className="fm-card fm-kpi"><span className="l">기록 DB 쓰기(중앙)</span><span className="v fm-v-sm">{byteRateText(tt.dbWriteBps)}</span><span className="s">{tt.dbRetentionBytes == null ? '아직 모릅니다(쓰기 기록이 더 필요합니다)' : `${d.live ? `최근 ${(central?.load?.dbWindowS ?? 0) >= 60 ? `${Math.round(central.load.dbWindowS / 60)}분` : `${central?.load?.dbWindowS ?? DASH}초`} 평균` : '구간 평균'} · 이 속도로 ${d.settings.retentionDays}일이면 약 ${bytesText(tt.dbRetentionBytes)}(줄 본문 기준 추정 — 색인 · 쪽 여유만큼 실제 파일은 더 크고, 오래된 기록 정리 · 용량 상한은 빠짐)`}</span></div>
      </div>

      <div className="fm-card fm-flush">
        <div className="fm-pad fm-col">
          <div className="fm-row fm-between">
            <h3 className="fm-h3">대상 서버 — 수집이 그 서버에서 쓴 것</h3>
            <span className="fm-row">{loadJudgeNote(d.settings).map(([k, t]) => <span key={k} className="fm-row fm-nowrap"><Badge b={LOAD_JUDGE[k]} /><span className="fm-dim">{t}</span></span>)}<span className="fm-dim">(코어 1개 기준)</span></span>
          </div>
          <span className="fm-dim">{d.live ? `수집 중인 서버마다 최근 ${d.cadence?.windowSec ?? DASH}초 창 · ${d.liveMaxS}초 넘게 새 창이 없으면 ‘오래됨’` : `${clockText(d.from, true)} ~ ${clockText(d.to)} 구간의 분당 기록 평균(그 구간에 기록이 있는 서버만)`} · 줄을 누르면 묶음별 비용 · 줄이는 방법이 그 줄 아래에 열립니다.</span>
        </div>
        {rows.length ? (
          <div className="fm-tblbox">
            <STable className="fm-table" minWidth={980}>
              <thead><tr><th>서버</th><th>노드</th><th className="fm-r">주기</th><th>방식</th><th className="fm-r">프로세스</th><th className="fm-r" title="반복문 셸 + 끝난 자식(grep · awk · sleep …) · 코어 1개 = 100%">수집 CPU</th><th className="fm-r">sshd</th><th className="fm-r" title="수집 CPU ÷ 코어 수">서버 전체 대비</th><th className="fm-r">보내는 양</th><th className="fm-r">메모리</th><th>판정</th></tr></thead>
              <tbody>{rows.map((r) => {
                const l = r.load; const on = open === r.id;
                const t = tById.get(r.id);
                return (
                  <React.Fragment key={r.id}>
                    <tr className={`fm-click ${on ? 'fm-sel' : ''}`} tabIndex={0} aria-expanded={on} onClick={() => setOpen(on ? null : r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(on ? null : r.id); } }}>
                      <td data-sort={r.name}><span className="fm-name" title={t ? nameTitle(t) : r.name}>{r.name}</span>{r.demo ? <span className="fm-badge off">데모</span> : null}</td>
                      <td>{r.agent ? `엣지 ${r.agent}` : '중앙'}</td>
                      <td className="fm-r fm-num" data-sort={r.interval ?? null}>{r.interval ? `${r.interval}초` : DASH}</td>
                      <td>{r.mode ? MODE_TEXT[r.mode] || r.mode : <span className="fm-dim">{d.live ? '끝남' : DASH}</span>}</td>
                      <td className="fm-r fm-num" data-sort={l?.procs ?? null}>{l?.procs ?? DASH}</td>
                      <td className="fm-r fm-num" data-sort={l?.cpuPct ?? null}>{l ? pctText(l.cpuPct, 2) : r.staleS != null ? <span className="fm-dim" title={`마지막 창 ${r.staleS}초 전`}>오래됨</span> : DASH}</td>
                      <td className="fm-r fm-num" data-sort={l?.sshdPct ?? null}>{pctText(l?.sshdPct, 2)}</td>
                      <td className="fm-r fm-num" data-sort={l?.serverPct ?? null}>{pctText(l?.serverPct, 2)}</td>
                      <td className="fm-r fm-num" data-sort={l?.bps ?? null}>{byteRateText(l?.bps)}</td>
                      <td className="fm-r fm-num" data-sort={l?.rssBytes ?? null}>{bytesText(l?.rssBytes)}</td>
                      <td data-sort={r.judge ? ['light', 'mid', 'heavy'].indexOf(r.judge) : null}><JudgeBadge j={r.judge} /></td>
                    </tr>
                    {on ? <tr className="fm-editrow"><td colSpan={11}><div className="fm-edbox"><LoadDetail r={r} d={d} onClose={() => setOpen(null)} /></div></td></tr> : null}
                  </React.Fragment>
                );
              })}</tbody>
            </STable>
          </div>
        ) : <div className="fm-pad fm-dim">{d.live ? `지금 수집 중인 서버가 없습니다 — 수집을 시작하면 약 ${d.cadence?.windowSec ?? DASH}초 뒤 첫 창이 나옵니다.` : '이 구간에 남은 수집 부하 기록이 없습니다.'}</div>}
      </div>

      <div className="fm-card fm-flush">
        <div className="fm-pad fm-col"><h3 className="fm-h3">노드 — 수집을 맡은 포탈(중앙 · 엣지)</h3><span className="fm-dim">{NODE_LOAD_NOTE}</span></div>
        <div className="fm-tblbox">
          <STable className="fm-table" minWidth={980}>
            <thead><tr><th>노드</th><th className="fm-r">맡은 서버</th><th className="fm-r">SSH 세션</th><th className="fm-r">포탈 CPU</th><th className="fm-r">그중 집중 모니터링</th><th className="fm-r">메모리</th><th className="fm-r" title="이벤트 루프가 바빴던 시간 비율 · 창 안에서 가장 긴 멈춤(±20ms)">루프 사용률 · 가장 긴 멈춤</th><th className="fm-r">받는 양</th><th className="fm-r">중앙으로</th><th className="fm-r">DB 쓰기</th></tr></thead>
            <tbody>{d.nodes.map((x) => {
              const l = x.load;
              return (
                <tr key={`${x.kind}-${x.node}`}>
                  <td data-sort={x.label}>{x.kind === 'central' ? '중앙' : `엣지 ${x.label}`}{x.demo ? <span className="fm-badge off">데모</span> : null}{!l ? <small className="fm-dim"> 표본 없음(수집기가 없거나 v2.983 전 판)</small> : null}</td>
                  <td className="fm-r fm-num">{x.servers}</td>
                  <td className="fm-r fm-num" data-sort={l?.sessions ?? null}>{l?.sessions ?? DASH}</td>
                  <td className="fm-r fm-num" data-sort={l?.cpuPct ?? null}>{pctText(l?.cpuPct, 1)}</td>
                  <td className="fm-r fm-num" data-sort={l?.fmPct ?? null}>{pctText(l?.fmPct, 2)}</td>
                  <td className="fm-r fm-num" data-sort={l?.rssBytes ?? null}>{bytesText(l?.rssBytes)}</td>
                  <td className="fm-r fm-num" data-sort={l?.eluPct ?? null}>{pctText(l?.eluPct, 1)} <small className="fm-dim">{msText(l?.elMaxMs)}</small></td>
                  <td className="fm-r fm-num" data-sort={l?.rxBps ?? null}>{byteRateText(l?.rxBps)}</td>
                  <td className="fm-r fm-num" data-sort={l?.txBps ?? null}>{x.kind === 'central' ? <span className="fm-dim">{DASH}</span> : byteRateText(l?.txBps)}</td>
                  <td className="fm-r fm-num" data-sort={l?.dbWriteBps ?? null}>{x.kind === 'central' ? byteRateText(l?.dbWriteBps) : <span className="fm-dim" title="엣지는 기록하지 않습니다 — 중앙이 기록합니다">{DASH}</span>}</td>
                </tr>
              );
            })}</tbody>
          </STable>
        </div>
      </div>

      <div className="fm-two">
        <div className="fm-card">
          <div className="fm-row fm-between"><h3 className="fm-h3">수집 방법별 분석 — 모든 서버를 이 주기로 바꾸면</h3><span className="fm-dim">추정 · 잰 1회 비용 × 횟수</span></div>
          {measured.length ? (
            <>
              <div className="fm-tblbox">
                <STable className="fm-table" minWidth={560} sortable={false}>
                  <thead><tr><th>주기</th><th className="fm-r">기본</th><th className="fm-r">구성</th><th className="fm-r">프로세스</th><th className="fm-r">CPU 합</th><th className="fm-lcol" /><th className="fm-r">보내는 양 합</th></tr></thead>
                  <tbody>
                    <tr className="fm-sum"><td>지금(서버마다 다름)</td><td colSpan={3} className="fm-dim">잰 값</td><td className="fm-r fm-num">{pctText(curSum, 2)}</td><td>{bar(curSum)}</td><td className="fm-r fm-num">{byteRateText(curBps)}</td></tr>
                    {intervalSums.map(({ i, s }) => (
                      <tr key={i}><td>{i}초</td>{LOAD_GROUPS.map((g) => <td key={g} className="fm-r fm-num">{pctText(s?.by?.[g], 2)}</td>)}<td className="fm-r fm-num">{pctText(s?.cpuPct, 2)}</td><td>{bar(s?.cpuPct)}</td><td className="fm-r fm-num">{byteRateText(s?.bps)}</td></tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              <span className="fm-dim">값이 있는 {measured.length}대의 합(코어 1개 = 100% · 서버마다 따로 쓰는 CPU 의 합입니다). 프로세스 묶음은 표본 주기({d.settings.procEvery}초)마다라 주기를 늘려도 그 주기까지는 그대로입니다. 묶음 비용을 모르는 서버가 있으면 그 칸은 —(0 으로 치지 않습니다).</span>
            </>
          ) : <span className="fm-dim">값이 있는 서버가 없어 추정하지 않습니다.</span>}
        </div>
        <div className="fm-card">
          <div className="fm-row fm-between"><h3 className="fm-h3">프로세스 표본 주기를 바꾸면</h3><span className="fm-dim">추정 · 주기는 서버마다 지금 그대로</span></div>
          {measured.length ? (
            <div className="fm-tblbox">
              <STable className="fm-table" minWidth={460} sortable={false}>
                <thead><tr><th>표본 주기</th><th className="fm-r">프로세스 묶음</th><th className="fm-r">CPU 합</th><th className="fm-lcol" /><th className="fm-r">보내는 양 합</th></tr></thead>
                <tbody>{peSums.map(({ p, s }) => (
                  <tr key={p} className={p === d.settings.procEvery ? 'fm-sel' : ''}><td>{p}초{p === d.settings.procEvery ? ' · 지금' : ''}</td><td className="fm-r fm-num">{pctText(s?.by?.proc, 2)}</td><td className="fm-r fm-num">{pctText(s?.cpuPct, 2)}</td><td>{bar(s?.cpuPct)}</td><td className="fm-r fm-num">{byteRateText(s?.bps)}</td></tr>
                ))}</tbody>
              </STable>
            </div>
          ) : <span className="fm-dim">값이 있는 서버가 없어 추정하지 않습니다.</span>}
          <LoadSettings d={d} onSaved={q.reload} />
        </div>
      </div>
      <div className="fm-note">수집 CPU 는 코어 1개 기준입니다(서버 전체 대비는 코어 수로 나눈 값). sshd 몫(암호 처리)은 보내는 양 · 암호 방식에 따라 다릅니다. 측정 자체도 비용입니다 — {d.cadence?.windowSec ?? DASH}초마다 /proc 파일 두 개를 더 읽고, 묶음마다 셸 내장 명령으로 한 번 더 읽습니다. 실제 RHEL 7.8 서버에서는 아직 재 보지 않았습니다(이 개발 환경에서만 쟀습니다). <a href={`${BASE}/targets`}>대상 · 키</a></div>
    </>
  );
}
