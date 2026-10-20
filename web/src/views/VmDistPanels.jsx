/**
 * VmDistPanels.jsx — 가상머신 상세 C안(v2.746): 분포 4패널 · 선택 칩 줄 · 표 칸(전원 점·사용률 막대) · 좁은 화면 2줄 목록.
 *
 * 판정·문구는 전부 vmDistText.js(순수) — 여기는 그리기만 한다. 칸 번호와 개수는 서버(/vms?dist=1)가 센다.
 * 막대·머리 개수·전원 칸·GPU 칸·OS 줄은 전부 button(키보드·aria-pressed·aria-label·title).
 * GPU 클릭은 Vms 의 기존 gpuOnly·gpuType 상태(KPI GPU 카드와 같은 상태)로 간다 — 새 상태를 만들지 않는다.
 * 스타일은 vmDist.css(.vmd 아래만) — 색은 CSS 변수로만.
 */
import React, { useState, useEffect } from 'react';
import { WARN_PCT, CRIT_PCT } from '../console/consoleData.js';
import {
  barHeights, binColor, binButton, binAria, thresholdSel, thresholdCount, toggleBin, toggleSel,
  distNote, panelState, EMPTY_PANEL_TEXT, NO_DIST_TEXT, powerSegments, gpuSegments, gpuToggle, osRows, osFooter,
  usageView, powerDot, TONE_COLOR, TONE_TEXT, NARROW_QUERY, GPU_LABEL,
} from './vmDistText.js';
import './vmDist.css';

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const POWER_COLOR = { on: 'var(--green)', off: 'var(--vmd-off)', suspended: 'var(--amber)', other: 'var(--text-faint)' };
const GPU_COLOR = { vgpu: 'var(--purple)', passthrough: 'var(--accent-2)', mixed: 'var(--amber)' };

/** 좁은 화면 여부 — matchMedia 가 없거나 던지면 넓은 화면으로 본다(SSR·구형 브라우저). */
export function useNarrowScreen(query = NARROW_QUERY) {
  const read = () => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !!window.matchMedia(query).matches : false;
    } catch { return false; }
  };
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    let mq = null;
    try { mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null; } catch { mq = null; }
    if (!mq) return undefined;
    const on = () => setNarrow(!!mq.matches);
    on();
    try {
      mq.addEventListener('change', on);
      return () => { try { mq.removeEventListener('change', on); } catch { /* 무시 */ } };
    } catch {
      try { mq.addListener(on); return () => { try { mq.removeListener(on); } catch { /* 무시 */ } }; } catch { return undefined; }
    }
  }, [query]);
  return narrow;
}

/** CPU·메모리 사용률 분포 패널 — 5% 칸 20개. */
function UsagePanel({ title, what, panel, sel, onSel }) {
  const state = panelState(panel);
  const crit = thresholdSel('crit');
  const warn = thresholdSel('warn');
  const heights = state === 'ok' ? barHeights(panel.bins) : [];
  const na = panel && Number.isFinite(panel.na) ? panel.na : 0;
  return (
    <div className="vmd-panel">
      <div className="vmd-ph">
        <span className="vmd-pt">{title}</span>
        {state === 'ok' && (
          <span className="vmd-thr">
            <button type="button" className="vmd-thr-btn crit" aria-pressed={sel === crit}
              aria-label={`${what} 90% 이상 ${fmt(thresholdCount(panel, 'crit'))}대`}
              title={sel === crit ? '다시 누르면 해제' : `${what} 사용률 90% 이상인 VM 만 표에 남깁니다`}
              onClick={() => onSel(toggleSel(sel, crit))}>
              90%↑ <b>{fmt(thresholdCount(panel, 'crit'))}</b>
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" className="vmd-thr-btn warn" aria-pressed={sel === warn}
              aria-label={`${what} 75% 이상 ${fmt(thresholdCount(panel, 'warn'))}대`}
              title={sel === warn ? '다시 누르면 해제' : `${what} 사용률 75% 이상인 VM 만 표에 남깁니다`}
              onClick={() => onSel(toggleSel(sel, warn))}>
              75%↑ <b>{fmt(thresholdCount(panel, 'warn'))}</b>
            </button>
          </span>
        )}
      </div>
      {state === 'ok' ? (
        <>
          <div className="vmd-bars" role="group" aria-label={`${what} 사용률 분포 — 칸을 누르면 그 구간만`}>
            {heights.map((h, i) => {
              // 눌림·라벨·title 은 binButton 하나 — 구간(90%↑ 등) 안의 칸은 누르면 그 칸만 남으므로 '해제' 라 말하지 않는다(W-R3).
              const bb = binButton(what, i, h.n, sel);
              // 0 대인 칸은 누를 수 없다(고를 VM 이 없다) — 단 칸 하나만 고른 그 칸은 0 이 돼도 해제할 수 있게 버튼으로 남긴다.
              if (h.zero && !bb.pressed) return <span key={i} className={`vmd-bin zero${bb.on ? ' on' : ''}`} aria-hidden="true"><span className="vmd-bin-fill" /></span>;
              return (
                <button key={i} type="button" className={`vmd-bin${bb.on ? ' on' : ''}${h.zero ? ' zero' : ''}`} aria-pressed={bb.pressed}
                  aria-label={bb.label}
                  title={bb.title}
                  onClick={() => onSel(toggleBin(sel, i))}>
                  <span className="vmd-bin-fill" style={h.zero ? undefined : { height: `${h.h}%`, background: binColor(i, sel) }} />
                </button>
              );
            })}
            <span className="vmd-ref warn" aria-hidden="true" style={{ left: `${WARN_PCT}%` }} />
            <span className="vmd-ref crit" aria-hidden="true" style={{ left: `${CRIT_PCT}%` }} />
          </div>
          <div className="vmd-axis" aria-hidden="true">
            <span style={{ left: 0 }}>0</span>
            <span className="mid" style={{ left: '50%' }}>50</span>
            <span className="mid warn" style={{ left: `${WARN_PCT}%` }}>{WARN_PCT}</span>
            <span className="mid crit" style={{ left: `${CRIT_PCT}%` }}>{CRIT_PCT}</span>
            <span className="end">100%</span>
          </div>
        </>
      ) : (
        <div className="vmd-empty">{EMPTY_PANEL_TEXT[state]}</div>
      )}
      <div className="vmd-pf">
        <span className="vmd-note">{distNote(panel)}</span>
        {(na > 0 || sel === 'na') && (
          <button type="button" className="vmd-na" aria-pressed={sel === 'na'}
            aria-label={binAria(what, 'na', na)}
            title={sel === 'na' ? '다시 누르면 해제' : '구동 중이지만 사용률을 읽지 못한 VM 만 표에 남깁니다'}
            onClick={() => onSel(toggleBin(sel, 'na'))}>
            미수집 {fmt(na)}
          </button>
        )}
      </div>
    </div>
  );
}

/** 막대 칸(전원·GPU) — 마우스용. 키보드·화면판독은 아래 범례 버튼이 맡는다(같은 동작이 두 번 탭 순서에 서지 않게). */
function Seg({ w, color, on, title, onClick }) {
  return (
    <button type="button" tabIndex={-1} aria-hidden="true" className={`vmd-seg-i${on ? ' on' : ''}`}
      style={{ width: `${w}%`, background: color }} title={title} onClick={onClick} />
  );
}

/** 전원 · GPU 구성 패널. */
function PowerGpuPanel({ power, gpu, powerSel, onPower, gpuSel, onGpu }) {
  const ps = powerSegments(power, powerSel);
  const gs = gpuSegments(gpu, gpuSel);
  const pClick = (k) => onPower(toggleSel(powerSel, k));
  const gClick = (k) => onGpu(gpuToggle(gpuSel, k));
  return (
    <div className="vmd-panel vmd-mixp">
      <span className="vmd-pt">전원 · GPU 구성</span>
      <div className="vmd-mix">
        <div className="vmd-mix-h"><span>전원</span><span className="vmd-mono">{fmt(ps.total)}</span></div>
        {ps.total > 0 ? (
          <div className="vmd-seg">
            {ps.items.filter((it) => it.w > 0).map((it) => (
              <Seg key={it.key} w={it.w} color={POWER_COLOR[it.key]} on={it.selected}
                title={`${it.title} ${fmt(it.n)}대 — ${it.selected ? '다시 누르면 해제' : '눌러서 이것만 보기'}`} onClick={() => pClick(it.key)} />
            ))}
          </div>
        ) : <div className="vmd-seg empty" aria-hidden="true" />}
        <div className="vmd-legend">
          {ps.items.length ? ps.items.map((it) => (
            <button key={it.key} type="button" className={`vmd-leg${it.selected ? ' on' : ''}`} aria-pressed={it.selected}
              aria-label={`전원 ${it.label} ${fmt(it.n)}대`} title={it.selected ? '다시 누르면 해제' : it.title}
              onClick={() => pClick(it.key)}>
              <span className="vmd-dot" style={{ background: POWER_COLOR[it.key] }} aria-hidden="true" />{it.label} {fmt(it.n)}
            </button>
          )) : <span className="vmd-faint">VM 이 없습니다</span>}
        </div>
      </div>
      <div className="vmd-mix">
        <div className="vmd-mix-h">
          <button type="button" className={`vmd-leg${gs.allSelected ? ' on' : ''}`} aria-pressed={gs.allSelected}
            aria-label={`GPU 할당 VM ${fmt(gs.total)}대`} title={gs.allSelected ? '다시 누르면 해제' : 'GPU 가 할당된 VM 만 표에 남깁니다(위 GPU 카드와 같은 선택)'}
            onClick={() => gClick('all')}>GPU 할당</button>
          <span className="vmd-mono">{fmt(gs.total)}</span>
        </div>
        <div className="vmd-seg bg">
          {gs.items.filter((it) => it.w > 0).map((it) => (
            <Seg key={it.key} w={it.w} color={GPU_COLOR[it.key]} on={it.selected}
              title={`${it.label} ${fmt(it.n)}대 — ${it.selected ? '다시 누르면 해제' : '눌러서 이것만 보기'}`} onClick={() => gClick(it.key)} />
          ))}
        </div>
        <div className="vmd-legend">
          {gs.items.map((it) => (
            <button key={it.key} type="button" className={`vmd-leg${it.selected ? ' on' : ''}`} aria-pressed={it.selected}
              aria-label={`GPU ${it.label} ${fmt(it.n)}대`} title={it.selected ? '다시 누르면 해제' : `${it.label} VM 만 표에 남깁니다`}
              onClick={() => gClick(it.key)}>
              <span className="vmd-dot" style={{ background: GPU_COLOR[it.key] }} aria-hidden="true" />{GPU_LABEL[it.key]} {fmt(it.n)}
            </button>
          ))}
          <span className="vmd-faint">없음 {fmt(gs.none)}</span>
        </div>
      </div>
    </div>
  );
}

/** Guest OS 상위 패널 — 줄을 누르면 그 OS 만. */
function OsPanel({ os, sel, onSel }) {
  const rows = osRows(os, sel);
  const foot = osFooter(os);
  return (
    <div className="vmd-panel">
      <span className="vmd-pt">Guest OS 상위 5</span>
      {rows.length ? rows.map((r) => (
        <button key={r.name} type="button" className={`vmd-os${r.selected ? ' on' : ''}`} aria-pressed={r.selected}
          aria-label={`OS ${r.label} ${fmt(r.n)}대`} title={`${r.label} · ${fmt(r.n)}대 — ${r.selected ? '다시 누르면 해제' : '눌러서 이 OS 만 보기'}`}
          onClick={() => onSel(toggleSel(sel, r.name))}>
          <span className="vmd-os-n">{r.label}</span>
          <span className="vmd-os-c">{fmt(r.n)}</span>
          <span className="vmd-os-bar" aria-hidden="true"><span style={{ width: `${r.w}%` }} /></span>
        </button>
      )) : <div className="vmd-empty">VM 이 없습니다</div>}
      {foot && <span className="vmd-note">{foot}</span>}
    </div>
  );
}

/**
 * 분포 4패널. dist 가 없으면(구버전 서버·집계 실패) 패널 대신 한 줄 안내 — 0 막대를 지어내지 않는다.
 * @param {{dist:object|null, facets:object, onFacet:(key:string, value:string)=>void, gpuSel:{gpuOnly:boolean,gpuType:string}, onGpu:(next:object)=>void}} p
 */
export function VmDistPanels({ dist, facets, onFacet, gpuSel, onGpu }) {
  if (!dist || typeof dist !== 'object') return <div className="vmd-nodist">{NO_DIST_TEXT}</div>;
  return (
    <div className="vmd-panels">
      <UsagePanel title="CPU 사용률 분포" what="CPU" panel={dist.cpu} sel={facets.cpuBin} onSel={(v) => onFacet('cpuBin', v)} />
      <UsagePanel title="메모리 사용률 분포" what="메모리" panel={dist.mem} sel={facets.memBin} onSel={(v) => onFacet('memBin', v)} />
      <PowerGpuPanel power={dist.power} gpu={dist.gpu} powerSel={facets.power} onPower={(v) => onFacet('power', v)} gpuSel={gpuSel} onGpu={onGpu} />
      <OsPanel os={dist.os} sel={facets.osName} onSel={(v) => onFacet('osName', v)} />
    </div>
  );
}

/** 선택 칩 줄 — 고른 구간(× 로 해제) · 모두 해제 · 오른쪽 서버 정렬 기준. */
export function VmDistChips({ chips, onClear, onClearAll }) {
  const list = Array.isArray(chips) ? chips : [];
  return (
    <div className="vmd-chips">
      {list.length ? (
        <>
          {list.map((c) => (
            <span key={c.key} className={`vmd-chip t-${c.tone}`}>
              {c.text}
              <button type="button" className="vmd-chip-x" aria-label={`${c.label} 선택 해제`} title="선택 해제" onClick={() => onClear(c.key)}>×</button>
            </span>
          ))}
          <button type="button" className="vmd-clear-all" onClick={onClearAll}>모두 해제</button>
          <span className="vmd-hint">위 패널에서 고른 구간입니다 · 다시 누르면 해제</span>
        </>
      ) : (
        <span className="vmd-hint">막대·개수·전원·GPU·OS 를 누르면 그 구간의 VM 만 표에 남습니다</span>
      )}
      <span className="vmd-order">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        CPU 사용률 높은 순
      </span>
    </div>
  );
}

/** 표의 CPU·메모리 칸 — 이 화면 전용(공용 UsageCell 은 다른 화면이 쓰므로 바꾸지 않는다). */
export function VmUsageBar({ pct }) {
  const u = usageView(pct);
  if (u.tone === 'none') return <span className="vmd-ub none" title="사용률을 읽지 못했습니다(꺼짐·연결 끊김·무응답 등)">—</span>;
  return (
    <span className="vmd-ub">
      <span className="vmd-ub-bar" aria-hidden="true"><span style={{ width: `${u.w}%`, background: TONE_COLOR[u.tone] }} /></span>
      <span className="vmd-ub-v" style={{ color: TONE_TEXT[u.tone] }}>{u.text}</span>
    </span>
  );
}

/** VM 이름 칸 — 앞에 전원 점(색 + title + 화면판독 글자). */
export function VmNameCell({ vm, onOpen }) {
  const d = powerDot(vm?.powerState);
  return (
    <span className="vmd-name">
      <span className="vmd-pdot" style={{ background: d.color }} title={d.label} aria-hidden="true" />
      <span className="vmd-sr">{d.label} </span>
      <button type="button" className="cell-link" onClick={() => onOpen(vm)}>{vm?.name}</button>
    </span>
  );
}

/** 좁은 화면 2줄 목록(시안 MobileC) — 표와 동시에 DOM 에 두지 않는다. 행을 누르면 상세. */
export function VmMobileList({ rows, onOpen }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return <div className="vmd-mlist-empty">조건에 맞는 VM 이 없습니다.</div>;
  return (
    <div className="vmd-mlist">
      {list.map((v) => {
        const d = powerDot(v.powerState);
        const c = usageView(v.cpuUsagePct);
        const m = usageView(v.memUsagePct);
        const bar = (lab, u) => (
          <span className="vmd-mbar">
            <span className="lab">{lab}</span>
            <span className="track" aria-hidden="true"><span style={{ width: `${u.w}%`, background: TONE_COLOR[u.tone] }} /></span>
            <span className="val" style={{ color: TONE_TEXT[u.tone] }}>{u.text}</span>
          </span>
        );
        return (
          <button key={v.id || `${v.vcenterId}:${v.name}`} type="button" className="vmd-mrow" onClick={() => onOpen(v)}>
            <span className="vmd-mrow-l">
              <span className="vmd-mrow-n">
                <span className="vmd-pdot" style={{ background: d.color }} title={d.label} aria-hidden="true" />
                <span className="vmd-sr">{d.label} </span>
                <span className="name">{v.name}</span>
              </span>
              <span className="vmd-mrow-s"><span className="vmd-mono">{v.vcenterId}</span> · {v.guestOS || '(OS 정보 없음)'}</span>
            </span>
            <span className="vmd-mrow-r">
              {bar('CPU', c)}
              {bar('MEM', m)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

