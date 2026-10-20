/**
 * '아이실론 디렉터리 사용량' 서브메뉴(v2.739) — 법인 현황 · 전 법인 Top 10 · 수집 상태.
 *  · v2.740(사용자 요청): 서머리 탭을 없앴다(첫 화면은 법인 현황). 수집 대상 설정은 설정 › 수집 서버 › 아이실론 디렉터리 사용량(슈퍼 관리자 전용)으로 옮겼다.
 * 배치는 승인된 시안(Claude Design '아이실론 디렉터리 사용량 서브메뉴 시안' 4장)을 따른다. 계산은 isiduOverviewText.js(순수)가 한다.
 *  · 대상 목록(상태·법인·장비)은 메인 목록 응답, 7일 변화·30일 추이·상위 폴더는 개요 응답(`/tools/isilon-dirusage/overview`)이다.
 *  · 개요를 아직 못 받았으면 그 칸만 '불러오는 중' 이고, 받지 못했으면 그 사실을 말한다(0 으로 채우지 않는다).
 */
import React, { useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { agoText } from './relTime.js';
import {
  bytesText, deltaView, shareText, countText, nodeText, everyText, durationText, targetStatus, targetChip, keyStatus, keyRows, triggerText, failTitle, targetMailLine, tailPath,
} from './isiduText.js';
import {
  STATUS_GROUPS, statusCounts, crossTop, corpChoices, corpCards, CORP_SORTS, miniLine, nextRunOf, aheadText, attemptText,
  ovStatus, ovBanner, topEmptyText, cardOvText, corpChipView, noResultCount, OV_UNREAD,
} from './isiduOverviewText.js';

function Delta({ d, isNew = null, hasBase = true, unread = false }) {
  const v = deltaView(d, { isNew, hasBase, unread });
  return <span className={`isd-delta t-${v.tone}`} title={v.title || undefined}>{v.text}</span>;
}

function Tag({ st }) { return <span className={`isd-tag ${st.tone}`} title={st.detail || undefined}>{st.text}</span>; }

function Progress({ prog }) {
  if (!prog) return null;
  return (
    <span className={`isd-prog${prog.over ? ' over' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog.pct * 100)} aria-label="시한 대비 경과">
      <span style={{ width: `${Math.max(2, Math.round(prog.pct * 100))}%` }} />
    </span>
  );
}

/** 개요를 못 읽었거나(직전 값도 없음) 새로 못 읽었으면(직전 값 표시 중) 그 사실을 말한다 — 판정·문구는 ovBanner(v2.740 D-02). */
function OvState({ ov }) {
  const b = ovBanner(ov);
  return b ? <div className={`isd-banner ${b.tone}`}>{b.text}</div> : null;
}

/* ═══════════════ ② 법인 현황 ═══════════════ */

function MiniLine({ points, ovSt }) {
  const W = 240; const H = 44;
  const g = miniLine(points, W, H);
  if (!g.d && !g.dots.length) return <div className="isd-note">{cardOvText('trend', ovSt)}</div>;
  return (
    <svg className="isd-mini" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {g.d ? <path d={g.d} fill="none" stroke="#2dd4bf" strokeWidth="1.8" vectorEffect="non-scaling-stroke" /> : null}
      {g.dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.4" fill={p.partial ? 'none' : '#2dd4bf'} stroke={p.partial ? '#fbbf24' : 'none'} />)}
      {g.last ? <circle cx={g.last.x} cy={g.last.y} r="3" fill="#5eead4" /> : null}
    </svg>
  );
}

export function CorpsView({ targets, ov, ovById, now, openTarget }) {
  const [mode, setMode] = useState('card');
  const [sort, setSort] = useState('size');
  const ovSt = ovStatus(ov);
  const unread = ovSt === 'unread';
  const cards = useMemo(() => corpCards(targets, ovById, now, sort, { unread }), [targets, ovById, now, sort, unread]);
  return (
    <>
      <OvState ov={ov} />
      <div className="isd-toolbar">
        <div className="isd-seg" role="group" aria-label="보기">
          <button type="button" className={mode === 'card' ? 'on' : ''} aria-pressed={mode === 'card'} onClick={() => setMode('card')}>카드</button>
          <button type="button" className={mode === 'table' ? 'on' : ''} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>표</button>
        </div>
        <label className="isd-inline">정렬
          <Select value={sort} onChange={(e) => setSort(e.target.value)} sort={false}>
            {CORP_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </label>
        <span className="isd-note">대상 {countText(cards.length)}개 · 카드를 누르면 사용자별 용량을 봅니다</span>
      </div>
      {mode === 'card' ? (
        <div className="isd-ccards">
          {cards.map((c) => (
            <section key={c.t.id} className="isd-ccard" aria-label={`${c.corp || '법인 미지정'} ${c.t.label || c.chip.device}`}>
              <div className="head"><b>{c.corp || '법인 미지정'}</b><span className="isd-note">{c.t.label || ''}</span><Tag st={c.st} /></div>
              <div className="dev">{c.chip.device} · <span className={`isd-node${c.t.agent ? ' edge' : ''}`}>{c.chip.node}</span> · <span className="isd-mono">{c.chip.path}</span></div>
              {c.bytes != null ? (
                <>
                  <div className="stats">
                    <span><small>사용자 폴더</small>{countText(c.users)}</span>
                    <span><small>크기</small>{bytesText(c.bytes)}</span>
                    <span><small>7일 변화</small><Delta d={c.d7} hasBase={c.hasBase} unread={c.ovUnread} /></span>
                    <span><small>마지막 성공</small>{agoText(c.okTs, now)}</span>
                  </div>
                  <MiniLine points={c.points} ovSt={ovSt} />
                  {c.top3.length ? (
                    <ol className="top3">
                      {c.top3.map((u) => <li key={u.name}><span className="nm">{u.name}</span><span className="isd-mono">{bytesText(u.bytes)}</span><Delta d={u.d7} isNew={u.new7} hasBase={c.hasBase} /></li>)}
                    </ol>
                  ) : <div className="isd-note">{cardOvText('top3', ovSt)}</div>}
                </>
              ) : (
                <div className="isd-empty"><b>{c.st.text}</b>{c.st.detail ? <div className="isd-note">{c.st.detail}</div> : null}{c.prog ? <Progress prog={c.prog} /> : null}</div>
              )}
              <div className="foot"><button type="button" className="isd-btn small" onClick={() => openTarget(c.t.id)}>사용자별 보기 →</button></div>
            </section>
          ))}
        </div>
      ) : (
        <section className="isd-card">
          <STable className="v3-table" minWidth={980}>
            <thead><tr><th>법인</th><th>대상</th><th>아이실론</th><th>실행 노드</th><th style={{ textAlign: 'right' }}>사용자 폴더</th><th style={{ textAlign: 'right' }}>크기</th><th style={{ textAlign: 'right' }}>7일 변화</th><th>마지막 성공</th><th>상태</th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.t.id}>
                  <td>{c.corp || '법인 미지정'}</td>
                  <td><button type="button" className="isd-namebtn" onClick={() => openTarget(c.t.id)}>{c.t.label || c.t.id}</button><div className="isd-note isd-mono">{c.chip.path}</div></td>
                  <td>{c.chip.device}</td>
                  <td><span className={`isd-node${c.t.agent ? ' edge' : ''}`}>{c.chip.node}</span></td>
                  <td className="isd-mono" style={{ textAlign: 'right' }} data-sort={c.users ?? ''}>{countText(c.users)}</td>
                  <td className="isd-mono" style={{ textAlign: 'right' }} data-sort={c.bytes ?? ''}>{bytesText(c.bytes)}</td>
                  <td style={{ textAlign: 'right' }} data-sort={c.d7?.bytes ?? ''}><Delta d={c.d7} hasBase={c.hasBase} unread={c.ovUnread} /></td>
                  <td data-sort={c.okTs ?? ''}>{agoText(c.okTs, now)}</td>
                  <td><Tag st={c.st} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
        </section>
      )}
    </>
  );
}

/* ═══════════════ ③ 수집 상태 ═══════════════ */

const LEGEND = [
  ['ok', '정상', '마지막 수집이 주기 안에 성공했습니다.'],
  ['warn', '주의', '성공했지만 du 가 일부 폴더를 읽지 못했거나(권한 오류 — 합계는 하한), 마지막 성공이 주기의 두 배보다 오래됐습니다.'],
  ['run', '진행 중', '지금 du 가 돌고 있거나 엣지가 요청을 가져갔습니다. 막대는 시한 대비 경과입니다.'],
  ['bad', '실패', '마지막 시도가 실패했습니다(사유는 칸에 적습니다). 실패 뒤에는 주기와 1시간 중 짧은 쪽마다 다시 시도합니다.'],
  ['muted', '꺼짐 · 수집 전', '주기 수집을 끈 대상이거나 아직 한 번도 수집하지 않았습니다.'],
];

export function StatusView({ targets, data, ov, now, runNow, busy, openTarget, openBulk, filter, setFilter }) {
  const counts = useMemo(() => statusCounts(targets, now), [targets, now]);
  const rows = (targets || []).map((t) => ({ t, st: targetStatus(t, now) })).filter((x) => !filter || filter === 'all' || x.st.tone === filter);
  const byId = useMemo(() => new Map((targets || []).map((t) => [t.id, t])), [targets]);
  const recent = (ov.data?.recent || []).slice(0, 10);
  return (
    <>
      <div className="isd-toolbar">
        <div className="isd-tools">
          <button type="button" className={`isd-fchip${!filter || filter === 'all' ? ' on' : ''}`} aria-pressed={!filter || filter === 'all'} onClick={() => setFilter('all')}>전체 {countText(counts.total)}</button>
          {STATUS_GROUPS.map(([k, label]) => (
            <button key={k} type="button" className={`isd-fchip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} disabled={!counts[k]}><span className={`isd-dot ${k}`} aria-hidden="true" /> {label} {countText(counts[k])}</button>
          ))}
        </div>
        {/* v2.740: 일괄 변경·일괄 수집은 설정 › 수집 서버 › 아이실론 디렉터리 사용량(슈퍼 관리자 전용)으로 옮겼다 — 슈퍼 관리자에게만 그 화면으로 가는 길을 보인다. */}
        {openBulk ? <div className="isd-actions"><button type="button" className="isd-btn" onClick={openBulk} title="설정 › 수집 서버 › 아이실론 디렉터리 사용량 › 일괄 변경으로 이동합니다(슈퍼 관리자 전용)">일괄 변경 · 일괄 수집(설정)</button></div> : null}
      </div>

      <section className="isd-card" aria-label="대상별 수집 상태">
        <div className="isd-cardhead"><h3>대상별 수집 상태</h3><div className="isd-note">각 노드가 자기 법인 아이실론에 SSH 로 접속해 du 를 돌리고, 엣지 결과는 메인으로 올라옵니다(엣지 push 10분마다). 다음 예정은 주기 규칙으로 계산한 추정입니다.</div></div>
        <STable className="v3-table" minWidth={1080}>
          <thead><tr><th>법인 · 대상</th><th>실행 노드</th><th>상태</th><th>진행 · 마지막 시도</th><th>마지막 성공 · 소요</th><th>주기 · 시한</th><th>다음 예정</th><th style={{ textAlign: 'right' }}>연속 실패</th><th>결과 메일</th><th data-nosort>지금</th></tr></thead>
          <tbody>
            {rows.map(({ t, st }) => {
              const at = attemptText(t, now);
              const next = nextRunOf(t, data.failRetryMs, now, data.failLongMs);   // v2.741 DEV-05: 서버 값과 묶는다(없으면 같은 상수)
              const ml = targetMailLine(t, now, data?.offsetMin);   // v2.745: 정기 발송이면 '정기 · 월·목 08:00 · 다음 …'(서버가 포탈 시각 오프셋을 주면 그 값)
              return (
                <tr key={t.id}>
                  <td><b>{targetChip(t).corp || '—'}</b> <button type="button" className="isd-namebtn" onClick={() => openTarget(t.id)}>{t.label || t.id}</button><div className="isd-note">{t.deviceName || t.host || '—'}</div></td>
                  <td><span className={`isd-node${t.agent ? ' edge' : ''}`} title={t.agentSource === 'override' ? `실행 노드 지정(장비 담당: ${nodeText(t.deviceAgent || '')})` : undefined}>{nodeText(t.agent)}{t.agentSource === 'override' ? ' · 지정' : ''}</span></td>
                  <td><Tag st={st} />{st.detail && st.tone !== 'ok' ? <div className="isd-note" style={{ maxWidth: 320, minWidth: 200, whiteSpace: 'normal' }}>{st.detail}</div> : null}</td>
                  <td data-sort={t.running?.since ?? t.lastTry?.ts ?? ''}>{at.text}<Progress prog={at.prog} />{t.lastTry && t.lastTry.ok === false ? <div className="isd-note bad">{failTitle(t.lastTry.kind)}</div> : null}</td>
                  <td data-sort={t.okScan?.ts ?? ''}>{agoText(t.okScan?.ts, now)}{t.okScan ? <div className="isd-note">{durationText(t.okScan.durationMs)} 걸림</div> : null}</td>
                  <td data-sort={t.intervalHours}>{everyText(t.intervalHours)} · {t.timeoutMin}분</td>
                  <td data-sort={typeof next === 'number' ? next : ''}>{next == null ? (t.running ? '진행 중' : '—') : next === 'soon' ? '곧' : aheadText(next, now)}</td>
                  <td className="isd-mono" style={{ textAlign: 'right' }}>{t.failStreak ? countText(t.failStreak) : '0'}</td>
                  <td className="isd-note isd-mailcell">{ml ? ml.parts.map((p, i) => <div key={i}>{p}</div>) : '—'}</td>
                  <td><button type="button" className="isd-btn small" disabled={busy || !!t.issue} onClick={() => runNow([t.id])}>수집</button></td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        {!rows.length ? <div className="isd-note">이 상태의 대상이 없습니다.</div> : null}
      </section>

      <div className="isd-split">
        <section className="isd-card isd-grow3" aria-label="최근 실행 기록">
          <div className="isd-cardhead"><h3>최근 실행 기록</h3><div className="isd-note">전 대상 · 최신 10건(성공·실패 모두)</div></div>
          {ov.error && !ov.data ? <div className="isd-note bad">기록을 읽지 못했습니다.</div> : !ov.data ? <div className="isd-note">불러오는 중…</div> : ov.data.recentUnavailable ? <div className="isd-note bad">이 노드에서 디렉터리 사용량 DB 를 쓸 수 없습니다.</div> : recent.length ? (
            <STable className="v3-table" minWidth={720}>
              <thead><tr><th>시각</th><th>대상</th><th>결과</th><th>소요</th><th style={{ textAlign: 'right' }}>폴더</th><th>노드</th><th>계기</th></tr></thead>
              <tbody>
                {recent.map((r) => {
                  const t = byId.get(r.targetId);
                  return (
                    <tr key={`${r.targetId}-${r.ts}`}>
                      <td data-sort={r.ts}>{agoText(r.ts, now)}</td>
                      <td>{t ? (t.label || t.id) : r.targetId}</td>
                      <td>{r.ok ? <span className={`isd-tag ${r.errLines ? 'warn' : 'ok'}`}>{r.errLines ? `성공 · 권한 오류 ${countText(r.errLines)}줄` : '성공'}</span> : <span className="isd-tag bad" title={r.error || undefined}>{failTitle(r.kind)}</span>}</td>
                      <td>{durationText(r.durationMs)}</td>
                      <td className="isd-mono" style={{ textAlign: 'right' }}>{r.ok ? countText(r.count) : '—'}</td>
                      <td>{nodeText(r.node)}</td>
                      <td>{triggerText(r.trig)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="isd-note">아직 실행 기록이 없습니다.</div>}
        </section>
        <section className="isd-card isd-grow2" aria-label="상태가 말하는 것">
          <div className="isd-cardhead"><h3>상태가 말하는 것</h3></div>
          {LEGEND.map(([k, label, text]) => <div key={k} className="isd-legend"><span className={`isd-tag ${k}`}>{label}</span><span className="isd-note">{text}</span></div>)}
        </section>
      </div>

      <KeyCard targets={targets} data={data} />
    </>
  );
}

function KeyCard({ targets, data }) {
  const keys = useMemo(() => keyRows(targets, data.key, data.edges), [targets, data.key, data.edges]);
  return (
    <section className="isd-card" aria-label="SSH 키">
      <div className="isd-cardhead">
        <h3>SSH 키 — 아이실론에 등록할 공개키</h3>
        <div className="isd-note">키 인증 대상은 조사하는 노드(메인 또는 그 법인 엣지)의 서비스 계정 키로 접속합니다. 아래 공개키를 그 아이실론 계정의 authorized_keys 에 넣어 두세요. 비밀키는 화면에 나오지 않습니다.</div>
      </div>
      <STable className="v3-table" minWidth={760}>
        <thead><tr><th>노드</th><th>키</th><th>공개키</th><th>대상</th></tr></thead>
        <tbody>
          {keys.map((k) => {
            const ks = k.agent && !k.key ? { text: k.reportedAt ? '키 정보 없음' : '엣지 보고 없음', tone: 'muted' } : keyStatus(k.key);
            return (
              <tr key={k.node}>
                <td><span className={`isd-node${k.agent ? ' edge' : ''}`}>{k.node}</span></td>
                <td><span className={`isd-tag ${ks.tone}`}>{ks.text}</span>{k.key?.fingerprint ? <div className="isd-note isd-mono">{k.key.type} · {k.key.fingerprint}</div> : null}{k.key?.error ? <div className="isd-note">{String(k.key.error)}</div> : null}</td>
                <td style={{ maxWidth: 420 }}>{k.key?.publicKey ? <div className="isd-key">{k.key.publicKey}</div> : <span className="isd-note">{k.agent ? '엣지가 대상을 받고 키를 만든 뒤 다음 push(최대 10분)에 올라옵니다.' : '설정 창에서 ‘키 만들기’ 를 누르세요.'}</span>}</td>
                <td className="isd-note">{k.targets.length ? k.targets.join(', ') : '키 인증 대상 없음'}</td>
              </tr>
            );
          })}
        </tbody>
      </STable>
    </section>
  );
}

/* ═══════════════ ④ 전 법인 Top 10 ═══════════════ */

/** 수집 시각 범위 — 양 끝이 같은 말이면 한 번만(‘3시간 전 ~ 3시간 전’ 금지). */
function spanText(r, now) {
  if (!r.oldestTs || !r.newestTs) return '';
  const a = agoText(r.newestTs, now); const b = agoText(r.oldestTs, now);
  return a === b ? `(모두 ${a})` : `(${a} ~ ${b})`;
}

export function Top10View({ targets, ov, ovById, now, openTarget }) {
  const [pick, setPick] = useState(() => new Set());
  const ovSt = ovStatus(ov);
  const unread = ovSt === 'unread';
  const choices = useMemo(() => corpChoices(targets, ovById, { unread }), [targets, ovById, unread]);
  const r = useMemo(() => crossTop(targets, ovById, { corps: pick, n: 10, unread }), [targets, ovById, pick, unread]);
  const noResult = noResultCount(r);
  const max = r.top[0]?.bytes || 0;
  const toggle = (c) => setPick((cur) => { const n = new Set(cur); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  return (
    <>
      <OvState ov={ov} />
      <div className="isd-tools" role="group" aria-label="법인 고르기">
        <button type="button" className={`isd-fchip${pick.size ? '' : ' on'}`} aria-pressed={!pick.size} onClick={() => setPick(new Set())}>전 법인</button>
        {choices.map((c) => {
          const cv = corpChipView(c);
          return (
            <button key={c.corp || '(none)'} type="button" className={`isd-fchip${pick.has(c.corp) ? ' on' : ''}`} aria-pressed={pick.has(c.corp)} onClick={() => toggle(c.corp)} disabled={cv.disabled}
              title={cv.title}>{c.label}{cv.suffix}</button>
          );
        })}
      </div>
      <div className="isd-kpis">
        <div className="isd-kpi"><div className="isd-kpi-label">Top 10 합</div><div className="isd-kpi-val">{bytesText(r.sum)}</div><div className="isd-kpi-sub">{r.top.length ? `${countText(r.top.length)}개 폴더` : '—'}</div></div>
        <div className="isd-kpi"><div className="isd-kpi-label">기준 크기 대비 비중</div><div className="isd-kpi-val">{shareText(r.share)}</div><div className="isd-kpi-sub">기준 = 고른 대상의 디렉터리 크기 합 {bytesText(r.base)}</div></div>
        <div className="isd-kpi"><div className="isd-kpi-label">기준 대상</div><div className="isd-kpi-val">{countText(r.included.length)}</div><div className="isd-kpi-sub">{unread ? OV_UNREAD : noResult ? `결과 없는 ${countText(noResult)}개 제외` : r.excluded.length ? `개요를 받는 중인 ${countText(r.excluded.length)}개 제외` : '고른 법인의 모든 대상'}{r.oldestTs ? ` · 가장 오래된 수집 ${agoText(r.oldestTs, now)}` : ''}</div></div>
      </div>
      <section className="isd-card" aria-label="전 법인 사용량 Top 10">
        <div className="isd-cardhead"><h3>{pick.size ? `${[...pick].map((c) => c || '법인 미지정').join(' · ')} 사용량 Top 10` : '전 법인 사용량 Top 10'}</h3><div className="isd-note">막대 = 그 대상 디렉터리 대비 비중 · 변화 = 그 대상의 7일 전 수집 대비</div></div>
        {!r.top.length ? <div className="isd-note">{topEmptyText(ovSt, { picked: pick.size > 0 })}</div> : (
          <STable className="v3-table" minWidth={940}>
            <thead><tr><th>순위</th><th>사용자 폴더</th><th>법인 · 장비</th><th style={{ textAlign: 'right' }}>크기</th><th>그 대상 디렉터리 대비</th><th style={{ textAlign: 'right' }}>7일 변화</th><th>수집 시각</th></tr></thead>
            <tbody>
              {r.top.map((u) => (
                <tr key={u.key}>
                  <td className="isd-mono">{u.rank}</td>
                  <td><button type="button" className="isd-namebtn" onClick={() => openTarget(u.targetId)}>{u.name}</button><div className="isd-note isd-mono">{tailPath(u.path, u.name)}</div></td>
                  <td><span className="isd-tag muted">{u.corpLabel}</span> <span className="isd-note">{u.device}</span></td>
                  <td className="isd-mono" style={{ textAlign: 'right' }} data-sort={u.bytes ?? ''}><span className="isd-relbar" aria-hidden="true"><span style={{ width: `${max > 0 ? Math.max(1, Math.round(((u.bytes || 0) / max) * 100)) : 0}%` }} /></span>{bytesText(u.bytes)}</td>
                  <td data-sort={u.share ?? ''}><span className="isd-sharecell"><span className="isd-bar thin" aria-hidden="true"><div style={{ width: `${u.share > 0 ? Math.max(1, Math.round(u.share * 100)) : 0}%` }} /></span><span className="isd-mono">{shareText(u.share)}</span></span></td>
                  <td style={{ textAlign: 'right' }}><Delta d={u.d7} isNew={u.new7} hasBase={u.hasBase} /></td>
                  <td data-sort={u.scanTs ?? ''}>{agoText(u.scanTs, now)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        <div className="isd-note">대상마다 수집 시각이 다릅니다{spanText(r, now)} — 한 순간의 순위가 아닙니다.{r.approx ? ' -h 표기는 반올림 값이라 크기가 같아 보이는 폴더의 순서는 정확하지 않을 수 있습니다.' : ''}{noResult ? ` 결과 없는 대상 ${noResult}개는 빠져 있습니다.` : ''}</div>
      </section>
    </>
  );
}
