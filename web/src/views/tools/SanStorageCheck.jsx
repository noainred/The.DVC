// v2.948 — SAN 스토리지 성능 › 성능 점검 탭(설계 ⑥). 판정은 서버 storagePerfCheck(순수 · 저장 표본만 — 새 접속 없음) · 여기는 표와 기준 설정만.
//   상태 4종 + 해당 없음: 정상 · 주의 · 이상 · **확인 불가**(unknown 을 정상으로 뭉개지 않는다 — '정상(일부 미확인)'). 기준 기본값은 벤더 문서 값만(출처 열) · 못 찾은 것은 비움.
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { CHECK_MARK, overallText, thresholdText, rateText, dateClockText, VENDOR_SHORT, reportPdfDoc, reportToPlaceholder } from './sanStorageText.js';

const HEAVY_TIMEOUT_MS = 90_000;
const NONE_DC = '__none__';   // 서버 routes/api/sanSwitch.js NONE_DC 와 같은 토큰(법인 미지정)

export default function SanStorageCheck({ dc, setDc, onOpen, isAdmin }) {
  const [got, setGot] = useState(null);
  const [err, setErr] = useState(null);
  const [seq, setSeq] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);   // v2.953 알림(§12.2-6)
  const [reportOpen, setReportOpen] = useState(false);   // v2.953 월간 보고서(§12.2-8)
  const [historyOpen, setHistoryOpen] = useState(false); // v2.955 점검 결과 이력(설계 §8.1)
  useEffect(() => {
    const ac = new AbortController();
    setGot(null); setErr(null);
    fetchJson('/tools/san-storage/check', dc ? { datacenterId: dc } : {}, ac.signal, { timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setGot(d); })
      .catch((e) => { if (!ac.signal.aborted) setErr(e); });
    return () => ac.abort();
  }, [dc, seq]);
  if (err) return <ErrorBox error={err.message} />;
  if (!got) return <Loading label="저장된 표본으로 판정하는 중입니다(새 접속 없음)." />;
  const s = got.summary || {};
  const items = got.items || [];
  const v = got.settings?.values || {};
  const userSet = new Set(got.settings?.userSet || []);
  return (
    <>
      <div className="sst-row">
        <div className="sst-filters">
          <span className="sst-pill">어레이 <b>{s.arrays ?? 0}</b></span>
          <span className="sst-pill"><span className="sst-st ok">●</span> 정상 <b>{s.ok ?? 0}</b>{s.partiallyUnchecked ? <span className="faint">(일부 미확인 {s.partiallyUnchecked})</span> : null}</span>
          <span className="sst-pill"><span className="sst-st warn">▲</span> 주의 <b>{s.warn ?? 0}</b></span>
          <span className="sst-pill"><span className="sst-st bad">✕</span> 이상 <b>{s.bad ?? 0}</b></span>
          <span className="sst-pill"><span className="sst-st unk">?</span> 확인 불가 <b>{s.unknown ?? 0}</b></span>
          <span className="sst-pill">판정 {dateClockText(got.judgedAt)} · 스위치 측 24시간 평균{userSet.size ? ` · 사용자 설정 ${userSet.size}` : ' · 기본 기준'}</span>
          <span className="sst-pill" title="시리얼로 짝 지은 스토리지 장비의 5분 표본에서 어레이 측 항목(busy · 응답 · 큐 · CPU · 보고 대조)을 읽은 어레이 수 — 나머지는 '확인 불가'(사유는 칸의 도움말)"><b>어레이 측 값</b> {(got.results || []).filter((r) => r.arraySide?.keys?.length).length} / {(got.results || []).length}</span>
        </div>
        <div className="sst-acts">
          <Select className="sst-inp" value={dc} onChange={(e) => setDc(e.target.value)} aria-label="법인" style={{ fontFamily: 'inherit' }}>
            <option value="">전체 법인</option>
            {(got.allDatacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          {isAdmin && <button type="button" className="sst-btn" onClick={() => setSettingsOpen(true)}>기준(임계값) 설정</button>}
          <button type="button" className="sst-btn" onClick={() => setNotifyOpen(true)} title="상태가 바뀐 순간만 · 법인 단위 · 알림 채널(설정 › 알림)">알림</button>
          <button type="button" className="sst-btn" onClick={() => setReportOpen(true)} title="매달 정한 날 · 시각에 판정표 보고서(HTML)를 메일로">월간 보고서</button>
          <button type="button" className="sst-btn" onClick={() => setHistoryOpen(true)} title="판정이 바뀌었거나 1시간마다 적힌 최근 기록 · 상태 전이 비교">이력</button>
          <button type="button" className="sst-btn primary" onClick={() => setSeq((n) => n + 1)}>지금 판정</button>
        </div>
      </div>
      {/* 판정표(11열)는 한 줄 전체 폭 — 1440 에서 규칙 표와 나란히 두면 어레이 측 열이 가로 스크롤 밖으로 밀린다(v2.948 Chromium 판독). */}
      <div className="sst" style={{ gap: 14 }}>
        <div className="sst-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="sst-table-wrap">
            <STable minWidth={1040} className="sst-judge">
              <thead><tr><th>스토리지</th>{items.map((it) => <th key={it.k} className="c" title={`${it.label} — ${it.side === 'array' ? '어레이 측(다음 판 수집)' : '스위치 측'}`}>{it.label}</th>)}<th>종합 · 근거</th></tr></thead>
              <tbody>
                {(got.results || []).map((r) => (
                  <tr key={`${r.datacenterId}|${r.key}`} className="click" onClick={() => onOpen({ key: r.key, datacenterId: r.datacenterId })} title="상세 보기">
                    <td data-sort={r.name}><div className="sst-name">{r.name}</div><div className="sst-sub" title={`${r.vendorLabel} · ${r.datacenterName || ''}`}><span className={`sst-vend ${r.vendor || 'other'}`}>{VENDOR_SHORT[r.vendor] || r.vendorLabel}</span> {r.datacenterName}</div></td>
                    {items.map((it) => { const x = r.items?.[it.k]; const m = CHECK_MARK[x?.status] || CHECK_MARK.na; return <td key={it.k} className="c" data-sort={x?.status || 'na'} title={x?.text || ''}><span className={`sst-st ${m.cls}`}>{m.sym}</span></td>; })}
                    <td data-sort={r.overall} title={reasonText(r)}><span className={`sst-tag ${CHECK_MARK[r.overall]?.cls === 'unk' ? 'gray' : CHECK_MARK[r.overall]?.cls || 'gray'}`}>{overallText(r)}</span><div className="sst-sub" style={{ maxWidth: 220 }}>{reasonText(r)}</div></td>
                  </tr>
                ))}
                {!(got.results || []).length && <tr><td colSpan={items.length + 2}><div className="sst-empty"><b>판정할 어레이가 없습니다</b><span>현황 탭에 어레이가 보여야 판정합니다.</span></div></td></tr>}
              </tbody>
            </STable>
          </div>
          <div className="sst-foot" style={{ padding: '10px 18px', borderTop: '1px solid var(--border-soft)' }}>● 정상 · ▲ 주의 · ✕ 이상 · ? 확인 불가(값은 보이되 기준이 없거나 표본이 없음) · — 해당 없음(그 벤더 · 그 어레이에 없는 항목). 어레이 측 5항목(busy · 응답 · 큐 · CPU · 보고 대조)은 이 판에서 전부 '확인 불가' 입니다 — 수집기는 다음 판.</div>
        </div>
        <div className="sst-card">
          <h4>판정 규칙 — 기준의 출처가 항목마다 다릅니다</h4>
          <div className="sst-table-wrap">
            <STable className="sst-rule">
              <thead><tr><th>항목</th><th>규칙</th><th>기준 · 출처</th></tr></thead>
              <tbody>
                <tr><td><b>디렉터 편중</b></td><td>디렉터 평균 ≥ {rateText(got.imbalanceRule?.minBps)} 이고 한 디렉터가 평균의 {got.imbalanceRule?.ratio}배 이상 → 주의 · {got.imbalanceRule?.badRatio}배 이상(24시간 평균) → 이상</td><td>포트 사용량 탭 기존 상수</td></tr>
                <tr><td><b>팹 비대칭</b></td><td>두 팹 합 ≥ {rateText(got.fabricMinBps)} 일 때 한쪽이 전체의 {thresholdText(itemOf(got, 'asymMinSharePct'), v.asymMinSharePct)} 미만 → 주의 · 한쪽 0 → 이상</td><td>{srcOf(got, 'asymMinSharePct')}</td></tr>
                <tr><td><b>회선 포화</b></td><td>포트 피크 포화도 ≥ {thresholdText(itemOf(got, 'portSatWarnPct'), v.portSatWarnPct)} 주의 · ≥ {thresholdText(itemOf(got, 'portSatBadPct'), v.portSatBadPct)} 이상</td><td>{srcOf(got, 'portSatWarnPct')}</td></tr>
                <tr><td><b>디렉터 busy</b></td><td>PercentBusy ≥ 주의 {thresholdText(itemOf(got, 'dirBusyWarnPct'), v.dirBusyWarnPct)} · 이상 {thresholdText(itemOf(got, 'dirBusyBadPct'), v.dirBusyBadPct)}</td><td>{srcOf(got, 'dirBusyBadPct')}</td></tr>
                <tr><td><b>응답 시간</b></td><td>읽기/쓰기 응답 ≥ 주의 {thresholdText(itemOf(got, 'respWarnMs'), v.respWarnMs)} · 이상 {thresholdText(itemOf(got, 'respBadMs'), v.respBadMs)}</td><td>{srcOf(got, 'respBadMs')}</td></tr>
                <tr><td><b>큐 깊이</b></td><td>QueueDepthUtilization ≥ 이상 {thresholdText(itemOf(got, 'queueBadPct'), v.queueBadPct)}(PowerMax)</td><td>{srcOf(got, 'queueBadPct')}</td></tr>
                <tr><td><b>노드 · SP CPU</b></td><td>Unity SP 주의 {thresholdText(itemOf(got, 'unityCpuWarnPct'), v.unityCpuWarnPct)} · 이상 {thresholdText(itemOf(got, 'unityCpuBadPct'), v.unityCpuBadPct)} / PowerStore 노드 주의 {thresholdText(itemOf(got, 'pstoreCpuWarnPct'), v.pstoreCpuWarnPct)} · 이상 {thresholdText(itemOf(got, 'pstoreCpuBadPct'), v.pstoreCpuBadPct)}</td><td>{srcOf(got, 'unityCpuWarnPct')} · {srcOf(got, 'pstoreCpuWarnPct')}</td></tr>
                <tr><td><b>보고 대조</b></td><td>어레이 보고 대역폭과 스위치 처리량 차이 ≥ {thresholdText(itemOf(got, 'compareDiffPct'), v.compareDiffPct)} → 주의(원인 단정 없음)</td><td>{srcOf(got, 'compareDiffPct')}</td></tr>
                <tr><td><b>수집 상태</b></td><td>정상 / 표본 지연(주의) / 엣지 미보고 · 표본 없음 · 부분 합만(확인 불가)</td><td>perfDiag · storageList 상태 코드</td></tr>
              </tbody>
            </STable>
          </div>
          <div className="sst-info">임계값을 지어내지 않습니다 — 기본값은 벤더 문서에서 찾은 값만 넣었고(출처 열) 못 찾은 항목은 비워 '?' 로 둡니다. 바꾼 값은 '사용자 설정' 으로 표시됩니다. 확인 불가 → 정상은 '호전' 이 아니라 '처음 확인' 입니다.</div>
        </div>
      </div>
      {settingsOpen && <SettingsModal initial={got.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setSeq((n) => n + 1); }} />}
      {notifyOpen && <NotifyModal isAdmin={isAdmin} items={got.items || []} onClose={() => setNotifyOpen(false)} />}
      {reportOpen && <ReportModal isAdmin={isAdmin} onClose={() => setReportOpen(false)} />}
      {historyOpen && <HistoryModal dc={dc} onOpen={onOpen} onClose={() => setHistoryOpen(false)} />}
    </>
  );
}
const itemOf = (got, k) => (got.settings?.items || []).find((x) => x.k === k);
const srcOf = (got, k) => itemOf(got, k)?.source || '—';
function reasonText(r) {
  const bad = Object.entries(r.items || {}).filter(([, x]) => x.status === 'bad').map(([k, x]) => `${labelOf(k)} ${x.text}`);
  const warn = Object.entries(r.items || {}).filter(([, x]) => x.status === 'warn').map(([k, x]) => `${labelOf(k)} ${x.text}`);
  const txt = [...bad, ...warn].slice(0, 3).join(' · ');
  return txt || (r.uncheckedCount ? `확인 불가 ${r.uncheckedCount}항목` : '');
}
const LABELS = { imbalance: '편중', fabric: '팹', portSat: '포화', dirBusy: 'busy', resp: '응답', queue: '큐', cpu: 'CPU', compare: '대조', collect: '수집' };
const labelOf = (k) => LABELS[k] || k;

/** 기준 설정(관리자) — null = 비움(판정 안 함) · 빈 칸 = 기본값으로. 주의 ≤ 이상은 서버가 검사한다(400 사유를 그대로 보인다). */
function SettingsModal({ initial, onClose, onSaved }) {
  const [vals, setVals] = useState(() => Object.fromEntries((initial?.items || []).map((it) => [it.k, initial?.values?.[it.k] ?? null])));
  const [blank, setBlank] = useState(() => new Set((initial?.items || []).filter((it) => (initial?.values?.[it.k] ?? null) === null).map((it) => it.k)));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    const body = {};
    for (const it of initial.items) body[it.k] = blank.has(it.k) ? null : (vals[it.k] === '' || vals[it.k] == null ? undefined : Number(vals[it.k]));
    try {
      const r = await putJson('/tools/san-storage/check-settings', { values: body });
      if (r?.ok === false) { setErr(r.reason || '저장하지 못했습니다'); return; }
      onSaved();
    }
    catch (e) { setErr(e.message || '저장 실패'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="성능 점검 기준(임계값)" onClose={onClose} width={860}>
      <div className="sst" style={{ gap: 10 }}>
        <div className="sst-note">값을 지우고 '비움' 을 켜면 그 항목은 판정하지 않습니다(값만 표시 · '?'). 빈 칸으로 저장하면 기본값으로 돌아갑니다. 기본값은 벤더 문서 값(출처)이고 못 찾은 항목은 처음부터 비어 있습니다.</div>
        <div className="sst-table-wrap">
          <STable>
            <thead><tr><th>항목</th><th>값</th><th>비움</th><th>기본값</th><th>출처</th></tr></thead>
            <tbody>
              {(initial?.items || []).map((it) => (
                <tr key={it.k}>
                  <td style={{ whiteSpace: 'normal' }}>{it.label}</td>
                  <td><div className="sst-valrow"><input className="sst-inp" type="number" step={it.unit === 'ms' ? 0.1 : 1} min={it.min} max={it.max} disabled={blank.has(it.k)} value={blank.has(it.k) ? '' : (vals[it.k] ?? '')} onChange={(e) => setVals((p) => ({ ...p, [it.k]: e.target.value }))} aria-label={it.label} /> <span className="faint">{it.unit}</span>
                    {it.min != null && it.max != null ? <input type="range" className="sst-range" min={it.min} max={it.max} step={it.unit === 'ms' ? 0.1 : 1} disabled={blank.has(it.k)} value={blank.has(it.k) || vals[it.k] === '' || vals[it.k] == null ? Number(it.def ?? it.min) : Number(vals[it.k])} onChange={(e) => setVals((p) => ({ ...p, [it.k]: e.target.value }))} aria-label={`${it.label} 슬라이더`} title={`${it.min}~${it.max}${it.unit} — 숫자 칸과 같은 값`} /> : null}
                  </div></td>
                  <td><label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={blank.has(it.k)} onChange={(e) => setBlank((p) => { const n = new Set(p); e.target.checked ? n.add(it.k) : n.delete(it.k); return n; })} /> 판정 안 함</label></td>
                  <td className="mono">{it.def == null ? '비움' : `${it.def}${it.unit}`}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 11.5 }} className="muted">{it.source}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {err && <div className="sst-info">{err}</div>}
        <div className="sst-acts" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="sst-btn" onClick={onClose}>닫기</button>
          <button type="button" className="sst-btn primary" disabled={busy} onClick={save}>저장</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── v2.953 알림(§12.2-6) — 상태가 바뀐 순간만 · 법인 단위 · 채널은 설정 › 알림(Slack · Teams · 웹훅 · 메일). 첫 실행은 기준만 잡는다. ── */
function NotifyModal({ isAdmin, items, onClose }) {
  const [got, setGot] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => fetchJson('/tools/san-storage/notify').then((d) => { setGot(d); setForm({ enabled: !!d.settings?.enabled, minLevel: d.settings?.minLevel || 'warn', recoveries: d.settings?.recoveries !== false }); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await putJson('/tools/san-storage/notify-settings', form); if (r?.ok === false) { setErr(r.reason || '저장하지 못했습니다'); return; } setMsg('저장했습니다 — 다음 틱부터 적용됩니다.'); await load(); }
    catch (e) { setErr(e.message || '저장 실패'); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await postJson('/tools/san-storage/notify/run-now', {}); setMsg(r.action === 'baseline' ? '첫 실행 — 지금 상태를 기준으로만 잡았습니다(다음 변화부터 알립니다).' : r.action === 'sent' ? `알림 ${r.alerts}건(법인) 보냈습니다 — 열림 ${r.opened} · 회복 ${r.recovered}` : r.action === 'quiet' ? '바뀐 상태가 없어 보내지 않았습니다.' : `${r.action}${r.error ? ` — ${r.error}` : ''}`); await load(); }
    catch (e) { setErr(e.message || '실행 실패'); } finally { setBusy(false); }
  };
  const st = got?.status || {};
  const labelOf = (k) => (items.find((i) => i.k === k) || {}).label || k;
  return (
    <Modal title="SAN 스토리지 성능 알림" onClose={onClose} width={760}>
      <div className="sst" style={{ gap: 10 }}>
        <div className="sst-note">판정(현황 · 점검과 같은 함수)을 포트 사용량 수집 주기(하한 5분)마다 돌려 <b>상태가 바뀐 순간만</b> 법인 단위로 알립니다(정상 → 주의 · 주의 → 이상 · 회복 · 수집 상태의 보고 끊김). 확인 불가(값 없음)는 올리지도 내리지도 않습니다. 채널 · 수신자는 설정 › 알림의 알림 규칙과 같습니다. 엣지는 보내지 않습니다.</div>
        {err && <div className="sst-info">{err}</div>}
        {!got ? <Loading label="알림 설정" /> : (
          <>
            <div className="sst-acts" style={{ flexWrap: 'wrap', gap: 14 }}>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" disabled={!isAdmin} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 알림 켬</label>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>최소 수준
                <Select className="sst-inp" disabled={!isAdmin} value={form.minLevel} onChange={(e) => setForm({ ...form, minLevel: e.target.value })} aria-label="최소 수준" style={{ fontFamily: 'inherit' }}>
                  <option value="warn">주의부터</option><option value="bad">이상만</option>
                </Select></label>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" disabled={!isAdmin} checked={form.recoveries} onChange={(e) => setForm({ ...form, recoveries: e.target.checked })} /> 회복도 알림</label>
            </div>
            <div className="sst-hist">
              <span>마지막 틱</span><b>{st.lastTick?.at ? `${dateClockText(st.lastTick.at)} · 어레이 ${st.lastTick.arrays} · 열림 ${st.lastTick.opened} · 회복 ${st.lastTick.recovered} · 알림 ${st.lastTick.alerts}${st.lastTick.first ? ' · 기준만' : ''}` : '아직 없음'}</b>
              <span>기준 어레이</span><b>{got.arraysTracked ?? 0}대{st.baselineAt ? ` · ${dateClockText(st.baselineAt)}` : ''}</b>
              <span>주기</span><b>{st.intervalMs ? `${Math.round(st.intervalMs / 60_000)}분` : '—'}{st.edge ? ' · 엣지(보내지 않음)' : ''}</b>
              <span>감시 항목</span><b>{(got.settings?.items || items.map((i) => i.k)).map(labelOf).join(' · ')}</b>
            </div>
            {(st.history || []).length ? (
              <div className="sst-table-wrap"><STable minWidth={520}>
                <thead><tr><th>시각</th><th>법인</th><th>심각도</th><th>내용</th><th>결과</th></tr></thead>
                <tbody>{st.history.slice(0, 10).map((h, i) => <tr key={i}><td className="mono" data-sort={h.at}>{dateClockText(h.at)}</td><td>{h.dc || '—'}</td><td><span className={`sst-tag ${h.severity === 'critical' ? 'crit' : h.severity === 'warning' ? 'warn' : 'ok'}`}>{h.severity}</span></td><td style={{ whiteSpace: 'normal', fontSize: 12 }}>{h.title}</td><td className="muted" style={{ fontSize: 11.5 }}>{h.result}</td></tr>)}</tbody>
              </STable></div>
            ) : <div className="sst-note">보낸 기록이 없습니다.</div>}
            {msg && <div className="sst-info">{msg}</div>}
            <div className="sst-acts" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="sst-btn" onClick={onClose}>닫기</button>
              {isAdmin && <button type="button" className="sst-btn" disabled={busy} onClick={runNow} title="설정이 꺼져 있어도 1회 판정해 변화를 보냅니다(첫 실행은 기준만)">지금 판정해 보내기</button>}
              {isAdmin && <button type="button" className="sst-btn primary" disabled={busy} onClick={save}>저장</button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── v2.953 월간 보고서(§12.2-8) — 자급형 HTML(브라우저에서 PDF 저장). PDF 직접 생성은 한글 글꼴 동봉이 필요해 이번 판은 아니다(정직 기록). ── */
function ReportModal({ isAdmin, onClose }) {
  const [got, setGot] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => fetchJson('/tools/san-storage/report').then((d) => { setGot(d); const s = d.settings || {}; setForm({ enabled: !!s.enabled, dayOfMonth: s.dayOfMonth ?? 1, time: s.time || '09:00', to: (s.to || []).join(', '), topN: s.topN ?? 10 }); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await putJson('/tools/san-storage/report-settings', { ...form, to: form.to }); if (r?.ok === false) { setErr(r.reason || '저장하지 못했습니다'); return; } setMsg('저장했습니다.'); await load(); }
    catch (e) { setErr(e.message || '저장 실패'); } finally { setBusy(false); }
  };
  const sendNow = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await postJson('/tools/san-storage/report/send-now', {}); setMsg(r.ok ? `보냈습니다 — 받는 사람 ${r.to}명 · 어레이 ${r.arrays}대` : `보내지 않았습니다(${r.state}) — ${r.reason || ''}`); await load(); }
    catch (e) { setErr(e.message || '발송 실패'); } finally { setBusy(false); }
  };
  const preview = () => { downloadFile('/tools/san-storage/report/preview', `san-storage-report_preview.html`); };
  // v2.955 PDF 는 화면에서 — jsPDF + 임베드 한글 글꼴(reportExport.saveDocAsPdf · 클릭 때 동적 import). 서버 메일 첨부는 HTML 그대로(서버에는 PDF 생성기가 없다 — 정직 기록).
  const savePdf = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const d = await fetchJson('/tools/san-storage/report/preview', { format: 'json' });
      const { saveDocAsPdf } = await import('./reportExport.js');
      const r = await saveDocAsPdf(reportPdfDoc(d.model), String(d.parts?.filename || 'san-storage-report.html').replace(/\.html$/i, '.pdf'));
      setMsg(`PDF 를 만들었습니다 — ${r.pages}쪽(벡터 · 임베드 한글 글꼴)`);
    } catch (e) { setErr(e.message || 'PDF 생성 실패'); } finally { setBusy(false); }
  };
  return (
    <Modal title="월간 성능 점검 보고서" onClose={onClose} width={760}>
      <div className="sst" style={{ gap: 10 }}>
        <div className="sst-note">매달 정한 날 · 시각(포탈 시각)에 판정표 · 주의/이상 항목 · 상위 어레이 처리량 · 기준 표를 <b>자급형 HTML</b> 로 만들어 메일(설정 › 알림·메일 · 종류 'SAN 스토리지 성능 월간 보고서')에 첨부합니다. 메일 첨부는 HTML 이고, <b>PDF 로 저장</b> 은 이 화면에서 임베드 한글 글꼴로 벡터 PDF 를 만듭니다(서버에는 PDF 생성기가 없어 메일에는 붙이지 않습니다). 놓친 회차는 몰아서 보내지 않습니다.</div>
        {err && <div className="sst-info">{err}</div>}
        {!got || !form ? <Loading label="보고서 설정" /> : (
          <>
            <div className="sst-acts" style={{ flexWrap: 'wrap', gap: 14 }}>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" disabled={!isAdmin} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 정기 발송 켬</label>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>매달 <input className="sst-inp" type="number" min={1} max={28} disabled={!isAdmin} value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })} style={{ width: 64 }} aria-label="날" />일</label>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input className="sst-inp" type="time" disabled={!isAdmin} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} aria-label="시각" /></label>
              <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>상위 <input className="sst-inp" type="number" min={1} max={50} disabled={!isAdmin} value={form.topN} onChange={(e) => setForm({ ...form, topN: e.target.value })} style={{ width: 64 }} aria-label="상위 N" />대</label>
            </div>
            <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>받는 사람(쉼표 · 비우면 설정 › 알림·메일의 기본 수신자)
              <input className="sst-inp" type="text" disabled={!isAdmin} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder={reportToPlaceholder(got.settings)} style={{ fontFamily: 'inherit', width: '100%' }} aria-label="받는 사람" /></label>
            <div className="sst-hist">
              <span>다음 회차</span><b>{got.nextSlot ? dateClockText(got.nextSlot) : (form.enabled ? '—' : '꺼짐')}</b>
              <span>마지막 발송</span><b>{got.lastSentAt ? dateClockText(got.lastSentAt) : '없음'}</b>
              <span>마지막 틱</span><b>{got.lastTick?.at ? `${dateClockText(got.lastTick.at)} · ${got.lastTick.action}` : '—'}{got.edge ? ' · 엣지(보내지 않음)' : ''}</b>
            </div>
            {(got.history || []).length ? (
              <div className="sst-table-wrap"><STable minWidth={480}>
                <thead><tr><th>시각</th><th>종류</th><th>상태</th><th>내용</th></tr></thead>
                <tbody>{got.history.slice(0, 10).map((h, i) => <tr key={i}><td className="mono" data-sort={h.at}>{dateClockText(h.at)}</td><td>{h.kind === 'manual' ? '수동' : '정기'}</td><td><span className={`sst-tag ${h.state === 'sent' ? 'ok' : h.state === 'failed' ? 'crit' : 'gray'}`}>{h.state}</span></td><td style={{ whiteSpace: 'normal', fontSize: 12 }}>{h.state === 'sent' ? `${h.month || ''} · 받는 사람 ${h.to} · 어레이 ${h.arrays}` : (h.reason || h.code || '')}</td></tr>)}</tbody>
              </STable></div>
            ) : <div className="sst-note">보낸 기록이 없습니다.</div>}
            {msg && <div className="sst-info">{msg}</div>}
            <div className="sst-acts" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="sst-btn" onClick={onClose}>닫기</button>
              <button type="button" className="sst-btn" disabled={busy} onClick={preview} title="지금 값으로 만든 보고서 HTML 을 내려받습니다(보내지 않음)">미리보기(HTML)</button>
              <button type="button" className="sst-btn" disabled={busy} onClick={savePdf} title="지금 값으로 벡터 PDF(임베드 한글 글꼴)를 브라우저에서 만들어 내려받습니다 — 메일 첨부는 HTML 입니다">PDF 로 저장</button>
              {isAdmin && <button type="button" className="sst-btn" disabled={busy} onClick={sendNow}>지금 보내기</button>}
              {isAdmin && <button type="button" className="sst-btn primary" disabled={busy} onClick={save}>저장</button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── v2.955 점검 결과 이력(설계 §8.1 '점검 이력') — 서버 storageCheckHistory(SAN 점검 이력과 같은 규약). 판정이 바뀌었거나 1시간마다 한 건 · 어레이당 최근 N건 ·
   비교는 상태 전이(악화 · 호전 · 이제 확인됨 · 확인 불가로)로 말한다 — unknown 을 ok 로 흡수하지 않는다. DB 를 못 열면 available:false 를 그대로 보인다(빈 표로 숨기지 않음). ── */
const DIR_KO = Object.freeze({ worse: '악화', better: '호전', nowKnown: '이제 확인됨', nowUnknown: '확인 불가로' });
function HistoryModal({ dc, onOpen, onClose }) {
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('');
  const [det, setDet] = useState(null);
  const [detErr, setDetErr] = useState(null);
  useEffect(() => {
    let live = true;
    fetchJson('/tools/san-storage/check/history', { days: 7 }).then((d) => { if (live) setOv(d); }).catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!sel) { setDet(null); return undefined; }
    const i = sel.indexOf('|'); const key = sel.slice(i + 1); const dcId = sel.slice(0, i);
    let live = true; setDet(null); setDetErr(null);
    fetchJson('/tools/san-storage/check/history', { key, datacenterId: dcId || NONE_DC, limit: 10 }).then((d) => { if (live) setDet(d); }).catch((e) => { if (live) setDetErr(e); });
    return () => { live = false; };
  }, [sel]);
  const arrays = (ov?.arrays || []).filter((a) => !dc || a.dc === dc);
  const changes = (ov?.changes || []).filter((c) => !dc || c.dc === dc);
  const mark = (st) => { const m = CHECK_MARK[st] || CHECK_MARK.unknown; return <span className={`sst-st ${m.cls}`} title={m.label}>{m.sym}</span>; };
  const gapMin = Math.round((ov?.minGapMs || 3_600_000) / 60_000);
  return (
    <Modal title="성능 점검 결과 이력" onClose={onClose} width={920}>
      <div className="sst-modal-body">
        {err ? <ErrorBox error={err} /> : !ov ? <Loading /> : (
          <>
            <div className="sst-note">판정이 <b>바뀌었을 때</b>와 마지막 기록에서 <b>{gapMin}분</b>이 지났을 때만 적습니다(알림 틱 · '지금 판정' — 5분마다 같은 값을 쌓지 않습니다). 어레이당 최근 {ov.maxRuns}건.
              비교는 상태 전이로 말합니다 — '확인 불가 → 정상' 은 호전이 아니라 <b>이제 확인됨</b>입니다.</div>
            {!ov.available && <div className="sst-info">이력 DB 를 열지 못했습니다{ov.db?.error ? ` — ${ov.db.error}` : ''}. 기록 · 비교는 DB 가 열릴 때까지 비활성입니다(빈 이력이 아닙니다).</div>}
            <h4 style={{ margin: '12px 0 6px' }}>최근 7일 변화 <span className="faint">{changes.length}건{dc ? ' · 고른 법인만' : ''}</span></h4>
            {changes.length ? (
              <div className="sst-table-wrap"><STable minWidth={640} limit={50}>
                <thead><tr><th>시각</th><th>법인</th><th>스토리지</th><th>항목</th><th>전이</th><th>방향</th></tr></thead>
                <tbody>{changes.map((c, i) => (
                  <tr key={`${c.arrayKey}|${c.dc}|${c.item}|${i}`}>
                    <td className="mono" data-sort={c.at}>{dateClockText(c.at)}</td><td>{c.dc || '(법인 미지정)'}</td>
                    <td><button type="button" className="sst-link" onClick={() => onOpen?.({ key: c.arrayKey, datacenterId: c.dc })}>{c.name || c.arrayKey}</button></td>
                    <td>{c.label}</td><td data-sort={`${c.from}>${c.to}`}>{mark(c.from)} → {mark(c.to)}</td>
                    <td data-sort={c.dir}><span className={`sst-tag ${c.dir === 'worse' ? 'bad' : c.dir === 'better' ? 'ok' : 'gray'}`}>{DIR_KO[c.dir] || c.dir}</span></td>
                  </tr>))}</tbody>
              </STable></div>
            ) : <div className="sst-note">{ov.available ? (arrays.length ? '최근 7일에 판정이 바뀐 어레이가 없습니다.' : '아직 기록이 없습니다 — 알림 틱(수집 주기 · 하한 5분)이나 \'지금 판정\' 뒤에 쌓입니다.') : '—'}</div>}
            <h4 style={{ margin: '14px 0 6px' }}>어레이별 최근 기록</h4>
            <div className="sst-acts" style={{ marginBottom: 8 }}>
              <Select className="sst-inp" value={sel} onChange={(e) => setSel(e.target.value)} aria-label="어레이" style={{ fontFamily: 'inherit', minWidth: 260 }}>
                <option value="">어레이 선택 ({arrays.length}대 기록됨)</option>
                {arrays.map((a) => <option key={`${a.dc}|${a.key}`} value={`${a.dc}|${a.key}`}>{a.name || a.key} · {a.dc || '(법인 미지정)'} · {a.runs}건</option>)}
              </Select>
            </div>
            {detErr ? <ErrorBox error={detErr} /> : sel && !det ? <Loading /> : det ? (
              <>
                <div className="sst-hist">
                  <span>비교</span><b>{det.compare?.note || `최근 ${det.compare?.compared ?? 0}회 · 새 문제 ${det.compare?.newProblems?.length ?? 0} · 해소 ${det.compare?.resolved?.length ?? 0}`}</b>
                  <span>마지막 변화</span><b>{det.lastChange ? `${dateClockText(det.lastChange.at)} — ${det.lastChange.changes.map((c) => `${c.label} ${(CHECK_MARK[c.from] || {}).label || c.from} → ${(CHECK_MARK[c.to] || {}).label || c.to}`).join(' · ')}` : '기록 안에 변화 없음'}</b>
                  {(det.compare?.persistent || []).length ? <><span>계속 문제</span><b>{det.compare.persistent.map((p) => `${p.label}(${p.runs}회)`).join(' · ')}</b></> : null}
                </div>
                <div className="sst-table-wrap"><STable minWidth={560}>
                  <thead><tr><th>시각</th><th>종합</th><th className="c">정상</th><th className="c">주의</th><th className="c">이상</th><th className="c">확인 불가</th><th>어레이 측 값</th></tr></thead>
                  <tbody>{(det.runs || []).map((r) => (
                    <tr key={r.id}>
                      <td className="mono" data-sort={r.at}>{dateClockText(r.at)}</td>
                      <td data-sort={r.overall}><span className={`sst-tag ${CHECK_MARK[r.overall]?.cls === 'unk' ? 'gray' : CHECK_MARK[r.overall]?.cls || 'gray'}`}>{CHECK_MARK[r.overall]?.label || r.overall}</span></td>
                      <td className="c" data-sort={r.counts.ok}>{r.counts.ok}</td><td className="c" data-sort={r.counts.warn}>{r.counts.warn}</td>
                      <td className="c" data-sort={r.counts.bad}>{r.counts.bad}</td><td className="c" data-sort={r.counts.unknown}>{r.counts.unknown}</td>
                      <td data-sort={(r.arraySide?.keys || []).length}>{(r.arraySide?.keys || []).length ? `${r.arraySide.keys.length}항목` : '—'}</td>
                    </tr>))}</tbody>
                </STable></div>
              </>
            ) : null}
          </>
        )}
        <div className="sst-acts" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="sst-btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </Modal>
  );
}
