/**
 * Bareos 작업 로그 보기 — 요약 · 타임라인 · 볼륨 · 원문 세 보기(v2.828~ · v2.872 에 BareosBackupTool.jsx 에서 떼어 냈다).
 *   쓰는 곳: 운영(백업 대상 패널 · 진행 · 이력)의 LogModal · Backup › Summary 통합 에러 로그의 로그 서랍(BareosLogDrawer — 같은 본문을 서랍에 담는다).
 *   판정 · 문구는 bareosText.js 하나(백틱 금지 · 값이 없으면 '—').
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { requireChanged } from '../changeResult.js';
import { numOrNull } from '../../numOrNull.js';
import { Note } from './BareosBits.jsx';
import {
  levelLabel, outcomeUnknown, unknownOutcomeText, withRelayWait,
  parseJobReport, reportCards, REPORT_KEYS, issueHint, issueNeedsFull, storeRatio, reportText, reportBytes, reportValue,
  issueTone, ISSUE_TONE_LABEL, decBytesText, reportSizeText, elapsedKo, durKo, pctText, volumeNames, clockOf,
  classifyLogLine, filterLogLines, splitHit, parseJobDetail, jobTimeline, LOG_WHO_LABEL,
} from './bareosText.js';
import { copyText as copyToClipboard } from '../../util/copyText.js';   // v3.10.6: HTTP 포탈에서도 복사(Clipboard API → execCommand 폴백 · 실패는 false)

const BASE = '/tools/bareos-backup';
const enc = encodeURIComponent;
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const NOTE = { padding: '8px 12px', marginBottom: 10, fontSize: 12.5, lineHeight: 1.6 };
const BTN = { padding: '4px 9px', fontSize: 12 };
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };
const LOG_TABS = Object.freeze([['summary', '요약'], ['timeline', '타임라인 · 볼륨'], ['raw', '원문 로그']]);
const LOG_PANE_H = '68vh';   // 탭 본문 높이 — 요약·타임라인은 이 안에서 스크롤, 원문 로그 상자는 도구 줄·각주를 뺀 나머지를 채운다
export const LOG_VIEWS = LOG_TABS;
export const logViewOf = (v) => (LOG_TABS.some(([k]) => k === v) ? v : 'raw');

/**
 * 작업 로그 본문(v2.872 — 모달 · 서랍이 같은 본문) — 조회 · 보기 줄(요약 · 타임라인 · 원문) · 내용. 보기는 부르는 쪽이 쥔다(mode · onMode — 모달 제목이 보기를 따라간다).
 *   job = { id(원장 잡 id), vmName, writable? } · jobid = 그 실행. paneH = 본문 높이(모달 68vh · 서랍은 남은 높이).
 *   늦게 온 이전 응답은 버린다 — 서랍이 ‹ › 로 다른 실행으로 옮기면 앞 요청의 답이 새 실행 위에 그려지지 않게(gen).
 */
export function JobLogPanel({ job, jobid, mode, onMode, onStateChanged, dir = null, limits = null, paneH = LOG_PANE_H, canRunFull = true, issuesFirst = false }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  // v2.822.5: 서버가 로그를 주면서 그 실행의 상태를 원장에 반영한다(stateChanged) — 바뀌었으면 목록을 바로 다시 읽는다(폴러 주기를 기다리지 않게).
  const changedRef = useRef(onStateChanged);
  changedRef.current = onStateChanged;
  const gen = useRef(0);
  const waitMs = withRelayWait(DIRECTOR_GET, dir, limits, 'log').timeoutMs;   // 숫자 — 목록을 다시 읽어도(새 객체) 다시 조회하지 않게
  useEffect(() => {
    const my = ++gen.current;
    setR(null); setErr(null);
    fetchJson(`${BASE}/jobs/${enc(job.id)}/log`, { jobid }, undefined, { ...DIRECTOR_GET, timeoutMs: waitMs })
      .then((x) => { if (my !== gen.current) return; setR(x); if (x?.stateChanged) changedRef.current?.(); })
      .catch((e) => { if (my === gen.current) setErr(e); });
    return () => { gen.current++; };
  }, [job.id, jobid, waitMs]);
  const lines = useMemo(() => (Array.isArray(r?.lines) ? r.lines : []), [r]);
  const rep = useMemo(() => (r ? parseJobReport(lines) : null), [r, lines]);
  const detail = useMemo(() => (r ? parseJobDetail(lines) : null), [r, lines]);
  // 줄 번호는 원래 로그 기준 — 앞이 잘렸으면(뒤쪽 보존) 잘린 줄 수만큼 밀어 준다
  const rows = useMemo(() => {
    const skip = Math.max(0, (numOrNull(r?.total) ?? lines.length) - lines.length);
    return lines.map((l, i) => ({ ...classifyLogLine(l), n: skip + i + 1 }));
  }, [r, lines]);
  // v2.861 'Full 로 지금 실행' — 오류 해석이 Full 을 권할 때(디스크 이동 · CBT 어긋남). 지금 백업과 같은 API(쓰기 범위 · OTP 없음 — 패널의 지금 백업과 같다)
  const [runMsg, setRunMsg] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  useEffect(() => { setRunMsg(null); }, [job.id, jobid]);
  const runFull = !canRunFull || job.writable === false ? null : async () => {
    setRunBusy(true); setRunMsg(null);
    try {
      const x = await postJson(`${BASE}/jobs/${enc(job.id)}/run`, { level: 'Full' }, withRelayWait({}, dir, limits, 'runJob'));
      requireChanged(x);
      setRunMsg({ ok: true, text: `Full 실행을 보냈습니다(jobid ${x.jobid ?? '—'}) — 진행은 진행 · 이력에서 보입니다.` });
      changedRef.current?.();
    } catch (e) { setRunMsg({ ok: false, text: outcomeUnknown(e) ? unknownOutcomeText('Full 실행', e) : e.message }); } finally { setRunBusy(false); }
  };
  return (
    <>
      <div style={{ ...ROW, marginBottom: 10 }}>
        <div className="flex wrap" role="group" aria-label="보기" style={{ gap: 4 }}>
          {LOG_TABS.map(([k, l]) => (
            <button key={k} type="button" className={`tab${mode === k ? ' active' : ''}`} aria-pressed={mode === k} onClick={() => onMode(k)}>{l}</button>
          ))}
        </div>
        {r && <span className="muted" style={{ fontSize: 12 }}>{r.truncated ? `전체 ${r.total}줄 중 마지막 ${lines.length}줄` : `${lines.length}줄`}</span>}
        {r?.stateChanged && <span className="badge blue" style={{ fontSize: 11 }}>목록 상태를 갱신했습니다</span>}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>시각은 Director 현지 시각</span>
      </div>
      {/* 높이 고정 — 탭을 바꾸거나 원문을 거를 때 창 높이가 바뀌면 창이 화면 가운데로 다시 맞춰져 방금 누른 단추가 커서 밑에서 사라졌다(v2.828 Chromium 확인) */}
      <div style={{ minHeight: paneH }}>
        {err && <ErrorBox error={err} />}
        {!r && !err && <Loading />}
        {runMsg && <Note tone={runMsg.ok ? 'ok' : 'bad'}>{runMsg.text}</Note>}
        {r && mode === 'summary' && <JobReportView rep={rep} detail={detail} truncated={r.truncated} vmName={job.vmName} jobid={jobid} onRunFull={runFull} runBusy={runBusy} paneH={paneH} issuesFirst={issuesFirst} />}
        {r && mode === 'timeline' && <TimelineView lines={lines} rep={rep} detail={detail} truncated={r.truncated} paneH={paneH} />}
        {r && mode === 'raw' && <RawLogView rows={rows} lines={lines} paneH={paneH} />}
      </div>
    </>
  );
}

export function LogModal({ job, jobid, view = 'raw', onClose, onStateChanged, dir = null, limits = null }) {
  const [mode, setMode] = useState(logViewOf(view));
  const title = `${mode === 'raw' ? '작업 로그' : '작업 결과'} — jobid ${jobid} · ${job.vmName}`;
  return (
    <Modal title={title} onClose={onClose} width={1180}>
      <JobLogPanel job={job} jobid={jobid} mode={mode} onMode={setMode} onStateChanged={onStateChanged} dir={dir} limits={limits} />
    </Modal>
  );
}

/* 결과 색 — 배지와 같은 계열(styles.css .badge.*). 회색은 결과를 단정하지 못한 경우. */
const VERDICT_TONE = Object.freeze({
  green: { fg: '#4ade80', bg: 'rgba(34,197,94,.10)', line: 'rgba(34,197,94,.45)', mark: '✓' },
  amber: { fg: '#fbbf24', bg: 'rgba(245,158,11,.10)', line: 'rgba(245,158,11,.45)', mark: '!' },
  red: { fg: '#f87171', bg: 'rgba(239,68,68,.10)', line: 'rgba(239,68,68,.45)', mark: '✕' },
  gray: { fg: 'var(--text-dim)', bg: 'rgba(139,155,180,.08)', line: 'var(--border)', mark: '?' },
});
/* 줄·단계 색 — 경고·오류·안내·완료(styles.css 배지 글자색과 같은 값) */
const LINE_COLOR = Object.freeze({ plain: 'var(--text)', info: '#93c5fd', warn: '#fbbf24', err: '#f87171', ok: '#4ade80' });
const STEP_COLOR = Object.freeze({ plain: 'var(--text-dim)', blue: 'var(--accent)', info: '#a855f7', cyan: 'var(--accent-2)', green: 'var(--green)', warn: 'var(--amber)', err: 'var(--red)' });
const SEG_COLOR = Object.freeze({ wait: 'rgba(245,158,11,.55)', prep: '#a855f7', data: 'var(--accent-2)', tail: 'var(--green)' });
const WHO_BADGE = Object.freeze({ dir: 'blue', sd: 'teal', fd: 'purple', dmn: 'gray', rep: 'gray' });
const ISSUE_EDGE = Object.freeze({ info: '#60a5fa', warn: '#fbbf24', err: '#f87171' });
const ISSUE_BADGE = Object.freeze({ info: 'blue', warn: 'amber', err: 'red' });
const SECTION = { fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', margin: '14px 0 6px', letterSpacing: '.02em' };
const PANEL = { border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-deep)', minWidth: 0, overflow: 'hidden' };
const PANEL_HEAD = { padding: '8px 12px', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5, fontWeight: 700, display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'baseline' };
const TWO_COL = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 12 };
const chip = (ok) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12,
  background: ok === null ? 'rgba(139,155,180,.12)' : ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
  color: ok === null ? 'var(--text-dim)' : ok ? '#4ade80' : '#f87171' });
const ITEM_KIND = Object.freeze({ config: '구성', disk: '디스크', other: '항목' });

/**
 * 요약 본문 — ① 결과 띠 ② 핵심 수치 카드(값 + 부제) + 저장 효율 막대 ③ 상태 칩 ④ 세부 · 백업한 항목 · 볼륨 ⑤ 경고·오류(해석·색 구분).
 * 값이 없으면 '—'(0 으로 보이지 않게) · 해석은 아는 줄에만(bareosText.issueHint) · 로그에서 못 읽은 세부는 칸을 만들지 않는다.
 */
function JobReportView({ rep, detail, truncated, vmName, jobid, onRunFull = null, runBusy = false, paneH = LOG_PANE_H, issuesFirst = false }) {
  const [copied, setCopied] = useState('');
  if (!rep?.found) {
    return (
      <div>
        <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>
          아직 끝난 보고가 로그에 없습니다(실행 중이거나 보고 없이 끝났습니다{truncated ? ' · 로그가 길어 앞부분이 잘렸을 수 있습니다' : ''}). ‘타임라인 · 볼륨’ 이나 ‘원문 로그’ 에서 확인하세요.
        </div>
        {rep?.issues?.length ? <IssueList rep={rep} onRunFull={onRunFull} runBusy={runBusy} /> : null}
      </div>
    );
  }
  const f = rep.fields;
  const d = detail || {};
  const tone = VERDICT_TONE[rep.verdict.cls] || VERDICT_TONE.gray;
  const ratio = storeRatio(f);
  const read = reportBytes(f['FD Bytes Read']);
  const stored = reportBytes(f['SD Bytes Written']);
  const fdErr = reportBytes(f['Non-fatal FD errors'] ?? f['FD Errors']);
  const sdErr = reportBytes(f['SD Errors']);
  const okStatus = (v) => (v === undefined ? null : /^OK/i.test(String(v)));
  const level = levelLabel(f['Backup Level']) !== '—' ? levelLabel(f['Backup Level']) : (f['Backup Level'] || '—');
  const detailRows = [
    ...['Client', 'FileSet', 'Pool', 'Storage', 'Scheduled time', 'FD Files Written', 'SD Files Written', 'Files Expected', 'Encryption', 'Job triggered by']
      .filter((k) => f[k] !== undefined).map((k) => [REPORT_KEYS[k], reportValue(f[k])]),
    ...(f['Last Volume Bytes'] !== undefined ? [[REPORT_KEYS['Last Volume Bytes'], reportSizeText(f['Last Volume Bytes'])]] : []),
    ...(d.tls?.length ? [['전송 암호화', d.tls.map((t) => `${t.text}${t.n > 1 ? ` (${t.n}구간)` : ''}`).join(' · ')]] : []),
    ...(d.device ? [['장치', `${d.device.name} · ${d.device.path}`]] : []),
    ...(d.vsphere ? [['vSphere', d.vsphere]] : []),
  ];
  const copy = () => {
    const t = reportText(rep, { vmName, jobid });
    copyToClipboard(t).then((ok) => setCopied(ok ? '복사했습니다.' : '복사하지 못했습니다.'), () => setCopied('복사하지 못했습니다.'));
  };
  return (
    <div style={{ maxHeight: paneH, overflow: 'auto', paddingRight: 2 }}>
      {/* ① 결과 띠 */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px', borderRadius: 10, background: tone.bg, border: `1px solid ${tone.line}` }}>
        <div aria-hidden style={{ width: 40, height: 40, flex: '0 0 40px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 800, color: tone.fg, border: `2px solid ${tone.fg}` }}>{tone.mark}</div>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: tone.fg }}>{rep.verdict.label}</span>
            <span style={{ fontSize: 13 }}>{f.Termination} · {level} · {elapsedKo(f['Elapsed time'])}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, wordBreak: 'break-word', fontFamily: 'var(--mono)' }}>
            {f['Start time'] || '—'} → {f['End time'] || '—'}{f['Scheduled time'] ? ` · 예약 ${clockOf(f['Scheduled time']) || f['Scheduled time']}` : ''}{f['Job triggered by'] ? ` · 실행 주체 ${f['Job triggered by']}` : ''}
          </div>
        </div>
        <span style={{ ...ROW, gap: 6 }}>
          <button type="button" className="logout-btn" style={BTN} onClick={copy}>요약 복사</button>
          {copied && <span className="muted" style={{ fontSize: 11.5 }}>{copied}</span>}
        </span>
      </div>

      {/* ② 핵심 수치 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 12 }}>
        {reportCards(f).map((c) => (
          <div key={c.k} style={{ padding: '10px 12px', minWidth: 0, borderRadius: 8, background: 'var(--panel-deep)', border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
            {c.meta && <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45, wordBreak: 'break-word' }}>{c.meta}</div>}
          </div>
        ))}
      </div>
      {ratio !== null && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...ROW, justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
            <span>저장 효율 — 읽은 양 {decBytesText(read)} 중 볼륨에 쓴 양 {decBytesText(stored)}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}><b style={{ color: 'var(--accent-2)' }}>{pctText(ratio)}</b> 저장 · <b style={{ color: '#4ade80' }}>{pctText(1 - ratio)}</b> 절감</span>
          </div>
          <div role="img" aria-label={`읽은 양 대비 저장 ${pctText(ratio)}`} style={{ display: 'flex', gap: 2, height: 8, borderRadius: 99, background: 'var(--border-soft)', overflow: 'hidden', marginTop: 4 }}>
            <div style={{ flex: `${ratio} 1 0`, background: 'var(--accent-2)' }} />
            <div style={{ flex: `${1 - ratio} 1 0`, background: 'rgba(34,197,94,.35)' }} />
          </div>
        </div>
      )}

      {/* ③ 상태 */}
      <div style={SECTION}>상태</div>
      <div style={{ ...ROW, gap: 6 }}>
        <span style={chip(okStatus(f['FD termination status']))}>FD 종료 {f['FD termination status'] || '—'}</span>
        <span style={chip(okStatus(f['SD termination status']))}>SD 종료 {f['SD termination status'] || '—'}</span>
        <span style={chip(fdErr === null ? null : fdErr === 0)}>FD 오류 {fdErr ?? '—'}</span>
        <span style={chip(sdErr === null ? null : sdErr === 0)}>SD 오류 {sdErr ?? '—'}</span>
      </div>

      {/* v2.872 서랍(좁은 폭)은 경고·오류를 세부보다 먼저 — 실패 원인을 보러 온 화면이다(시안 docs/design/bareos-errlog ① · Chromium 확인: 640px 에서 세부 아래로 밀려 스크롤해야 보였다) */}
      {issuesFirst && <IssueList rep={rep} onRunFull={onRunFull} runBusy={runBusy} />}

      {/* ④ 세부 · 백업한 항목 · 볼륨 */}
      <div style={{ ...TWO_COL, marginTop: 14 }}>
        {detailRows.length > 0 && (
          <div style={PANEL}>
            <div style={PANEL_HEAD}>세부</div>
            <div style={{ padding: '4px 12px 8px' }}>
              {detailRows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 10, minWidth: 0, padding: '6px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12.5 }}>
                  <span style={{ flex: '0 0 104px', color: 'var(--text-faint)' }}>{k}</span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
          {d.items?.length > 0 && (
            <div style={PANEL}>
              <div style={PANEL_HEAD}>
                <span>백업한 항목 {d.items.length}개</span>
                {f['FD Files Written'] !== undefined && <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>FD 파일 {f['FD Files Written']} · SD 파일 {f['SD Files Written'] ?? '—'}</span>}
              </div>
              {d.itemDir && <div className="muted" style={{ padding: '6px 12px 0', fontSize: 11, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{d.itemDir}</div>}
              <div style={{ padding: '4px 12px 8px' }}>
                {d.items.map((x) => (
                  <div key={x.path} style={{ display: 'flex', gap: 10, alignItems: 'baseline', minWidth: 0, padding: '4px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12 }}>
                    <span className={`badge ${x.kind === 'disk' ? 'teal' : 'gray'}`} style={{ fontSize: 10.5, flex: 'none' }}>{ITEM_KIND[x.kind]}</span>
                    <span style={{ minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11.5, wordBreak: 'break-all' }} title={x.path}>{x.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <VolumePanel f={f} d={d} />
        </div>
      </div>

      {/* ⑤ 경고·오류 */}
      {!issuesFirst && <IssueList rep={rep} onRunFull={onRunFull} runBusy={runBusy} />}
    </div>
  );
}

/** 볼륨 — 보고서 Volume name(s) 순서 · 로그의 가득 참·마운트 · 마지막 볼륨은 Last Volume Bytes. 크기를 모르면 막대를 그리지 않는다. */
function VolumePanel({ f, d }) {
  const names = [...new Set(volumeNames(f['Volume name(s)']))];   // 같은 볼륨이 두 번 적혀도 한 줄(React key 중복 방지)
  const byName = new Map((d.volumes || []).map((v) => [v.name, v]));
  const list = names.length ? names : (d.volumes || []).map((v) => v.name);
  if (!list.length) return null;
  const cap = d.capacity;
  const lastBytes = reportBytes(f['Last Volume Bytes']);
  return (
    <div style={PANEL}>
      <div style={PANEL_HEAD}>
        <span>볼륨 {list.length}개</span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{d.device ? `${d.device.name} · ` : ''}{cap !== null && cap !== undefined ? `볼륨 상한 ${decBytesText(cap)}` : '볼륨 상한 —'}</span>
      </div>
      {/* 한 그리드 — 행마다 그리드를 따로 두면 오른쪽 설명 폭('이어 씀'·'새로 만듦')에 따라 같은 크기의 막대 길이가 달라졌다(v2.828 Chromium 확인) */}
      <div style={{ padding: '6px 12px 10px', display: 'grid', gridTemplateColumns: 'auto minmax(40px, 1fr) auto', columnGap: 10, rowGap: 6, alignItems: 'center', fontSize: 12 }}>
        {list.map((name, i) => {
          const v = byName.get(name) || {};
          const isLast = i === list.length - 1;
          const bytes = v.fullBytes ?? (isLast ? lastBytes : null);
          const note = v.fullAt ? `가득 참 ${v.fullAt}` : isLast ? '마지막' : v.created ? '새 볼륨' : '';
          const how = v.created ? '새로 만듦' : (v.firstAt ? '이어 씀' : '');
          const pct = bytes !== null && cap ? Math.max(2, Math.min(100, Math.round((bytes / cap) * 100))) : null;
          const rest = [bytes !== null ? how : '', note].filter(Boolean).join(' · ');
          return (
            <React.Fragment key={name}>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</span>
              <span aria-hidden style={{ height: 7, borderRadius: 4, background: 'var(--border-soft)', overflow: 'hidden' }}>
                {pct !== null && <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: isLast ? 'var(--accent)' : 'var(--accent-2)' }} />}
              </span>
              {/* 좁은 화면에서는 설명이 줄바꿈된다(크기 값은 한 덩어리) — 열 폭은 가장 긴 설명에 맞춰 모든 행이 같다 */}
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ whiteSpace: 'nowrap' }}>{bytes !== null ? decBytesText(bytes) : (how || '—')}</span>
                {rest && <span className="muted"> · {rest}</span>}
              </span>
            </React.Fragment>
          );
        })}
        {lastBytes === null && <span className="muted" style={{ fontSize: 11, gridColumn: '1 / -1' }}>마지막 볼륨 크기는 보고서에 없어 적지 않았습니다.</span>}
      </div>
    </div>
  );
}

function IssueList({ rep, onRunFull = null, runBusy = false }) {
  if (!rep.issues.length) return <><div style={SECTION}>경고·오류</div><div className="muted" style={{ fontSize: 12 }}>경고·오류 줄이 없습니다.</div></>;
  return (
    <>
      <div style={SECTION}>경고·오류 {rep.issues.length}종{rep.issuesMore ? ` (그 밖 ${rep.issuesMore}종은 원문 로그에서)` : ''}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {rep.issues.map((x) => {
          const hint = issueHint(x.text);
          const t = issueTone(x.text);
          return (
            <div key={x.text} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--panel-deep)', borderLeft: `3px solid ${ISSUE_EDGE[t]}`, minWidth: 0 }}>
              <div style={{ ...ROW, gap: 6, marginBottom: 4 }}>
                <span className={`badge ${ISSUE_BADGE[t]}`} style={{ fontSize: 10.5 }}>{ISSUE_TONE_LABEL[t]}</span>
                {x.count > 1 ? <span className="badge gray" style={{ fontSize: 10.5 }}>×{x.count}</span> : null}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.55, wordBreak: 'break-word' }}>{x.text}</div>
              {hint && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>→ {hint}</div>}
              {onRunFull && issueNeedsFull(x.text) && <button type="button" className="tab" style={{ marginTop: 6, padding: '4px 12px', fontSize: 12 }} disabled={runBusy} onClick={onRunFull}>{runBusy ? '보내는 중…' : 'Full 로 지금 실행'}</button>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * 타임라인 · 볼륨 — 예약·시작·연결·vSphere·CBT·데이터·볼륨 교체·오류·정리·종료. 시각은 Director 현지 그대로, 간격은 같은 시각끼리 뺀 값.
 * 구간 막대는 아는 구간만(대기·준비·데이터 전송·정리). 대기 사유는 로그에 없으므로 적지 않는다(추정하지 않는다).
 */
const HANGUL_RE = /[가-힣]/;   // 부제가 한글 문장이면 고정폭 글꼴을 쓰지 않는다(글자 사이가 벌어져 읽기 어렵다) — 잡 이름·경로·장치는 고정폭
function TimelineView({ lines, rep, detail, truncated, paneH = LOG_PANE_H }) {
  const tl = useMemo(() => jobTimeline(lines, rep?.fields || {}), [lines, rep]);
  if (!tl.steps.length) {
    return <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>로그에서 단계를 읽지 못했습니다{truncated ? '(로그가 길어 앞부분이 잘렸습니다)' : ''}. ‘원문 로그’ 에서 확인하세요.</div>;
  }
  const total = tl.segs.reduce((a, s) => a + s.sec, 0);
  return (
    <div style={{ maxHeight: paneH, overflow: 'auto', paddingRight: 2 }}>
      {truncated && <div className="card" style={{ ...NOTE, borderLeft: '3px solid var(--amber)' }}>로그가 길어 앞부분이 잘렸습니다 — 앞쪽 단계(예약·연결 등)가 빠져 있을 수 있습니다.</div>}
      <div style={{ ...ROW, justifyContent: 'space-between', fontSize: 12.5 }}>
        <span>
          {tl.waitSec !== null && <>예약 → 시작 <b style={{ color: '#fbbf24' }}>대기 {durKo(tl.waitSec)}</b> · </>}
          {tl.runSec !== null ? <>실행 <b>{durKo(tl.runSec)}</b></> : '실행 시간 —'}
        </span>
        {total > 0 && <span className="muted" style={{ fontSize: 11.5 }}>막대 = 아는 구간 합 {durKo(total)}</span>}
      </div>
      {total > 0 && (
        <>
          <div role="img" aria-label={tl.segs.map((s) => `${s.label} ${durKo(s.sec)}`).join(', ')} style={{ display: 'flex', gap: 2, height: 12, borderRadius: 6, overflow: 'hidden', margin: '8px 0 6px', background: 'var(--border-soft)' }}>
            {tl.segs.map((s) => <div key={s.k} title={`${s.label} ${durKo(s.sec)}`} style={{ flex: `${s.sec} 1 0`, minWidth: 2, background: SEG_COLOR[s.k] }} />)}
          </div>
          <div style={{ ...ROW, gap: 12, fontSize: 11.5, color: 'var(--text-dim)' }}>
            {tl.segs.map((s) => <span key={s.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span aria-hidden style={{ width: 10, height: 6, borderRadius: 2, background: SEG_COLOR[s.k] }} />{s.label} {durKo(s.sec)}</span>)}
          </div>
        </>
      )}
      <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
        {tl.steps.map((s, i) => {
          const next = tl.steps[i + 1];
          const gap = next ? next.sec - s.sec : null;
          return (
            <li key={`${s.sec}-${i}`} style={{ display: 'grid', gridTemplateColumns: '64px 14px minmax(0, 1fr) auto', columnGap: 10, alignItems: 'start' }}>
              <span style={{ padding: '7px 0', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', textAlign: 'right' }}>{s.at || '—'}</span>
              <span aria-hidden style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
                <span style={{ width: 10, height: 10, marginTop: 10, borderRadius: '50%', background: STEP_COLOR[s.tone] || STEP_COLOR.plain, flex: 'none' }} />
                {next && <span style={{ width: 2, flex: 1, background: 'var(--border)', marginTop: 3 }} />}
              </span>
              <span style={{ padding: '6px 0 10px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: s.tone === 'err' ? '#f87171' : undefined }}>{s.title}</span>
                {s.sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', fontFamily: HANGUL_RE.test(s.sub) ? undefined : 'var(--mono)', wordBreak: 'break-word', marginTop: 2 }}>{s.sub}</span>}
              </span>
              <span className="muted" style={{ padding: '7px 0', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{gap !== null && gap > 0 ? `+${durKo(gap)}` : ''}</span>
            </li>
          );
        })}
      </ol>
      {rep?.found && <VolumePanel f={rep.fields} d={detail || {}} />}
    </div>
  );
}

/** 원문 로그 — 데몬 거르기 · 경고·오류만 · 검색(처음 맞는 곳 강조) · 줄 번호(원래 로그 기준) · 색(경고·오류·안내·완료) · 원문 복사. */
const WHO_OPTS = Object.freeze([['all', '전체'], ['dir', 'Director'], ['sd', 'SD'], ['fd', 'FD'], ['rep', '보고 블록']]);
function RawLogView({ rows, lines, paneH = LOG_PANE_H }) {
  const [who, setWho] = useState('all');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState('');
  const shown = useMemo(() => filterLogLines(rows, { who, issuesOnly, q }), [rows, who, issuesOnly, q]);
  const counts = useMemo(() => {
    const c = { all: rows.length, dir: 0, sd: 0, fd: 0, rep: 0 };
    for (const r of rows) if (c[r.who] !== undefined) c[r.who]++;
    return c;
  }, [rows]);
  const copy = () => {
    copyToClipboard(lines.join('\n')).then((ok) => setCopied(ok ? '복사했습니다.' : '복사하지 못했습니다.'), () => setCopied('복사하지 못했습니다.'));
  };
  return (
    // 탭 본문 높이(LOG_PANE_H)를 세로로 나눈다 — 도구 줄이 좁은 화면에서 여러 줄로 접혀도 로그 상자가 남은 높이만 채워 창 높이가 탭마다 같다
    <div style={{ height: paneH, display: 'flex', flexDirection: 'column' }}>
      <div style={{ ...ROW, marginBottom: 8, flex: 'none' }}>
        <div className="flex wrap" role="group" aria-label="데몬" style={{ gap: 4 }}>
          {WHO_OPTS.map(([k, l]) => (
            <button key={k} type="button" className={`tab${who === k ? ' active' : ''}`} aria-pressed={who === k} onClick={() => setWho(k)} style={{ padding: '4px 10px', fontSize: 12 }}>{l} {counts[k]}</button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />경고·오류만
        </label>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="문구 검색(예: Volume · CBT · TLS)" aria-label="로그 검색" style={{ flex: '1 1 200px', minWidth: 0, maxWidth: 320 }} />
        <span className="muted" style={{ fontSize: 12 }}>{shown.length === rows.length ? `${rows.length}줄` : `${rows.length}줄 중 ${shown.length}줄`}</span>
        <button type="button" className="logout-btn" style={{ ...BTN, marginLeft: 'auto' }} onClick={copy} disabled={!lines.length}>원문 복사</button>
        {copied && <span className="muted" style={{ fontSize: 11.5 }}>{copied}</span>}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 160, overflow: 'auto', borderRadius: 8, background: 'var(--panel-deep)', border: '1px solid var(--border-soft)', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}>
        {!rows.length && <div className="muted" style={{ padding: 12 }}>로그가 없습니다.</div>}
        {rows.length > 0 && !shown.length && <div className="muted" style={{ padding: 12 }}>조건에 맞는 줄이 없습니다.</div>}
        {shown.map((r) => {
          const [pre, hit, post] = splitHit(r.text, q);
          return (
            // 줄 번호·시각·데몬은 한 덩어리 — 본문이 280px 를 못 받으면(좁은 화면) 다음 줄 전체 폭으로 내려간다(400px 에서 한 단어씩 꺾이던 것)
            <div key={r.n} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, padding: '1px 10px', background: r.level === 'err' ? 'rgba(239,68,68,.07)' : r.level === 'warn' ? 'rgba(245,158,11,.06)' : r.level === 'ok' ? 'rgba(34,197,94,.06)' : undefined }}>
              <span style={{ display: 'grid', gridTemplateColumns: '44px 66px 74px', columnGap: 8, flex: 'none' }}>
                <span style={{ color: 'var(--text-faint)', textAlign: 'right', userSelect: 'none' }}>{r.n}</span>
                <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }} title={r.date}>{r.time || '—'}</span>
                <span>{r.who ? <span className={`badge ${WHO_BADGE[r.who]}`} style={{ fontSize: 10.5, padding: '0 7px' }} title={r.host ? `${r.host}-${r.who}` : undefined}>{LOG_WHO_LABEL[r.who]}</span> : null}</span>
              </span>
              <span style={{ flex: '1 1 280px', minWidth: 0, color: r.who === 'rep' && r.level === 'plain' ? 'var(--text-dim)' : LINE_COLOR[r.level], whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {pre}{hit && <mark style={{ background: 'rgba(245,158,11,.32)', color: '#fde68a', borderRadius: 3, padding: '0 2px' }}>{hit}</mark>}{post}
              </span>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, flex: 'none' }}>시각은 Director 현지 시각(시간대 없음) · 색: 경고 노랑 · 오류 빨강 · 안내 파랑(문구에 Error 가 있어도 플러그인이 처리하고 계속한 줄) · 완료 초록</div>
    </div>
  );
}

