/**
 * Bareos 운영 › 복원 › 재해 복구(1차 — 시안 ② 'vCenter 를 다시 설치한 뒤 법인째 되살리기' · docs 캔버스 Disaster1 · Disaster2 · 사용자 결정 '두 번에 나눠').
 *   ① 새 vCenter 점검(GET dr/check — 포탈이 아는 것만 · 모르는 것은 '?') ② 기준 시각 이전 마지막 성공 백업 · 백업 당시 데이터센터 › 폴더로 고르기
 *   ③ 위치 짝짓기(데이터센터 · 클러스터 필수 · 데이터스토어) ④ 50대씩 미리 보기 → 법인 이름 확인 + 본인 OTP → 시작(restore/bulk dr:true — 새 VM · 끊은 채 · 클러스터는 서버가 지킨다).
 *   복구 순서(단계 자동 실행)는 2차 — 지금은 사람이 50대씩 보낸다. 폴더는 플러그인이 만든다(포탈은 vCenter 에 손대지 않는다).
 *   Director 를 거치는 조회는 자동 재시도 없음 · 엣지 대행 법인은 서버 대기 시간만큼(withRelayWait). 무거운 조회는 버튼으로만(폴링 없음).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import { Note, ReadGuide } from './BareosBits.jsx';
import { withRelayWait, outcomeUnknown, unknownOutcomeText, whenText, levelLabel } from './bareosText.js';
import { pickBlock, dsText, capacityText, bulkRestoreOutcome } from './bareosRestoreText.js';
import { DR_CHUNK, DR_MARK, drBeforeMs, drRows, drSourceDcs, drDefaultMap, drMapIssue, drItem, drNextChunk, drBlocking, drTrialOk } from './bareosDrText.js';

const BASE = '/tools/bareos-backup';
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const FIELD = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', info: '#93c5fd' };

function OutcomeList({ items }) {
  if (!items?.length) return null;
  return (
    <ul style={{ margin: '2px 0 0', paddingLeft: 22, fontSize: 12, lineHeight: 1.6 }}>
      {items.slice(0, 50).map((x, i) => <li key={`${x.vmName}-${i}`} style={{ overflowWrap: 'anywhere', color: x.unknown ? '#fcd34d' : '#fca5a5' }}><b>{x.vmName}</b> — {x.unknown ? '결과 모름 · ' : ''}{x.reason || '사유 미상'}</li>)}
    </ul>
  );
}

export default function BareosDisaster({ d, reload, onBatch = null }) {
  const jobs = useMemo(() => d.jobs || [], [d.jobs]);
  const vcs = useMemo(() => [...new Set(jobs.filter((j) => j.writable !== false).map((j) => j.vcenterId))].sort(), [jobs]);
  const [vc, setVc] = useState(() => vcs[0] || '');
  const [check, setCheck] = useState(null);
  const [checkErr, setCheckErr] = useState(null);
  // 반증 R5: 기본값을 비운다 — '지금' 이면 감염 뒤 마지막 백업을 고르기 쉽다(사람이 시각을 정하게)
  const [beforeText, setBeforeText] = useState('');
  const [pts, setPts] = useState(null);
  const [ptsProg, setPtsProg] = useState(null);
  const [ptsErr, setPtsErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [map, setMap] = useState({});
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // 늦게 온 이전 응답은 버린다 — 점검 · 지점 읽기 · 미리 보기는 서로를 끊지 않게 따로 센다(같은 카운터면 '다시 점검' 이 지점 읽기를 조용히 멈췄다)
  const genCheck = useRef(0);
  const genPts = useRef(0);
  const genPrev = useRef(0);
  const vcRef = useRef(vc);
  vcRef.current = vc;
  const dirId = check?.directorId || '';
  const dir = (d.directors || []).find((x) => x.id === dirId) || null;

  const loadCheck = () => {
    const g = ++genCheck.current;
    setCheck(null); setCheckErr(null);
    if (!vc) return;
    fetchJson(`${BASE}/dr/check`, { vcenterId: vc }).then((r) => { if (g === genCheck.current) setCheck(r); }).catch((e) => { if (g === genCheck.current) setCheckErr(e); });
  };
  // 법인을 바꾸면 그 법인 것만 — 앞 법인의 지점 · 고르기 · 짝짓기를 남기지 않는다
  useEffect(() => { genPts.current++; genPrev.current++; setPts(null); setPtsErr(null); setPtsProg(null); setPicked(new Set()); setMap({}); setPreview(null); setDone(null); setConfirm(''); loadCheck(); }, [vc]);   // eslint-disable-line react-hooks/exhaustive-deps

  const beforeMs = drBeforeMs(beforeText);
  const rows = useMemo(() => drRows(jobs, vc, pts, beforeMs, (j) => pickBlock(j)), [jobs, vc, pts, beforeMs]);
  const shown = useMemo(() => { const n = q.trim().toLowerCase(); return n ? rows.filter((r) => `${r.path} ${r.at.vmName}`.toLowerCase().includes(n)) : rows; }, [rows, q]);
  const pickedRows = rows.filter((r) => picked.has(r.id) && !r.why);
  const sources = useMemo(() => drSourceDcs(pickedRows), [pickedRows.map((r) => r.id).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (check?.targets) setMap((m) => drDefaultMap(sources, check.targets, m)); }, [sources, check]);
  const mapIssue = drMapIssue(sources, map);
  const trialOk = drTrialOk(jobs, vc);
  const chunk = drNextChunk(rows, picked, trialOk ? DR_CHUNK : 1);   // 반증 R1: 이 법인 첫 재해 복구는 1대 — 성공을 본 뒤 50대씩
  const chunkKey = chunk.map((r) => `${r.id}:${r.point?.jobid}`).join('|');
  // 반증 R3: 묶음이 바뀌면(목록 갱신 · 고르기 · 짝짓기) 미리 본 판정을 버린다 — 보내는 것은 미리 본 항목 그대로(preview.items)
  useEffect(() => { genPrev.current++; setPreview(null); }, [chunkKey, JSON.stringify(map)]);   // eslint-disable-line react-hooks/exhaustive-deps
  const blocking = drBlocking(check?.checks);
  const vcName = vc;   // 확인 입력 — 법인(vCenter) id 를 그대로(다른 법인으로 잘못 보내지 않게)

  // ② 복원 지점 — 50대씩 차례로(Director 세션 하나로 VM 마다 이력을 읽는다 · 상한 50)
  const loadPoints = async () => {
    const g = ++genPts.current;
    genPrev.current++;
    const ids = rows.map((r) => r.id);
    setPts(null); setPtsErr(null); setPreview(null); setPtsProg({ done: 0, total: ids.length });
    const acc = new Map();
    try {
      for (let i = 0; i < ids.length; i += DR_CHUNK) {
        const r = await postJson(`${BASE}/restore-points/bulk`, { ids: ids.slice(i, i + DR_CHUNK) }, withRelayWait(DIRECTOR_GET, dir, d.relayLimits, 'restorePoints'));
        if (g !== genPts.current) return;
        for (const x of r.items || []) acc.set(x.id, x);
        setPtsProg({ done: Math.min(ids.length, i + DR_CHUNK), total: ids.length });
      }
      if (g !== genPts.current) return;
      setPts(acc);
      // 처음 읽으면 고를 수 있는 것을 모두 고른다(시안 — 법인째). 사람이 뺀 것은 다시 읽어도 빼 둔다.
      setPicked((p) => (p.size ? p : new Set(ids)));
    } catch (e) { if (g === genPts.current) { setPtsErr(e); setPts(acc.size ? acc : null); } }
  };

  const toggle = (ids, on) => { if (busy) return; genPrev.current++; setPreview(null); setPicked((p) => { const s = new Set(p); for (const id of ids) { if (on) s.add(id); else s.delete(id); } return s; }); };
  const setM = (dc, patch) => { genPrev.current++; setPreview(null); setMap((m) => ({ ...m, [dc]: { ...(m[dc] || {}), ...patch } })); };

  const doPreview = () => {
    const g = ++genPrev.current;
    const items = chunk.map((r) => drItem(r, map));
    setPreview(null); setPreviewErr(null); setDone(null);
    postJson(`${BASE}/restore-check/bulk`, { items, dr: true }).then((r) => { if (g === genPrev.current) setPreview({ ...r, items, before: beforeText }); }).catch((e) => { if (g === genPrev.current) setPreviewErr(e); });
  };
  const start = async () => {
    if (!preview?.items?.length) return;
    const vc0 = vc;
    setBusy(true); setDone(null);
    try {
      const r = await postJson(`${BASE}/restore/bulk`, { items: preview.items, dr: true, drBefore: preview.before, otp }, withRelayWait({}, dir, d.relayLimits, 'restores'));
      requireChanged(r);
      if (vcRef.current !== vc0) { reload(); return; }   // 반증 R9: 그사이 법인을 바꿨으면 이전 법인 결과를 새 화면에 띄우지 않는다
      setDone(bulkRestoreOutcome(r));
      if (r.batchId) onBatch?.(r.batchId);
      setPreview(null); setConfirm('');
      reload();
    } catch (e) {
      const unknown = outcomeUnknown(e);
      const o = bulkRestoreOutcome(e?.body || null, { unknown, message: unknown ? unknownOutcomeText('재해 복구', e) : e.message });
      if (vcRef.current !== vc0) { reload(); return; }
      setDone(o);
      if (o.reset) { setPreview(null); if (e?.body?.batchId) onBatch?.(e.body.batchId); reload(); }
    } finally { setBusy(false); setOtp(''); }
  };

  if (!vcs.length) return <div className="card" style={{ padding: 14 }} data-bareos-dr=""><Note tone="info">쓰기 권한이 있는 백업 대상이 없습니다 — 재해 복구는 그 법인에 등록된 백업 대상으로만 합니다.</Note></div>;
  const planOk = !!preview?.plan?.ok;
  const canStart = planOk && !preview?.needEnroll && confirm.trim() === String(vcName) && /^\d{6}$/.test(otp) && !busy;
  const allIds = shown.filter((r) => !r.why).map((r) => r.id);
  const allOn = allIds.length > 0 && allIds.every((id) => picked.has(id));

  return (
    <div data-bareos-dr="" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={ROW}>
          <b style={{ fontSize: 14 }}>재해 복구 — vCenter 를 다시 설치한 뒤 법인째 되살리기</b>
          <span style={{ flex: '1 1 auto' }} />
          <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}>법인(vCenter)
            <Select className="input" style={{ minWidth: 0, maxWidth: 260 }} value={vc} onChange={(e) => setVc(e.target.value)} aria-label="재해 복구 법인">
              {vcs.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </label>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>지금 vCenter 가 아니라 <b>백업할 때 기록한 데이터센터 · 폴더</b>로 고르고, 새 vCenter 의 위치에 짝지어 <b>새 VM · 네트워크 끊은 채</b>로 만듭니다. 기존 VM 은 덮어쓰지 않습니다.</span>
        {done && <div style={{ minWidth: 0 }}><Note tone={done.tone}>{done.text}</Note><OutcomeList items={done.items} /></div>}
      </div>

      {/* ① 새 vCenter 점검 */}
      <section className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }} data-dr-check="">
        <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ fontSize: 13.5 }}>1. 새 vCenter 점검</b>
          <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>읽기만 합니다 · ✕ 가 있으면 보내기를 막습니다 · ? 는 포탈이 읽을 수 없는 것(확인 방법을 따르세요)</span>
          <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} onClick={loadCheck}>다시 점검</button>
        </div>
        {checkErr && <div style={{ padding: 12 }}><ErrorBox error={checkErr} /></div>}
        {!check && !checkErr && <div style={{ padding: 12 }}><Loading /></div>}
        {check && check.checks.map((c) => {
          const [mk, tone] = DR_MARK[c.state] || DR_MARK.unknown;
          return (
            // 설명은 항목명 아래로 — 3열(표지 · 항목 · 설명)이면 400px 에서 설명 칸이 80px 남짓으로 좁아져 한두 단어씩 길게 늘어졌다(Chromium 판독)
            <div key={c.key} style={{ display: 'grid', gridTemplateColumns: '26px minmax(0, 1fr)', gap: 10, alignItems: 'start', padding: '9px 14px', borderBottom: '1px solid var(--border-soft)' }}>
              <span aria-label={c.state} style={{ color: TONE[tone], fontWeight: 800, textAlign: 'center' }}>{mk}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <b style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{c.label}</b>
                <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{c.detail}{c.lastOk ? ` · 마지막 성공 ${whenText(c.lastOk)}` : ''}</span>
              </div>
            </div>
          );
        })}
      </section>

      {/* ② 백업 당시 폴더에서 고르기 */}
      <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }} data-dr-pick="">
        <div style={ROW}>
          <b style={{ fontSize: 13.5 }}>2. 백업 당시 폴더에서 고르기</b>
          <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12 }}>이 시각 이전 마지막 성공 백업
            <input className="input" type="datetime-local" value={beforeText} onChange={(e) => { genPrev.current++; setBeforeText(e.target.value); setPreview(null); }} aria-label="복원 기준 시각" style={{ minWidth: 0 }} />
          </label>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy || !rows.length || (ptsProg && !pts && !ptsErr)} onClick={loadPoints}>{pts ? '복원 지점 다시 읽기' : `복원 지점 읽기 · ${rows.length}대`}</button>
        </div>
        <span style={{ fontSize: 12, color: TONE.warn }}>감염 추정 시각보다 앞으로 잡으세요 — 그 뒤 백업은 감염된 상태일 수 있습니다. 시작 시각을 못 읽은 백업은 고르지 않습니다.</span>
        <span className="muted" style={{ fontSize: 12 }}>시각 기준: 입력은 이 브라우저 시간대, 백업 시각은 Director 현지 시각을 포탈 서버 시간대로 읽은 값입니다 — Director 가 다른 시간대(예: 폴란드)면 그 차이만큼 어긋나니 여유를 두고 잡으세요.</span>
        {beforeMs === null && <Note tone="bad">기준 시각을 읽지 못했습니다 — 날짜와 시각을 다시 고르세요.</Note>}
        {ptsProg && !pts && !ptsErr && <span className="muted" style={{ fontSize: 12 }}>복원 지점 읽는 중… {ptsProg.done} / {ptsProg.total}대</span>}
        {ptsErr && <ErrorBox error={ptsErr} />}
        {pts && (
          <>
            <div style={ROW}>
              <input className="input" style={{ minWidth: 0, width: 240 }} placeholder="VM · 폴더 이름" value={q} onChange={(e) => setQ(e.target.value)} aria-label="VM · 폴더 찾기" />
              <span className="muted" style={{ fontSize: 12 }}>고를 수 있음 {rows.filter((r) => !r.why).length} / {rows.length}대 · 고름 {pickedRows.length}대</span>
              <label className="muted" style={{ ...ROW, gap: 6, fontSize: 12, marginLeft: 'auto' }}>
                <input type="checkbox" checked={allOn} disabled={!allIds.length || busy} onChange={(e) => toggle(allIds, e.target.checked)} />보이는 것 모두
              </label>
            </div>
            <div className="table-wrap" style={{ maxHeight: '52vh' }}>
              <STable minWidth={860} wrap={false}>
                <thead><tr><th data-nosort="">선택</th><th>백업 당시 데이터센터 › 폴더</th><th>VM</th><th>쓸 백업(기준 시각 이전)</th><th>체인</th><th>상태</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} style={{ opacity: r.why ? 0.6 : 1 }}>
                      <td><input type="checkbox" checked={picked.has(r.id) && !r.why} disabled={!!r.why || busy} onChange={(e) => toggle([r.id], e.target.checked)} aria-label={`${r.at.vmName} 고르기`} /></td>
                      <td data-sort={r.path} style={{ fontSize: 12 }}>{r.path}</td>
                      <td data-sort={r.at.vmName}><b>{r.at.vmName}</b></td>
                      <td data-sort={r.point?.startedAt ?? ''} style={{ fontSize: 12 }}>{r.point ? `${whenText(r.point.startedAt)} · ${levelLabel(r.point.level)} · jobid ${r.point.jobid}` : '—'}</td>
                      <td data-sort={r.point?.chain ?? ''}>{r.point?.chain ?? '—'}</td>
                      <td style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 280, color: r.why ? TONE.warn : TONE.ok }}>{r.why || '새로 만듦(이름 그대로)'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          </>
        )}
      </section>

      {/* ③ 위치 짝짓기 */}
      {pts && sources.length > 0 && check?.targets && (
        <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }} data-dr-map="">
          <div style={ROW}>
            <b style={{ fontSize: 13.5 }}>3. 위치 짝짓기 — 백업 당시 → 새 vCenter</b>
            <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>폴더는 백업 당시 경로대로 Bareos 플러그인이 만듭니다 · 네트워크는 모두 끊은 채(재해 복구는 끌 수 없음)</span>
          </div>
          {sources.map(({ dc, n }) => {
            const m = map[dc] || {};
            const cls = (check.targets.clusters || []).filter((c) => !m.dc || c.dc === m.dc);
            return (
              <div key={dc || '-'} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8, alignItems: 'end', padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 10, minWidth: 0 }}>
                <div style={{ ...FIELD, justifyContent: 'center' }}><span className="muted">백업 당시 데이터센터</span><b style={{ overflowWrap: 'anywhere' }}>{dc || '—'} <span className="muted" style={{ fontWeight: 400 }}>· {n}대</span></b></div>
                <label className="muted" style={FIELD}>새 vCenter 데이터센터
                  <Select className="input" style={{ minWidth: 0 }} value={m.dc || ''} onChange={(e) => setM(dc, { dc: e.target.value, cluster: '' })} aria-label={`${dc} 데이터센터 짝`}>
                    <option value="">고르기…</option>
                    {(check.targets.dcs || []).map((x) => <option key={x} value={x}>{x}{x === dc ? ' (같은 이름)' : ''}</option>)}
                  </Select>
                </label>
                <label className="muted" style={FIELD}>클러스터(필수)
                  <Select className="input" style={{ minWidth: 0 }} value={m.cluster || ''} onChange={(e) => setM(dc, { cluster: e.target.value })} aria-label={`${dc} 클러스터 짝`}>
                    <option value="">고르기…</option>
                    {cls.map((c) => <option key={`${c.dc}-${c.name}`} value={c.name}>{c.name}</option>)}
                  </Select>
                </label>
                <label className="muted" style={FIELD}>데이터스토어
                  <Select className="input" style={{ minWidth: 0 }} value={m.datastore || ''} onChange={(e) => setM(dc, { datastore: e.target.value })} aria-label={`${dc} 데이터스토어 짝`}>
                    <option value="">백업 당시 그대로(같은 이름이 있어야 함)</option>
                    {(check.targets.datastores || []).filter((x) => x.accessible !== false).map((x) => <option key={x.name} value={x.name}>{dsText(x)}</option>)}
                  </Select>
                </label>
              </div>
            );
          })}
          {mapIssue && <span style={{ fontSize: 12, color: TONE.warn }}>{mapIssue}</span>}
        </section>
      )}

      {/* ④ 50대씩 확인 · OTP */}
      {pts && (
        <section className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, borderColor: '#7f1d1d' }} data-dr-send="">
          <div style={ROW}>
            <b style={{ fontSize: 13.5 }}>4. 확인 · OTP</b>
            <span className="muted" style={{ fontSize: 12, minWidth: 0 }}>{trialOk ? `한 번에 ${DR_CHUNK}대까지 보냅니다 — 보낸 VM 은 다음 묶음에서 빠집니다(복구 순서 자동 실행은 다음 판).` : '이 법인의 첫 재해 복구는 1대입니다 — 성공으로 끝난 것을 확인한 뒤 50대씩 보낼 수 있습니다(Bareos 플러그인은 백업 때 저장한 vCenter 접속값으로 디스크를 씁니다 — vCenter 를 다시 설치해 인증서 지문이 바뀌었으면 VM 껍데기만 생기고 실패할 수 있습니다).'}</span>
          </div>
          <div style={ROW}>
            <span>고름 <b>{pickedRows.length}</b>대 · 이번 묶음 <b>{chunk.length}</b>대{pickedRows.length > chunk.length ? ` · 남음 ${pickedRows.length - chunk.length}대` : ''}</span>
            {blocking > 0 && <span style={{ fontSize: 12, color: TONE.bad }}>점검 ✕ {blocking}건 — 먼저 해결하세요</span>}
            <button type="button" className="tab" style={{ padding: '5px 12px', fontSize: 12, marginLeft: 'auto' }} disabled={busy || !chunk.length || !!mapIssue || blocking > 0 || beforeMs === null} onClick={doPreview}>미리 보기 · {chunk.length}대</button>
          </div>
          {previewErr && <ErrorBox error={previewErr} />}
          {preview && (
            <>
              {!preview.plan.ok && <Note tone="bad">{preview.plan.issue || '보낼 수 없는 VM 이 있습니다.'}</Note>}
              {preview.plan.items.filter((x) => !x.ok).slice(0, 20).map((x) => <span key={x.id} style={{ fontSize: 12, color: TONE.bad, overflowWrap: 'anywhere' }}>{x.vmName || x.id} — {x.issue}</span>)}
              {(preview.plan.capacity || []).map((c) => <Note key={c.datastore} tone={c.verdict === 'short' ? 'bad' : c.verdict === 'unknown' ? 'warn' : 'info'}>{capacityText(c)}</Note>)}
              {preview.needEnroll && <Note tone="bad">복원은 OTP 가 등록된 계정만 실행할 수 있습니다 — 사용자 관리에서 OTP 를 등록하세요.</Note>}
              {planOk && <Note tone="info">이번 묶음 {preview.items.length}대 · 기준 시각 {String(preview.before || '').replace('T', ' ')} 이전 백업 — 새 VM · 꺼진 채 · 네트워크 끊은 채로 만들어집니다. 진행은 아래 최근 묶음 복원에서 보입니다.</Note>}
              <div style={ROW}>
                <label className="muted" style={{ ...FIELD, width: 220 }}>법인(vCenter) 확인 — ‘{vcName}’ 입력
                  <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" aria-label="법인 이름 확인" disabled={!planOk} />
                </label>
                <label className="muted" style={{ ...FIELD, width: 160 }}>본인 OTP(6자리)
                  <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="재해 복구 OTP" disabled={!planOk} />
                </label>
                <button type="button" className="logout-btn" style={{ marginLeft: 'auto', padding: '8px 16px', fontWeight: 800 }} disabled={!canStart} onClick={start}>{busy ? '요청 중…' : `재해 복구 시작 · ${preview.items.length}대`}</button>
              </div>
            </>
          )}
        </section>
      )}

      <ReadGuide note="재해 복구는 포탈 원장(백업 때 위치)과 Bareos 카탈로그(복원 지점)로 그립니다 — 지금 vCenter 인벤토리에 VM 이 없어도 됩니다.">
        <div>① 점검의 ? 는 포탈이 읽을 수 없는 것입니다 — vCenter 를 다시 설치하면 FD 의 INI 인증서 지문이 바뀝니다. 설정 › 법인별 Director 의 FD INI 자동 설정으로 다시 쓰거나 1대를 먼저 복원해 확인하세요.</div>
        <div>② 쓸 백업은 기준 시각 이전에 시작한 마지막 성공 백업(체인이 있는 것)입니다. 이름은 백업 때 VM 이름 그대로 — 새 vCenter 에 같은 이름이 있으면 그 VM 은 막힙니다.</div>
        <div>③ 클러스터는 필수입니다 — 지정하지 않으면 플러그인이 백업 때 호스트를 찾는데, 다시 설치한 vCenter 에는 없을 수 있습니다. 데이터스토어를 고르지 않으면 백업 때 이름의 데이터스토어를 씁니다.</div>
        <div>④ 법인 이름 확인과 본인 OTP 는 묶음마다 한 번입니다. 실행자 · 대상 · 원본 체인은 감사 로그(Bareos 재해 복구)에 남습니다.</div>
      </ReadGuide>
    </div>
  );
}
