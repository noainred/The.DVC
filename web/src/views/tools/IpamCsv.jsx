// IpamCsv.jsx — IP관리 › CSV 가져오기·내보내기(v2.636).
// 사용자 요청: "대용량 CSV import/export" · 선택 "IP 관리상태 + 스캔 대역".
//  ① 대장 내보내기(CSV·엑셀) ② IP 관리상태·메모·태그 CSV(내보내기 → 고쳐서 → 검증 → 적용) ③ 에이전트별 스캔 대역 CSV
// 판정은 서버가 한다(server/src/ipam/manageCsv.js·scanRangesCsv.js). 화면은 큰 파일을 서버 한도 안의 조각으로 나눠 보내고
// (ipamCsvChunk.js — 서버 파서와 같은 행 경계), 결과를 합쳐 말한다. 입력은 편집 초안에 남는다(다른 페이지로 옮겨도 그대로).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile, postJson, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { downloadFailText } from '../downloadFailText.js';
import { dayStamp } from '../../dayStamp.js';
import { chunkRecords, commentRecord, ipColumnIndex, mergeManageReports, splitCsvRecords } from './ipamCsvChunk.js';
import { actionBadge, applicableCount, changesText, MANAGE_ACTION, MANAGE_RULES, manageApplyText, manageSummaryText, MODE_NOTE, planText, RANGE_ACTION, rangeSummaryText } from './ipamCsvText.js';
import { useIpamDraft } from './useIpamDraft.js';
import { DraftBanner } from './IpamDraftBanner.jsx';
import { agentLabel, LOCAL_AGENT } from './ipamShared.jsx'; // v2.639(U3): '__local__' → '이 포탈' 표시 한 벌

const FILE_MAX = 30 * 1024 * 1024;       // 브라우저에서 읽을 파일 상한(이보다 크면 나눠서)
const RANGES_BODY_MAX = 900 * 1024;      // 스캔 대역 CSV 는 한 번에 보낸다(서버 본문 한도 1MB)
const REPORT_SHOW = 1000;

/** 텍스트 지문(검증한 텍스트와 적용할 텍스트가 같은지 — 검증 뒤 고쳤으면 다시 검증해야 한다). */
function textSig(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

function Section({ title, children, note }) {
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <b style={{ fontSize: 14 }}>{title}</b>
      {note && <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px', lineHeight: 1.7 }}>{note}</div>}
      {children}
    </div>
  );
}

function Msg({ m }) {
  if (!m) return null;
  return <div className={`banner ${m.ok ? 'ok' : 'error'}`} role={m.ok ? 'status' : 'alert'} style={{ marginTop: 8, whiteSpace: 'normal', overflowWrap: 'anywhere' }}><BoldText text={m.text} /></div>;
}

/** 파일 선택 → 텍스트. */
function FilePick({ onText, disabled }) {
  const ref = useRef(null);
  const [err, setErr] = useState('');
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > FILE_MAX) { setErr(`파일이 ${Math.round(f.size / 1048576)}MB 입니다 — ${FILE_MAX / 1048576}MB 이하로 나눠 주세요.`); return; }
    setErr('');
    try { onText(await f.text(), f.name); } catch (ex) { setErr(`파일을 읽지 못했습니다: ${ex?.message || ex}`); }
  };
  return (
    <>
      <input ref={ref} type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={pick} />
      <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={disabled} onClick={() => ref.current?.click()}>📂 파일 선택</button>
      {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span>}
    </>
  );
}

/* ── ② IP 관리상태·메모 CSV ─────────────────────────────────────────────── */
function ManageCsv({ scope, canManage, onApplied }) {
  const d = useIpamDraft('csv:manage');
  useEffect(() => { if (!d.loaded) d.load(''); }, [d.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = d.value ?? '';
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total, phase }
  const [check, setCheck] = useState(null);       // { sig, report, summary, skip, total, chunks, columns }
  const [applied, setApplied] = useState(null);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('attention');
  const sp = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
  const dl = async (path, name) => { setMsg(null); try { await downloadFile(path, name); } catch (e) { setMsg({ ok: false, text: downloadFailText(e) }); } };

  const parsed = useMemo(() => (text.trim() ? splitCsvRecords(text) : null), [text]);
  const stale = check && check.sig !== textSig(text);

  const validate = async () => {
    setMsg(null); setApplied(null); setCheck(null);
    if (!parsed?.header) { setMsg({ ok: false, text: 'CSV 내용이 비어 있습니다 — 파일을 고르거나 붙여 넣으세요.' }); return; }
    if (!parsed.records.length) { setMsg({ ok: false, text: '헤더 아래에 데이터 행이 없습니다.' }); return; }
    const chunks = chunkRecords(parsed);
    setBusy(true);
    const results = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ phase: '검증', done: i, total: chunks.length });
        results.push(await postJson('/tools/ipam/manage/import', { csv: chunks[i].csv, dryRun: true, lineOffset: chunks[i].lineOffset }));
      }
      const m = mergeManageReports(results);
      setCheck({ sig: textSig(text), ...m, total: parsed.records.length, chunks: chunks.length, columns: results[0]?.columns || [] });
      setFilter(m.summary.error ? 'error' : 'attention');
    } catch (e) {
      setMsg({ ok: false, text: `검증하지 못했습니다${chunks.length > 1 ? `(${results.length + 1}/${chunks.length}번째 조각)` : ''}: ${e?.message || e}` });
    } finally { setBusy(false); setProgress(null); }
  };

  const apply = async () => {
    if (!check || stale) return;
    const n = applicableCount(check.summary);
    if (!n) return;
    if (!window.confirm(`검증 결과 ${n}행을 적용합니다(오류 ${check.summary.error}행은 적용하지 않습니다).\n적용 직전에 서버가 다시 판정합니다. 계속할까요?`)) return;
    setMsg(null); setBusy(true);
    const ipIdx = ipColumnIndex(parsed.header.cells);
    const replace = new Map([...check.skip].map((i) => [i, commentRecord(ipIdx, parsed.delim)]));
    const chunks = chunkRecords(parsed, { replace });
    const results = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ phase: '적용', done: i, total: chunks.length });
        results.push(await postJson('/tools/ipam/manage/import', { csv: chunks[i].csv, dryRun: false, lineOffset: chunks[i].lineOffset }));
      }
      const m = mergeManageReports(results);
      const sum = (k) => results.reduce((a, r) => a + (r?.[k] || 0), 0);
      const sub = (k, f) => results.reduce((a, r) => a + (r?.[k]?.[f] || 0), 0);
      const r = { applied: sum('applied'), override: { changed: sub('override', 'changed'), removed: sub('override', 'removed') },
        annotation: { changed: sub('annotation', 'changed'), removed: sub('annotation', 'removed') }, summary: m.summary };
      setApplied(r);
      setCheck({ sig: textSig(text), ...m, total: parsed.records.length, chunks: chunks.length, columns: results[0]?.columns || [], afterApply: true });
      setMsg({ ok: true, text: manageApplyText(r) });
      d.saved(text);   // 적용했으니 '적용하지 않은 입력' 표시를 내린다(입력 글은 결과와 함께 보이도록 둔다)
      onApplied?.();
    } catch (e) {
      const doneRows = chunks.slice(0, results.length).reduce((a, c) => a + c.rows, 0);
      setMsg({ ok: false, text: `적용이 중간에 멈췄습니다: ${e?.message || e} — 앞의 ${results.length}개 조각(데이터 ${doneRows}행)은 **이미 적용됐고**, 그 뒤는 적용하지 않았습니다. 다시 검증하면 남은 행이 보입니다.` });
      if (results.length) onApplied?.();
    } finally { setBusy(false); setProgress(null); }
  };

  const rows = (check?.report || []).filter((x) => (filter === 'all' ? true : filter === 'error' ? x.action === 'error' : x.action !== 'same'));
  const n = check ? applicableCount(check.summary) : 0;
  return (
    <Section title="IP 관리상태 · 메모 · 태그 CSV" note="IP 단위로 지정하는 관리상태(상태·디바이스·담당자·라벨·호스트명·귀속 vCenter·예약 만료·비고)와 메모·태그를 한 파일로 내보내고, 고친 파일을 다시 가져옵니다. 범위(vCenter) 밖 IP 는 내보내지 않습니다.">
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={() => dl(`/tools/ipam/manage.csv${sp}`, `ip-manage-${dayStamp()}.csv`)}>⇩ 현재 관리상태 내보내기</button>
        <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => dl('/tools/ipam/manage/sample.csv', 'ip-manage-sample.csv')}>샘플 CSV</button>
        {scope && <span className="muted" style={{ fontSize: 12 }}>선택한 범위의 vCenter 귀속 IP 만 내보냅니다</span>}
      </div>
      <ul className="muted" style={{ fontSize: 12, lineHeight: 1.8, margin: '10px 0', paddingLeft: 18 }}>
        {MANAGE_RULES.map((t) => <li key={t}><BoldText text={t} /></li>)}
      </ul>
      {!canManage && <div className="banner warn" style={{ marginBottom: 8 }}>가져오기(검증·적용)는 운영자·관리자 계정만 할 수 있습니다 — 내보내기는 누구나 됩니다.</div>}
      <DraftBanner d={d} revertLabel="입력 지우기" kind="import" />
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <FilePick disabled={busy || !canManage} onText={(t, name) => { d.set(t); setFileName(name); setCheck(null); setApplied(null); setMsg(null); }} />
        {fileName && <span className="muted" style={{ fontSize: 12 }}>{fileName}</span>}
        {parsed?.header && <span className="muted" style={{ fontSize: 12 }}>데이터 {parsed.records.length.toLocaleString()}행</span>}
      </div>
      <textarea className="input" rows={8} value={text.length > 400_000 ? `${text.slice(0, 400_000)}\n…(큰 파일은 앞부분만 보여 줍니다 — 가져오기에는 전체를 씁니다)` : text}
        readOnly={text.length > 400_000 || !canManage} onChange={(e) => { d.set(e.target.value); setCheck(null); setApplied(null); }}
        placeholder={'ip,status,owner,memo,tags\n10.10.0.25,reserved,홍길동,이관 예정,db; 이관'}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
      <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 8 }}>
        <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={busy || !canManage || !parsed?.header} onClick={validate}>① 검증(저장 안 함)</button>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={busy || !canManage || !check || stale || !n || check.afterApply}
          title={!check ? '먼저 검증하세요' : stale ? '검증 뒤 내용이 바뀌었습니다 — 다시 검증하세요' : undefined} onClick={apply}>② 적용({n.toLocaleString()}행)</button>
        {progress && <span className="muted" style={{ fontSize: 12 }}>{progress.phase} 중… {progress.done}/{progress.total} 조각</span>}
        {stale && <span style={{ color: 'var(--amber)', fontSize: 12 }}>검증 뒤 내용이 바뀌었습니다 — 다시 검증하세요.</span>}
      </div>
      <Msg m={msg} />
      {check && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}><b>{check.afterApply ? '적용 결과' : '검증 결과'}</b> · {manageSummaryText(check.summary, { total: check.total, chunks: check.chunks })}</div>
          <div className="flex gap wrap" style={{ marginBottom: 6 }}>
            {[['attention', '변경·오류만'], ['error', `오류만 (${check.summary.error})`], ['all', '전체']].map(([k, l]) => (
              <button key={k} className={`tab ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <STable minWidth={760} limit={REPORT_SHOW}>
            <thead><tr><th>행</th><th>IP</th><th>결과</th><th>바뀌는 항목</th><th>사유</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 16 }}>해당하는 행이 없습니다.</td></tr>}
              {rows.map((x) => {
                const [label, tone] = actionBadge(MANAGE_ACTION, x.action);
                return (
                  <tr key={`${x.line}-${x.ip}`}>
                    <td data-sort={x.line}>{x.line}</td>
                    <td style={{ fontFamily: 'monospace' }}>{x.ip || '—'}</td>
                    <td><span className={`badge ${tone}`}>{label}</span></td>
                    <td style={{ fontSize: 12 }}>{changesText(x.changes)}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 240 }}>{x.reason || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          {rows.length > REPORT_SHOW && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{rows.length.toLocaleString()}행 중 {REPORT_SHOW.toLocaleString()}행만 표시합니다(정렬은 전체 기준) — ‘오류만’ 으로 좁히면 나머지도 보입니다.</div>}
          {applied && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>대장 목록은 다음 조회부터 새 값을 보여 줍니다.</div>}
        </div>
      )}
    </Section>
  );
}

/* ── ③ 에이전트별 스캔 대역 CSV ─────────────────────────────────────────── */
export function RangesCsv({ onApplied }) { // v2.638: IP 스캔 설정 페이지에서도 연다(같은 초안 키 — 두 곳의 입력이 하나다)
  const d = useIpamDraft('csv:ranges');
  useEffect(() => { if (!d.loaded) d.load(''); }, [d.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = d.value ?? '';
  const [mode, setMode] = useState('replace');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [msg, setMsg] = useState(null);
  const dl = async (path, name) => { setMsg(null); try { await downloadFile(path, name); } catch (e) { setMsg({ ok: false, text: downloadFailText(e) }); } };
  const stale = check && (check.sig !== textSig(text) || check.mode !== mode);
  const tooBig = text.length > RANGES_BODY_MAX;
  const send = async (dryRun) => {
    setMsg(null);
    if (!text.trim()) { setMsg({ ok: false, text: 'CSV 내용이 비어 있습니다.' }); return; }
    if (tooBig) { setMsg({ ok: false, text: `대역 CSV 가 ${Math.round(text.length / 1024)}KB 입니다 — 한 번에 ${Math.round(RANGES_BODY_MAX / 1024)}KB 까지 보냅니다. 에이전트별로 나눠 주세요.` }); return; }
    if (!dryRun) {
      const ch = (check?.plans || []).filter((p) => !p.blocked && (p.added.length || p.removed.length)).length;
      const rm = (check?.plans || []).filter((p) => !p.blocked).reduce((a, p) => a + p.removed.length, 0);
      if (!window.confirm(`에이전트 ${ch}곳의 스캔 대역을 바꿉니다${rm ? `(지워지는 대역 ${rm}개)` : ''}. 오류가 있는 에이전트는 적용하지 않습니다.\n계속할까요?`)) return;
    }
    setBusy(true);
    try {
      const r = await postJson('/admin/ipam/scan/ranges/import', { csv: text, dryRun, mode });
      if (dryRun) setCheck({ sig: textSig(text), mode, ...r });
      else {
        setCheck({ sig: textSig(text), mode, ...r, plans: check?.plans || [], afterApply: true });
        const a = (r.applied || []).map((x) => `${agentLabel(x.agent)}(+${x.added} −${x.removed})`).join(', ');
        setMsg({ ok: true, text: `적용 — 에이전트 ${(r.applied || []).length}곳${a ? `: ${a}` : ''}${(r.blocked || []).length ? ` · 오류로 적용하지 않은 에이전트 ${(r.blocked || []).length}곳` : ''}${(r.failed || []).length ? ` · 저장 실패 ${(r.failed || []).length}곳` : ''}. 엣지 에이전트는 다음 주기에 새 대역을 읽어 갑니다.` });
        d.saved(text);   // 적용했으니 '적용하지 않은 입력' 표시를 내린다
        onApplied?.();
      }
    } catch (e) { setMsg({ ok: false, text: `${dryRun ? '검증' : '적용'}하지 못했습니다: ${e?.message || e}` }); }
    finally { setBusy(false); }
  };
  const plans = check?.plans || [];
  const changing = plans.filter((p) => !p.blocked && (p.added.length || p.removed.length)).length;
  // v2.643: 방어선 — CSV 권한이 없으면 안내 한 줄(훅은 모두 위에 — React #310).
  if (!canCsv()) return <div className="muted" style={{ fontSize: 12 }}>{CSV_DENIED_NOTE}</div>;
  return (
    <Section title="IP 스캔 대역 CSV(에이전트별)" note="IP 스캔 설정의 대역을 에이전트(엣지)별로 한 파일에서 고칩니다. agent 열은 에이전트 이름, 이 포탈에서 직접 스캔하는 대역은 __local__(또는 ‘이 포탈’)입니다. 한 줄에 대역 하나.">
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={() => dl('/admin/ipam/scan/ranges.csv', `ip-scan-ranges-${dayStamp()}.csv`)}>⇩ 현재 스캔 대역 내보내기</button>
        <button className="logout-btn" style={{ padding: '7px 12px' }} onClick={() => dl('/admin/ipam/scan/ranges/sample.csv', 'ip-scan-ranges-sample.csv')}>샘플 CSV</button>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', margin: '10px 0 6px' }}>
        {['replace', 'add'].map((m) => (
          <label key={m} className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="radio" name="ipam-ranges-mode" checked={mode === m} onChange={() => setMode(m)} /> {m === 'replace' ? '교체' : '추가'}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{MODE_NOTE[mode]} 오류 줄이 하나라도 있는 에이전트는 통째로 적용하지 않습니다(교체에서 오류 줄만 빼면 그 대역이 조용히 지워집니다).</div>
      <DraftBanner d={d} revertLabel="입력 지우기" kind="import" />
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <FilePick disabled={busy} onText={(t) => { d.set(t); setCheck(null); setMsg(null); }} />
      </div>
      <textarea className="input" rows={6} value={text} onChange={(e) => { d.set(e.target.value); setCheck(null); }}
        placeholder={'agent,range\n__local__,10.10.0.0/24\nedge-seoul,172.16.5.0/26'}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
      <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 8 }}>
        <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={busy || !text.trim()} onClick={() => send(true)}>① 검증(저장 안 함)</button>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={busy || !check || stale || !changing || check.afterApply}
          title={!check ? '먼저 검증하세요' : stale ? '검증 뒤 내용·모드가 바뀌었습니다 — 다시 검증하세요' : undefined} onClick={() => send(false)}>② 적용(에이전트 {changing}곳)</button>
        {stale && <span style={{ color: 'var(--amber)', fontSize: 12 }}>검증 뒤 내용·모드가 바뀌었습니다 — 다시 검증하세요.</span>}
      </div>
      <Msg m={msg} />
      {check && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}><b>{check.afterApply ? '적용 결과' : '검증 결과'}</b> · {rangeSummaryText(check.summary, check.mode)}</div>
          <STable minWidth={640}>
            <thead><tr><th>에이전트</th><th>결과</th></tr></thead>
            <tbody>
              {plans.length === 0 && <tr><td colSpan={2} className="center muted" style={{ padding: 14 }}>바꿀 에이전트가 없습니다.</td></tr>}
              {plans.map((p) => (
                <tr key={p.key}>
                  <td><b>{agentLabel(p.agent)}</b>{p.agent === LOCAL_AGENT && <span className="muted" style={{ fontSize: 11 }}> (__local__)</span>}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere', color: p.blocked ? 'var(--red)' : undefined }}>{planText(p)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          {(check.report || []).some((x) => x.action === 'error' || x.warn || x.action === 'dup') && (
            <STable minWidth={640} style={{ marginTop: 8 }}>
              <thead><tr><th>행</th><th>에이전트</th><th>대역</th><th>결과</th><th>사유</th></tr></thead>
              <tbody>
                {(check.report || []).filter((x) => x.action === 'error' || x.warn || x.action === 'dup').map((x) => {
                  const [label, tone] = actionBadge(RANGE_ACTION, x.action);
                  return (
                    <tr key={`${x.line}`}>
                      <td>{x.line}</td><td>{x.agent}</td><td style={{ fontFamily: 'monospace' }}>{x.range || '—'}</td>
                      <td><span className={`badge ${x.warn && x.action !== 'error' ? 'amber' : tone}`}>{x.warn && x.action !== 'error' ? `${label} · 경고` : label}</span></td>
                      <td style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{x.reason || x.warn || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          )}
        </div>
      )}
    </Section>
  );
}

/* ── 페이지 ─────────────────────────────────────────────────────────────── */
export function IpamCsv({ scope, access, canManage, onGoto, onApplied }) {
  const [msg, setMsg] = useState(null);
  const sp = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
  const dl = async (path, name) => { setMsg(null); try { await downloadFile(path, name); } catch (e) { setMsg({ ok: false, text: downloadFailText(e) }); } };
  // v2.643: 이 페이지는 CSV 전용 — 관리자 이상 + data.csv 권한이 없으면 안내 한 줄(메뉴에서도 숨긴다. 훅은 모두 위에).
  if (!canCsv()) return <div className="ipam-page card muted" style={{ padding: 14, fontSize: 12.5, minWidth: 0 }}>{CSV_DENIED_NOTE}</div>;
  return (
    <div className="ipam-page" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      <Section title="IP 관리대장 내보내기" note="수집(vCenter)·스캔·수동 등록을 합친 대장 전체입니다. 읽기 전용 내보내기이고 가져오기 대상이 아닙니다(대장은 수집으로 만들어집니다).">
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <button className="logout-btn" style={{ padding: '7px 14px' }} onClick={() => dl(`/tools/ipam.csv${sp}`, `ipam-${dayStamp()}.csv`)}>⇩ 대장 CSV</button>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} onClick={() => dl(`/tools/ipam.xlsx${sp}`, `ip-ledger-${dayStamp()}.xlsx`)}>⇩ 엑셀 대장(.xlsx)</button>
          {scope && <span className="muted" style={{ fontSize: 12 }}>선택한 범위만 내보냅니다</span>}
        </div>
        <Msg m={msg} />
      </Section>
      <ManageCsv scope={scope} canManage={canManage} onApplied={onApplied} />
      {access !== 'no' && <RangesCsv onApplied={onApplied} />}
    </div>
  );
}
