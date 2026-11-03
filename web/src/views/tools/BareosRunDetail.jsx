/**
 * Bareos 실행 중 작업 상세(v2.858 · 사용자 요청 '진행 중인 작업의 정보를 첨부한 사진처럼 · 진행 현황에서 세부 정보 보이게' — 승인 시안).
 *   진행 현황 › 단일 법인의 행 펼침과 실행 현황 · 이력의 '고른 작업' 이 이 조각 하나를 쓴다(같은 화면을 두 벌 만들지 않는다).
 *   ① 띠(지금 단계 · 레벨 · 경과) ② 카드(진행량 · 추정 진척 · 속도 · 경과 · 남은 시간 · 볼륨 · 끝나야 아는 값) ③ 진척 막대 ④ 상태 칩
 *   ⑤ 타임라인(지금까지의 잡 로그 — bareosText.jobTimeline) + '지금' · 아직 오지 않은 단계 ⑥ 볼륨 · 세부 ⑦ 원문 로그(펼침).
 * 규칙: 값은 진행 현황 응답(FD 보고 · Director 상태)과 잡 로그에서만 — 못 읽은 값은 '모름'/'—'(0 이 아니다) · 추정은 '추정' 표지 ·
 *   저장한 양 · 압축은 잡 끝 보고에만 있어 '끝나면 표시' · 로그는 펼칠 때 한 번 + '로그 다시 읽기'(무거운 Director 조회라 주기 폴링 금지) ·
 *   로그 시각은 Director 현지 시각 글이라 브라우저 시각과 빼지 않는다(clockSec 은 시간대 없는 값끼리만).
 * ⚠ 훅은 조기 return 위 · 400px 에서 넘치지 않게 그리드 칸은 minmax(0, 1fr).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { shortTs } from './bareosViewText.js';
import {
  parseJobReport, parseJobDetail, jobTimeline, decBytesText, durKo, withRelayWait,
} from './bareosText.js';
import {
  rateText, sizeText, elapsedText, levelWord, triggerText, reasonText, REASON_HINT, STUCK_TEXT, fdLineOf, fdProgressMeta,
  progressBasis, etaSec, runPhase, futurePhases,
} from './bareosLiveText.js';

const BASE = '/tools/bareos-backup';
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };   // Director 를 거치는 조회는 자동 재시도하지 않는다(BareosBackupTool 과 같은 값)
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const PANEL = { border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-deep)', minWidth: 0, overflow: 'hidden' };
const PANEL_HEAD = { padding: '8px 12px', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5, fontWeight: 700, display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'baseline' };
const SECTION = { fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', margin: '14px 0 6px', letterSpacing: '.02em' };
const BTN = { padding: '4px 9px', fontSize: 12, marginLeft: 0 };
const STEP_COLOR = Object.freeze({ plain: 'var(--text-dim)', blue: 'var(--accent)', info: '#a855f7', cyan: 'var(--accent-2)', green: 'var(--green)', warn: 'var(--amber)', err: 'var(--red)' });
const SEG_COLOR = Object.freeze({ wait: 'rgba(245,158,11,.55)', prep: '#a855f7', data: 'var(--accent-2)', tail: 'var(--green)' });
const SEG_LABEL = Object.freeze({ prep: '준비', data: '데이터 전송', tail: '정리' });
const CHIP = Object.freeze({
  ok: { background: 'rgba(34,197,94,.12)', color: '#4ade80' }, warn: { background: 'rgba(245,158,11,.14)', color: '#fbbf24' },
  na: { background: 'rgba(139,155,180,.12)', color: 'var(--text-dim)' }, run: { background: 'rgba(59,130,246,.14)', color: '#60a5fa' },
});
const HANGUL_RE = /[가-힣]/;
// 진행 중 구간 — 빗금이 흐른다(화면이 '아직 끝나지 않음' 을 말한다)
const STRIPE = { backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,.22) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.22) 50%, rgba(255,255,255,.22) 75%, transparent 75%, transparent)', backgroundSize: '14px 14px', animation: 'bareos-run-stripe 1s linear infinite' };
const KEYFRAMES = '@keyframes bareos-run-stripe{from{background-position:0 0}to{background-position:14px 0}}@keyframes bareos-run-spin{to{transform:rotate(360deg)}}@keyframes bareos-run-now{0%{box-shadow:0 0 0 0 rgba(34,211,238,.55)}70%{box-shadow:0 0 0 8px rgba(34,211,238,0)}100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}}@media (prefers-reduced-motion: reduce){[data-bareos-anim]{animation:none !important}}';

const Chip = ({ tone = 'na', children }) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, ...CHIP[tone] }}>{children}</span>;
const Est = () => <span style={{ fontSize: 10.5, fontWeight: 700, color: '#fbbf24', background: 'rgba(245,158,11,.14)', borderRadius: 99, padding: '1px 6px', marginLeft: 4, verticalAlign: 1 }}>추정</span>;
function Card({ label, value, meta, later = false }) {
  return (
    <div style={{ padding: '10px 12px', minWidth: 0, borderRadius: 8, background: later ? 'transparent' : 'var(--panel-deep)', border: `1px ${later ? 'dashed' : 'solid'} var(--border-soft)` }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{label}</div>
      <div style={{ fontSize: later ? 15 : 18, fontWeight: 800, marginTop: 4, wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums', color: later ? 'var(--text-faint)' : undefined }}>{value}</div>
      {meta && <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45, wordBreak: 'break-word' }}>{meta}</div>}
    </div>
  );
}
function Band({ tone, mark, title, line, sub }) {
  const c = tone === 'amber' ? { fg: '#fbbf24', bg: 'rgba(245,158,11,.08)', line: 'rgba(245,158,11,.4)' } : { fg: '#60a5fa', bg: 'rgba(59,130,246,.10)', line: 'rgba(59,130,246,.45)' };
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px', borderRadius: 10, background: c.bg, border: `1px solid ${c.line}` }}>
      <div aria-hidden style={{ width: 40, height: 40, flex: '0 0 40px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 17, fontWeight: 800, color: c.fg, border: `2px solid ${c.fg}` }}>
        {mark === 'spin' ? <span data-bareos-anim="" style={{ width: 22, height: 22, borderRadius: '50%', border: '3px solid rgba(96,165,250,.25)', borderTopColor: '#60a5fa', animation: 'bareos-run-spin 1.1s linear infinite' }} /> : mark}
      </div>
      <div style={{ minWidth: 0, flex: '1 1 260px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px' }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: c.fg }}>{title}</span>
          <span style={{ fontSize: 13 }}>{line}</span>
        </div>
        {sub && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, wordBreak: 'break-word' }}>{sub}</div>}
      </div>
    </div>
  );
}

/** 지난 같은 레벨 실행 한 줄(세부). */
function prevText(p) {
  if (!p) return '—';
  const sec = Number.isFinite(p.startedAt) && Number.isFinite(p.endedAt) && p.endedAt > p.startedAt ? (p.endedAt - p.startedAt) / 1000 : null;
  return `jobid ${p.jobid} · ${levelWord(p.level)} · ${p.status === 'W' ? '경고' : '성공'}${sec !== null ? ` · ${durKo(sec)}` : ''} · ${sizeText(p.bytes)}`;
}

/**
 * @param {object} props
 * @param {object} props.row      진행 현황 행(서버 bareosLive.runningRow) — id · jobid · vmName · level · state · since · elapsed · bytes · files · rateNow · rateAvg ·
 *                                baseline · slow · stuck · dirStatus · prev · sizeGb · group · trigger · by · client · pool · storage
 * @param {object|null} props.live 그 법인의 조회 상태(corp.live — at · ok · code · dirOk) · 모르면 null
 * @param {object|null} props.dir  Director(엣지 대행이면 { relay: true } 처럼 isRelayDir 가 읽는 값) · @param {object|null} props.limits relayLimits
 * @param {{ ahead?: object|null, order?: number|null, total?: number }} [props.queue] 대기 행일 때 — 앞에서 실행 중인 행 · 대기 순번(추정)
 * @param {boolean} [props.diagAvailable] 진단 원문을 볼 수 있으면 FD 보고 없음 안내에 단추를 단다 · @param {Function} [props.onDiag]
 */
export default function BareosRunDetail({ row, live = null, dir = null, limits = null, queue = null, diagAvailable = false, onDiag = null }) {
  const running = row?.state === 'running';
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const waitMs = withRelayWait(DIRECTOR_GET, dir, limits, 'log').timeoutMs;
  const jobKey = row?.id || '';
  const jobid = row?.jobid || null;
  // 로그는 실행 중일 때만 · 펼칠 때 한 번 + '로그 다시 읽기'(진행 현황이 15초마다 새로 와도 다시 읽지 않는다 — 열쇠는 대상 · jobid · 단추)
  useEffect(() => {
    const g = ++gen.current;
    setR(null); setErr(null);
    if (!running || !jobKey || !jobid) return;
    fetchJson(`${BASE}/jobs/${encodeURIComponent(jobKey)}/log`, { jobid }, undefined, { ...DIRECTOR_GET, timeoutMs: waitMs })
      .then((x) => { if (g === gen.current) setR({ ...x, readAt: Date.now() }); })
      .catch((e) => { if (g === gen.current) setErr(e); });
  }, [running, jobKey, jobid, waitMs, tick]);
  const lines = useMemo(() => (Array.isArray(r?.lines) ? r.lines : []), [r]);
  const rep = useMemo(() => (r ? parseJobReport(lines) : null), [r, lines]);
  const detail = useMemo(() => (r ? parseJobDetail(lines) : null), [r, lines]);
  const tl = useMemo(() => (r ? jobTimeline(lines, rep?.fields || {}) : null), [r, lines, rep]);

  if (!row) return null;
  const head = (
    <div style={{ ...ROW, marginBottom: 10 }}>
      <b style={{ fontSize: 13.5 }}>jobid {row.jobid} · {row.vmName} 상세</b>
      <span className="muted" style={{ fontSize: 12 }}>
        {running ? fdLineOf(row, live, shortTs).text : `Director 상태 조회 ${live?.at ? shortTs(live.at) : '—'}`}
        {r?.readAt ? ` · 로그 ${shortTs(r.readAt)} 읽음` : ''} · 시각은 Director 현지 시각
      </span>
      <span style={{ flex: '1 1 0' }} />
      {running && <button type="button" className="logout-btn" style={BTN} onClick={() => setTick((t) => t + 1)} disabled={!r && !err}>로그 다시 읽기</button>}
      {running && <button type="button" className="logout-btn" style={BTN} aria-expanded={rawOpen} onClick={() => setRawOpen((v) => !v)} disabled={!r}>{rawOpen ? '원문 로그 닫기' : '원문 로그'}</button>}
    </div>
  );

  /* ── 대기 행 ── */
  if (!running) {
    const reason = row.dirStatus?.reason || '';
    return (
      <div style={{ minWidth: 0 }}>
        <style>{KEYFRAMES}</style>
        {head}
        <Band tone="amber" mark="‖" title="대기" line={`${reason ? reasonText(reason) : 'Director 상태 모름'} · ${levelWord(row.level)} · ${elapsedText(row.elapsed)}째 기다리는 중`}
          sub={<>보냄 {row.since ? shortTs(row.since) : '—'}{row.dirStatus?.text ? <> · Director 상태 <span style={{ fontFamily: 'var(--mono)' }}>‘{row.dirStatus.text}’</span></> : ''}</>} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8, marginTop: 12 }}>
          <Card label="대기 경과" value={elapsedText(row.elapsed)} meta="포탈이 보낸 뒤(또는 Bareos 스케줄 시작 뒤)" />
          <Card label="대기 사유" value={reason ? reasonText(reason) : '모름'} meta={REASON_HINT[reason] || (reason ? 'Director 상태' : 'Director 상태에 이 잡이 없음')} />
          <Card label="앞에서 실행 중" value={queue?.ahead ? '1건 이상' : '—'} meta={queue?.ahead ? `${queue.ahead.vmName} · jobid ${queue.ahead.jobid}${queue.ahead.elapsed !== null && queue.ahead.elapsed !== undefined ? ` · ${elapsedText(queue.ahead.elapsed)}째` : ''}` : '같은 법인에 실행 중인 잡이 없음'} />
          <Card label={<>대기 순번<Est /></>} value={queue?.order ? `${queue.order} / ${queue.total}` : '—'} meta="보낸 순서 — Director 는 우선순위가 같으면 먼저 온 잡부터" />
          <Card label="VM 용량" value={row.sizeGb ? sizeText(row.sizeGb * 1024 ** 3) : '—'} meta="인벤토리" />
          <Card later label="진행량 · 속도" value="시작하면 표시" meta="FD 가 잡을 받은 뒤부터 보고합니다" />
        </div>
      </div>
    );
  }

  /* ── 실행 중 ── */
  const pb = progressBasis(row);
  const eta = etaSec(row, pb);
  const ended = !!rep?.found;
  const phase = runPhase(tl?.steps, ended);
  const fdl = fdLineOf(row, live, shortTs);   // v2.870: 그 잡의 FD 답으로(법인 단위 live.ok 가 아니라)
  const bytesKnown = fdl.known;
  const fdMissing = fdl.missing;
  const vols = detail?.volumes || [];
  const ratio = Number.isFinite(row.rateNow) && Number.isFinite(row.baseline) && row.baseline > 0 ? Math.round((row.rateNow / row.baseline) * 100) : null;
  const judge = row.stuck ? { tone: 'warn', text: `멈춤 의심 — ${STUCK_TEXT[row.stuck] || ''}` }
    : row.slow ? { tone: 'warn', text: `느림${ratio !== null ? ` — 지난 평균의 ${ratio}%` : ''}` }
      : row.rateNow === null || row.rateNow === undefined ? { tone: 'na', text: '판정 속도 모름' }
        : { tone: 'ok', text: `판정 정상${ratio !== null ? ` — 지난 평균의 ${ratio}%` : ''}` };
  const dirTone = !row.dirStatus ? 'na' : row.dirStatus.reason === 'running' ? 'ok' : 'warn';
  const start = tl?.steps?.find((s) => s.title === '시작');
  const runSecText = tl?.runSec !== null && tl?.runSec !== undefined ? durKo(tl.runSec) : null;
  // 지금 단계 구간이 로그에 아직 길이가 없으면(마지막 줄이 그 단계의 시작) 끝이 열린 구간으로 그린다 — 시간은 끝나야 안다(브라우저 시각과 빼지 않는다)
  const known = tl?.segs || [];
  const knownSec = known.reduce((a, s) => a + s.sec, 0);
  const openSeg = !ended && SEG_LABEL[phase.key] && !known.some((s) => s.k === phase.key) ? { k: phase.key, label: SEG_LABEL[phase.key], sec: null } : null;
  const segs = openSeg ? [...known, openSeg] : known;
  const flexOf = (s) => (s.sec === null ? Math.max(1, Math.round(knownSec * 0.5)) : s.sec);
  const totalSeg = segs.reduce((a, s) => a + flexOf(s), 0);
  const inTail = phase.key === 'tail';

  return (
    <div style={{ minWidth: 0 }}>
      <style>{KEYFRAMES}</style>
      {head}
      <Band tone="blue" mark="spin" title={ended ? '끝남' : '실행 중'}
        line={`${phase.text} · ${levelWord(row.level)} · 경과 ${elapsedText(row.elapsed)}${Number.isFinite(row.rateNow) ? ` · 지금 ${rateText(row.rateNow)}` : ''}`}
        sub={<>
          보냄 {row.since ? shortTs(row.since) : '—'}{start?.at ? ` · 로그상 시작 ${start.at}` : ''}{runSecText ? ` · 로그상 실행 ${runSecText}(마지막 로그까지)` : ''}
          {row.group ? ` · 그룹 ‘${row.group}’` : ''} · {triggerText(row)}{row.by ? ` · ${row.by}` : ''}
          {ended ? ' · 끝 보고가 로그에 있습니다 — 결과는 이력의 ‘보기’ 에서' : ''}
        </>} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8, marginTop: 12 }}>
        <Card label="진행량(FD 보고)" value={bytesKnown ? sizeText(row.bytes) : (fdMissing ? '보고 없음' : '모름')}
          meta={fdProgressMeta(row, live, fdl)} />
        <Card label={<>진척<Est /></>} value={pb.pct !== null ? `${pb.pct} %` : '—'} meta={pb.over ? `${pb.label} — 기준을 넘음` : pb.label} />
        <Card label="속도" value={rateText(row.rateNow)}
          meta={[Number.isFinite(row.rateAvg) ? `평균 ${rateText(row.rateAvg)}` : '', Number.isFinite(row.baseline) ? `지난 실행 평균 ${rateText(row.baseline)}` : ''].filter(Boolean).join(' · ') || '지금(최근) 속도'} />
        <Card label="경과" value={elapsedText(row.elapsed)} meta={`보낸 뒤(대기 포함)${runSecText ? ` · 로그상 실행 ${runSecText}` : ''}`} />
        <Card label={<>남은 시간<Est /></>} value={eta !== null ? `약 ${durKo(eta)}` : '—'} meta={eta !== null ? '지금 속도가 이어진다면' : pb.basis === null ? '기준을 몰라 계산하지 않음' : '진행량 · 속도를 몰라 계산하지 않음'} />
        <Card label="볼륨" value={r ? `${vols.length}개` : '—'} meta={r ? (vols.length ? vols.map((v) => v.name).join(' · ') : '로그에 볼륨 줄이 아직 없음') : err ? '로그를 읽지 못함' : '로그 읽는 중'} />
        <Card later label="저장한 양 · 압축" value="끝나면 표시" meta="Director 끝 보고(SD Bytes Written · 압축률)에 실립니다" />
      </div>

      {pb.pct !== null && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...ROW, justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>진척 — 진행량 {sizeText(row.bytes)} / {pb.label}<Est /></span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}><b style={{ color: 'var(--accent-2)' }}>{pb.pct}%</b>{eta !== null ? ` · 남은 약 ${durKo(eta)}` : ''}</span>
          </div>
          <div role="img" aria-label={`추정 진척 ${pb.pct}%`} style={{ display: 'flex', gap: 2, height: 10, borderRadius: 99, background: 'var(--border-soft)', overflow: 'hidden', marginTop: 4 }}>
            <div data-bareos-anim="" style={{ flex: `${Math.max(pb.pct, 1)} 1 0`, background: 'var(--accent-2)', ...STRIPE }} />
            <div style={{ flex: `${100 - pb.pct} 1 0` }} />
          </div>
        </div>
      )}

      <div style={SECTION}>상태</div>
      <div style={{ ...ROW, gap: 6 }}>
        <Chip tone={dirTone}>{row.dirStatus ? <>Director {reasonText(row.dirStatus.reason)} · <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{row.dirStatus.text}</span></> : live?.dirOk ? 'Director 표에 없음' : 'Director 상태 모름'}</Chip>
        <Chip tone={bytesKnown ? 'ok' : fdMissing ? 'warn' : 'na'}>{bytesKnown ? `FD 진행 보고 ${live?.at ? shortTs(live.at) : ''}` : fdMissing ? 'FD 진행 보고 없음' : 'FD 상태 모름'}</Chip>
        <Chip tone={judge.tone}>{judge.text}</Chip>
        <Chip tone="na">SD 종료 — 끝나면</Chip>
        {(fdMissing || (row.fd && !row.fd.ok)) && diagAvailable && onDiag && <button type="button" className="logout-btn" style={BTN} onClick={onDiag}>진단 원문</button>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 12, marginTop: 14 }}>
        <div style={PANEL}>
          <div style={PANEL_HEAD}>
            <span>타임라인</span>
            <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>지금까지의 잡 로그{runSecText ? ` · 로그상 실행 ${runSecText}` : ''}{r?.truncated ? ` · 전체 ${r.total}줄 중 마지막 ${lines.length}줄` : ''}</span>
          </div>
          <div style={{ padding: '8px 12px 10px' }}>
            {err && <ErrorBox error={err} />}
            {!r && !err && <Loading />}
            {r && totalSeg > 0 && (
              <>
                <div role="img" aria-label={`${segs.map((s) => `${s.label} ${s.sec === null ? '진행 중' : durKo(s.sec)}`).join(', ')}${inTail || ended ? '' : ', 정리 아직'}`} style={{ display: 'flex', gap: 2, height: 12, borderRadius: 6, overflow: 'hidden', margin: '4px 0 6px', background: 'var(--border-soft)' }}>
                  {segs.map((s) => <div key={s.k} data-bareos-anim="" title={`${s.label} ${s.sec === null ? '진행 중' : durKo(s.sec)}`} style={{ flex: `${flexOf(s)} 1 0`, minWidth: s.sec === null ? 30 : 4, background: SEG_COLOR[s.k], ...(s.k === phase.key && !ended ? STRIPE : {}) }} />)}
                  {!inTail && !ended && <div title="정리 — 아직" style={{ flex: `${Math.max(1, Math.round(totalSeg * 0.04))} 1 0`, minWidth: 20, border: '1px dashed var(--text-faint)', borderRadius: '0 6px 6px 0', boxSizing: 'border-box' }} />}
                </div>
                <div style={{ ...ROW, gap: '4px 12px', fontSize: 11.5, color: 'var(--text-dim)' }}>
                  {segs.map((s) => <span key={s.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span aria-hidden style={{ width: 10, height: 6, borderRadius: 2, background: SEG_COLOR[s.k] }} />{s.label}{s.sec !== null ? ` ${durKo(s.sec)}` : ''}{s.k === phase.key && !ended ? ' · 진행 중' : ''}</span>)}
                  {!inTail && !ended && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span aria-hidden style={{ width: 10, height: 6, borderRadius: 2, border: '1px dashed var(--text-faint)' }} />정리 · 아직</span>}
                </div>
              </>
            )}
            {r && (
              <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
                {(tl?.steps || []).map((s, i) => {
                  const next = tl.steps[i + 1];
                  const gap = next ? next.sec - s.sec : null;
                  return (
                    <li key={`${s.sec}-${i}`} style={{ display: 'grid', gridTemplateColumns: '64px 14px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'start' }}>
                      <span style={{ padding: '7px 0', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', textAlign: 'right' }}>{s.at || '—'}</span>
                      <span aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
                        <span style={{ width: 10, height: 10, marginTop: 10, borderRadius: '50%', background: STEP_COLOR[s.tone] || STEP_COLOR.plain, flex: 'none' }} />
                        {(next || !ended) && <span style={{ width: 2, flex: 1, background: 'var(--border)', marginTop: 3 }} />}
                      </span>
                      <span style={{ padding: '6px 0 10px', minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: s.tone === 'err' ? '#f87171' : undefined }}>{s.title}</span>
                        {s.sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', fontFamily: HANGUL_RE.test(s.sub) ? undefined : 'var(--mono)', wordBreak: 'break-word', marginTop: 2 }}>{s.sub}</span>}
                      </span>
                      <span className="muted" style={{ padding: '7px 0', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{gap !== null && gap > 0 ? `+${durKo(gap)}` : ''}</span>
                    </li>
                  );
                })}
                {!ended && (
                  <li style={{ display: 'grid', gridTemplateColumns: '64px 14px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'start' }}>
                    <span style={{ padding: '7px 0', fontSize: 12, color: 'var(--accent-2)', textAlign: 'right', fontWeight: 700 }}>지금</span>
                    <span aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
                      <span data-bareos-anim="" style={{ width: 10, height: 10, marginTop: 10, borderRadius: '50%', background: 'var(--accent-2)', flex: 'none', animation: 'bareos-run-now 1.6s infinite' }} />
                      <span style={{ width: 2, flex: 1, marginTop: 3, background: 'repeating-linear-gradient(180deg, var(--border) 0 4px, transparent 4px 8px)' }} />
                    </span>
                    <span style={{ padding: '6px 0 10px', minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--accent-2)' }}>{phase.text}</span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
                        {bytesKnown ? `FD 보고 진행량 ${sizeText(row.bytes)}${Number.isFinite(row.rateNow) ? ` · ${rateText(row.rateNow)}` : ''}` : fdMissing ? 'FD 진행 보고 없음 — 단계는 로그 기준' : 'FD 상태 모름 — 단계는 로그 기준'}
                      </span>
                    </span>
                    <span />
                  </li>
                )}
                {!ended && futurePhases(phase.key) && (
                  <li style={{ display: 'grid', gridTemplateColumns: '64px 14px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'start' }}>
                    <span style={{ padding: '7px 0', fontSize: 12, color: 'var(--text-faint)', textAlign: 'right' }}>—</span>
                    <span aria-hidden style={{ display: 'flex', justifyContent: 'center' }}><span style={{ width: 10, height: 10, marginTop: 10, borderRadius: '50%', border: '2px solid var(--text-faint)', boxSizing: 'border-box' }} /></span>
                    <span style={{ padding: '6px 0 4px', minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-faint)' }}>{futurePhases(phase.key)}</span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>끝나면 로그에 이어 적힙니다</span>
                    </span>
                    <span />
                  </li>
                )}
              </ol>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
          <div style={PANEL}>
            <div style={PANEL_HEAD}>
              <span>볼륨 {r ? `${vols.length}개` : ''}</span>
              <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{detail?.device ? `${detail.device.name} · ` : ''}{detail?.capacity ? `볼륨 상한 ${decBytesText(detail.capacity)}` : '볼륨 상한 —'}</span>
            </div>
            {!r ? <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>{err ? '로그를 읽지 못했습니다.' : '로그 읽는 중…'}</div>
              : !vols.length ? <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>로그에 볼륨 줄이 아직 없습니다(쓰기 시작 · 교체 때 적힙니다).</div> : (
                <div style={{ padding: '6px 12px 10px', display: 'grid', gridTemplateColumns: 'auto minmax(40px, 1fr) auto', columnGap: 10, rowGap: 6, alignItems: 'center', fontSize: 12 }}>
                  {vols.map((v, i) => {
                    const last = i === vols.length - 1;
                    const writing = last && !v.fullAt && !ended;
                    const pct = v.fullBytes !== null && detail.capacity ? Math.max(2, Math.min(100, Math.round((v.fullBytes / detail.capacity) * 100))) : null;
                    return (
                      <React.Fragment key={v.name}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, minWidth: 0, wordBreak: 'break-all' }}>{v.name}</span>
                        <span aria-hidden style={{ height: 7, borderRadius: 4, background: 'var(--border-soft)', overflow: 'hidden' }}>
                          {writing ? <span data-bareos-anim="" style={{ display: 'block', height: '100%', width: '100%', background: 'rgba(59,130,246,.45)', ...STRIPE }} />
                            : pct !== null ? <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--accent-2)' }} /> : null}
                        </span>
                        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {writing ? <span style={{ color: '#60a5fa', fontWeight: 600 }}>쓰는 중</span> : <span style={{ whiteSpace: 'nowrap' }}>{v.fullBytes !== null ? decBytesText(v.fullBytes) : '—'}</span>}
                          <span className="muted"> · {[v.created ? '새로 만듦' : '이어 씀', v.fullAt ? `가득 참 ${v.fullAt}` : '', writing ? '크기는 끝나면' : ''].filter(Boolean).join(' · ')}</span>
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
          </div>
          <div style={PANEL}>
            <div style={PANEL_HEAD}><span>세부</span><span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>대상 원장 · 지금까지의 로그</span></div>
            <div style={{ padding: '4px 12px 8px' }}>
              {[
                ['Client', row.client || '—'], ['Pool', row.pool || '—'], ['Storage', row.storage || '—'],
                ...(detail?.device ? [['장치', `${detail.device.name} · ${detail.device.path}`]] : []),
                ...(detail?.tls?.length ? [['전송 암호화', detail.tls.map((t) => t.text).join(' · ')]] : []),
                ...(detail?.vsphere ? [['vSphere', detail.vsphere]] : []),
                ['VM 용량', row.sizeGb ? `${sizeText(row.sizeGb * 1024 ** 3)}(인벤토리)` : '—'],
                ['지난 같은 레벨', prevText(row.prev)],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 10, minWidth: 0, padding: '6px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5 }}>
                  <span style={{ flex: '0 0 96px', color: 'var(--text-faint)' }}>{k}</span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {rawOpen && r && (
        <div style={{ ...PANEL, marginTop: 12 }}>
          <div style={PANEL_HEAD}><span>원문 로그</span><span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{r.truncated ? `전체 ${r.total}줄 중 마지막 ${lines.length}줄` : `${lines.length}줄`}</span></div>
          <pre style={{ margin: 0, padding: '8px 12px', maxHeight: '40vh', overflow: 'auto', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-dim)' }}>{lines.join('\n') || '(빈 로그)'}</pre>
        </div>
      )}
    </div>
  );
}
