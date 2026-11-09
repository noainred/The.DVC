// v2.948 — SAN 스토리지 성능 › 성능 점검 탭(설계 ⑥). 판정은 서버 storagePerfCheck(순수 · 저장 표본만 — 새 접속 없음) · 여기는 표와 기준 설정만.
//   상태 4종 + 해당 없음: 정상 · 주의 · 이상 · **확인 불가**(unknown 을 정상으로 뭉개지 않는다 — '정상(일부 미확인)'). 기준 기본값은 벤더 문서 값만(출처 열) · 못 찾은 것은 비움.
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { CHECK_MARK, overallText, thresholdText, rateText, dateClockText, VENDOR_SHORT } from './sanStorageText.js';

const HEAVY_TIMEOUT_MS = 90_000;

export default function SanStorageCheck({ dc, setDc, onOpen, isAdmin }) {
  const [got, setGot] = useState(null);
  const [err, setErr] = useState(null);
  const [seq, setSeq] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
