import React, { useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { requireChanged } from '../changeResult.js';
import { corpPlan, pickedPlan } from './easyRegister.js';
import TrialModal from './TrialModal.jsx';

/**
 * Monitoring 개요 — **감시 범위** 카드 + 법인별 추천 등록(v2.960 쉬운 등록 B·C · 시안 ⑩ ⑪).
 *
 * 수치는 서버 `/overview` 의 `coverage`(설정 연동 마지막 감지 값 — 관리자(전체 범위)에게만 실린다). 화면도 같은 판정(svcmonAccess)으로만 그린다.
 * 법인 목록은 펼칠 때 한 번 설정 연동 카탈로그(`/settings-sync/catalog` — adminOnly + fullScopeOnly)를 읽는다(폴링 없음).
 * 등록은 기존 설정 연동 적용 라우트 하나(서버가 **지금** 다시 분류한 행으로 판정) → 고른 방식대로 시험 점검 · 바로 사용 · 중지로 둔다.
 */
const MODES = [
  { k: 'trial', label: '시험 점검 후 사용', tag: '권장' },
  { k: 'stop', label: '중지로 등록' },
  { k: 'enable', label: '바로 사용' },
];

const GO_LABEL = { trial: '시험 점검 후 등록', stop: '중지로 등록', enable: '등록하고 바로 사용' };

export default function CoverageCard({ cov, onChanged }) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [excluded, setExcluded] = useState(() => new Set());
  const [expand, setExpand] = useState(() => new Set());
  const [mode, setMode] = useState('trial');
  const [corpEdge, setCorpEdge] = useState(true);
  const [job, setJob] = useState(null);
  const [msg, setMsg] = useState('');

  const groups = useMemo(() => (cat ? corpPlan(cat.rows || []) : []), [cat]);
  const plan = useMemo(() => pickedPlan(groups, picked, excluded), [groups, picked, excluded]);
  const maxApply = cat?.limits?.maxApply || 0;
  // '중지로 등록' 은 미등록만 등록한다(이미 등록됐지만 중지인 것은 그대로) — 버튼 수가 실제로 바뀌는 건수와 같아야 한다.
  const goCount = mode === 'stop' ? plan.newN : plan.newN + plan.offN;

  const loadCatalog = async () => {
    setBusy(true); setErr('');
    try { setCat(await fetchJson('/svcmon/settings-sync/catalog')); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const toggleOpen = () => { const n = !open; setOpen(n); if (n && !cat) loadCatalog(); };
  const flip = (setter, key) => setter((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const register = async () => {
    if (!goCount) return;
    if (maxApply && plan.newN > maxApply) { setErr(`한 번에 ${maxApply}건까지 등록할 수 있습니다(고른 미등록 ${plan.newN}건) — 법인을 나눠 고르세요.`); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      const ids = [...plan.offIds];
      let added = 0;
      if (plan.newN) {
        const r = await postJson('/svcmon/settings-sync/apply', { keys: plan.keys, enabled: mode === 'enable', withChecks: true, syncAssign: true, corpEdge, goneAction: 'disable' });
        const res = r?.result || {};
        if (!res.committed) {
          const why = (res.addErrors || []).slice(0, 3).map((e) => `${e.name || e.row || ''} ${e.reason || ''}`.trim()).join(' · ');
          throw new Error(`등록하지 못했습니다(전부 취소) — ${why || r?.error || '사유 미상'}`);
        }
        added = res.added || 0;
        ids.push(...(res.addedIds || []));
        const failedAssign = (r.assign || []).filter((a) => !a.ok);
        if (failedAssign.length) setMsg(`엣지 배정 동기화 건너뜀 · 실패 ${failedAssign.length} — ${failedAssign.map((a) => `${a.agent}: ${a.reason}`).join(' · ').slice(0, 300)}`);
      }
      if (mode === 'trial' && ids.length) {
        const t = requireChanged(await postJson('/svcmon/trial', { ids }));
        setJob(t.job);
      } else if (mode === 'enable' && plan.offIds.length) {
        requireChanged(await postJson('/svcmon/targets/enabled', { targets: plan.offIds, enabled: true }));
      }
      if (mode !== 'trial') setMsg((m) => `${m ? `${m} · ` : ''}새로 등록 ${added}건${mode === 'enable' ? ` · 사용으로 켬 ${plan.offIds.length}건` : ' · 중지 상태로 두었습니다'}`);
      setPicked(new Set()); setExcluded(new Set());
      await loadCatalog();
      onChanged?.();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  const c = cov || {};
  const total = c.configured || 0;
  const pct = (n) => (total ? `${Math.max(n ? 0.6 : 0, (n / total) * 100)}%` : '0%');
  const unmon = (c.stopped || 0) + (c.unregistered || 0);
  const at = c.at ? new Date(c.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

  return (
    <div className="tv-w tv-cov">
      <div className="tv-wh">감시 범위 · 설정된 시스템 대비<em>{`설정 연동 감지${at ? ` ${at}` : ''} · 관리자(전체 범위)에게만 보입니다`}</em></div>
      {!cov ? (
        <div className="tv-empty">설정 연동 감지가 아직 돌지 않았습니다 — 기동 뒤 첫 감지가 끝나면 보입니다.</div>
      ) : (
        <div className="tv-cov-top">
          <div style={{ minWidth: 0 }}>
            <div className="tv-cov-nums">
              <div><span>설정된 시스템</span><b>{total.toLocaleString()}</b></div>
              <i aria-hidden="true">=</i>
              <div><span>감시 중</span><b className="ok">{(c.monitored || 0).toLocaleString()}</b></div>
              <i aria-hidden="true">+</i>
              <div><span>등록됐지만 중지</span><b className="off">{(c.stopped || 0).toLocaleString()}</b></div>
              <i aria-hidden="true">+</i>
              <div><span>미등록</span><b className="warn">{(c.unregistered || 0).toLocaleString()}</b></div>
              {(c.excluded || c.problem) ? <small>{[c.excluded ? `제외 ${c.excluded}(웹훅 · 외부 주소 등 등록하지 않는 종류)` : '', c.problem ? `설정 문제 ${c.problem}` : ''].filter(Boolean).join(' · ')}</small> : null}
            </div>
            <div className="tv-cov-bar" role="img" aria-label={`설정된 시스템 ${total} 가운데 감시 중 ${c.monitored || 0}, 중지 ${c.stopped || 0}, 미등록 ${c.unregistered || 0}`}>
              <i className="ok" style={{ width: pct(c.monitored || 0) }} /><i className="off" style={{ width: pct(c.stopped || 0) }} /><i className="warn" style={{ flex: 1 }} />
            </div>
          </div>
          <div className="tv-cov-cta">
            <span>{unmon ? <>미감시 <b>{unmon.toLocaleString()}</b>건 — 법인 단위로 한 번에 등록할 수 있습니다.</> : '설정된 시스템을 모두 감시하고 있습니다.'}</span>
            <span className="tv-cov-btns">
              <button type="button" className="pc-btn accent" aria-expanded={open} onClick={toggleOpen}>{open ? '법인별 추천 등록 접기' : '법인별 추천 등록'}</button>
              <a className="pc-btn" style={{ textDecoration: 'none' }} href="#/tools/svcmon-config/sync">설정 연동에서 직접 고르기</a>
            </span>
          </div>
        </div>
      )}

      {open && (
        <div className="tv-corp">
          <div className="tv-corp-head">
            <span>법인을 고르면 그 법인의 설정된 시스템을 한 번에 등록합니다. 자격증명 없이 재는 종류별 기본 점검만 넣습니다.</span>
            <span className="tv-cov-btns">
              <button type="button" className="pc-chip" disabled={!groups.length} onClick={() => setPicked(new Set(groups.filter((g) => g.unmonitored).map((g) => g.key)))}>모두 선택</button>
              <button type="button" className="pc-chip" disabled={!groups.length} onClick={() => setPicked(new Set(groups.filter((g) => g.unmonitored && g.agent).map((g) => g.key)))}>엣지 있는 법인만</button>
              <button type="button" className="pc-chip" disabled={!picked.size} onClick={() => { setPicked(new Set()); setExcluded(new Set()); }}>선택 해제</button>
            </span>
          </div>
          {busy && !cat && <div className="tv-empty">설정 카탈로그를 읽는 중…</div>}
          {cat && !groups.length && <div className="tv-empty">등록할 설정 항목이 없습니다.</div>}
          {groups.length > 0 && (
            <div className="tv-corp-list" role="list">
              {groups.map((g) => {
                const on = picked.has(g.key);
                const ex = expand.has(g.key);
                return (
                  <div key={g.key || '_unknown'} role="listitem" className={`tv-corp-row${on ? ' on' : ''}`}>
                    <div className="tv-corp-main">
                      <input type="checkbox" checked={on} disabled={!g.unmonitored} aria-label={`${g.label} 선택`} onChange={() => flip(setPicked, g.key)} />
                      <button type="button" className="tv-corp-tog" aria-expanded={ex} aria-label={`${g.label} 종류 ${ex ? '접기' : '펼치기'}`} onClick={() => flip(setExpand, g.key)}>{ex ? '−' : '+'}</button>
                      <b className={`tv-corp-name${g.key ? '' : ' unknown'}`} title={g.label}>{g.label}</b>
                      <span className={`tv-corp-edge${g.agent ? '' : ' none'}`} title={g.agent ? '이 법인의 설정 항목을 그 엣지가 현지에서 잽니다(법인 엣지에 배정)' : '법인 담당 엣지를 정할 근거가 없습니다'}>
                        <i aria-hidden="true" />{g.agent || (g.key ? '엣지 없음 · 이 포탈이 직접' : '설정에 법인 정보가 없음')}
                      </span>
                      <span className="tv-corp-kinds">
                        {g.kinds.slice(0, 6).map((k) => <span key={k.kind} className={`tv-kd${k.newN + k.offN ? '' : ' done'}`} title={`${k.label} · 전체 ${k.n} · 미등록 ${k.newN} · 중지 ${k.offN}`}>{k.label} <b>{k.n}</b></span>)}
                        {g.kinds.length > 6 && <span className="tv-kd done">{`+${g.kinds.length - 6}`}</span>}
                      </span>
                      <span className="tv-corp-gap"><span className="mono">{g.unmonitored}<em>{` / ${g.total}`}</em></span>{g.problem ? <small>{`설정 문제 ${g.problem}`}</small> : null}</span>
                    </div>
                    {ex && (
                      <div className="tv-corp-sub">
                        {g.kinds.map((k) => {
                          const kk = `${g.key}|${k.kind}`;
                          return (
                            <label key={k.kind} className="tv-corp-kind">
                              <input type="checkbox" checked={on && !excluded.has(kk)} disabled={!on || !(k.newN + k.offN)} onChange={() => flip(setExcluded, kk)} />
                              <span className="l">{k.label}</span>
                              <span className="mono c">{k.n}</span>
                              <span className="mono ck" title={k.checks}>{k.checks || '—'}</span>
                              <span className="st">{[k.newN ? `미등록 ${k.newN}` : '', k.offN ? `등록됨 · 중지 ${k.offN} → 켜기` : '', !(k.newN + k.offN) ? '감시 중' : ''].filter(Boolean).join(' · ')}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {err && <div className="pc-err" style={{ margin: '8px 12px' }}>{err}</div>}
          {msg && <div className="tv-note" style={{ padding: '8px 12px 0' }}>{msg}</div>}
          <div className="tv-corp-foot">
            <span className="tv-corp-mode" role="radiogroup" aria-label="등록 방식">
              {MODES.map((m) => (
                <label key={m.k} className={`tv-rad${mode === m.k ? ' on' : ''}`}>
                  <input type="radio" name="tv-cov-mode" checked={mode === m.k} onChange={() => setMode(m.k)} />{m.label}{m.tag ? <em>{m.tag}</em> : null}
                </label>
              ))}
              <label className="tv-rad-chk"><input type="checkbox" checked={corpEdge} onChange={(e) => setCorpEdge(e.target.checked)} />법인 엣지에 배정</label>
            </span>
            <span className="tv-corp-go">
              <span className="mono">{`${plan.corps}개 법인 · 새로 등록 ${plan.newN} · 중지된 것 켜기 ${plan.offN}`}</span>
              <button type="button" className="pc-btn primary" disabled={busy || !goCount} onClick={register}>
                {busy ? '등록 중…' : `${GO_LABEL[mode]} · ${goCount}건`}
              </button>
            </span>
          </div>
        </div>
      )}
      {job && <TrialModal job={job} onClose={() => { setJob(null); onChanged?.(); }} />}
    </div>
  );
}
