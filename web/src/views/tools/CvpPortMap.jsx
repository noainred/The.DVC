import React, { useEffect, useMemo, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { deviceOptions } from './cvpIntfText.js';
import {
  SUB_DEFS, SUB_ORDER, EV_DEFS, EV_ORDER, UTIL_DEFS, UTIL_ORDER, paintOf, flagOf, evLabel, layoutCells, mgmtPorts, headline, barSegs,
  speedRowText, speedName, verdictText, lastLinkText, xcvrText, utilText, descText, lldpText, speedText, FILTERS, filterPorts, filterCount,
  fleetRows, fleetTotals, corpChips, utilBand, PORTMAP_NOTE,
} from './cvpPortMapText.js';

/**
 * CVP › 포트 구성도(v3.37 — 설계 docs/design/cvp-port-map). 두 보기:
 *  · 스위치 1대 — 전면 배치(모델 배치표 · 없으면 번호 규칙) · 사용/예비 개수 · 선택한 포트의 연결 장비와 근거 · 포트 표
 *  · 전 스위치 여유 — 장비마다 사용 · 예비 · 확인 필요 · 꺼짐
 * 판정은 서버(cvp/portmap.js)가 하고 이 화면은 그리기만 한다. 폴링 없음 — 장비 선택 · 새로고침 때만 부른다.
 */
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
const MONO = { fontFamily: 'var(--mono)' };
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const PANEL = { background: 'var(--panel-deep, #0f1626)', border: '1px solid var(--border-soft, #1f2a40)', borderRadius: 10 };

function Seg({ items, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      {items.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}
          style={{ height: 32, padding: '0 12px', border: 0, borderRight: '1px solid var(--border)', font: 'inherit', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
            background: value === k ? 'var(--accent)' : 'transparent', color: value === k ? '#fff' : 'var(--text-dim)', fontWeight: value === k ? 600 : 400 }}>{l}</button>
      ))}
    </div>
  );
}
const Swatch = ({ paint, round }) => <span aria-hidden="true" style={{ display: 'inline-block', boxSizing: 'border-box', width: 14, height: 12, borderRadius: round ? 999 : 3, flex: '0 0 auto', ...paint }} />;

function Cell({ cell, mode, sel, onPick, wide }) {
  const p = cell.rep;
  const flag = mode === 'use' ? flagOf(p) : null;
  const tip = p ? `${cell.name} — ${(SUB_DEFS[p.sub] || SUB_DEFS.unknown).label}${p.device ? ` · ${p.device}` : ''}${p.oper === 'up' ? ` · ${evLabel(p, true)}` : ''}` : `${cell.label}번 칸 — 수집한 포트 목록에 없음`;
  return (
    <button type="button" title={tip} aria-label={tip} disabled={!p} onClick={() => p && onPick(cell.ports[0].name)}
      style={{ position: 'relative', boxSizing: 'border-box', width: wide ? 40 : 30, height: 30, padding: 0, borderRadius: 5, font: '600 11px var(--mono)', cursor: p ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center', ...paintOf(p, mode), ...(p ? {} : { opacity: 0.45 }),
        ...(sel ? { outline: '2px solid #ffffff', outlineOffset: 2 } : {}) }}>
      {cell.label}
      {flag && <span aria-hidden="true" style={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, boxSizing: 'border-box', borderRadius: '50%', border: '2px solid #0b1120', background: flag }} />}
    </button>
  );
}

function Group({ g, mode, selName, onPick }) {
  const band = g.form === 'QSFP' ? '#5b4bc4' : g.form === 'RJ45' ? '#475569' : '#0f766e';
  const wide = g.form === 'QSFP';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{g.label}</div>
      <div style={{ alignSelf: 'flex-start', display: 'grid', gridTemplateRows: 'auto auto', gridAutoFlow: 'column', gap: '9px 3px', padding: 5, border: '1px solid var(--border)', borderRadius: 5,
        background: `linear-gradient(to bottom, #0f1626 calc(50% - 2px), ${band} calc(50% - 2px), ${band} calc(50% + 2px), #0f1626 calc(50% + 2px))` }}>
        {g.cells.map((c) => <Cell key={c.cage} cell={c} mode={mode} wide={wide} sel={!!c.ports.find((p) => p.name === selName)} onPick={onPick} />)}
      </div>
    </div>
  );
}

function Faceplate({ data, mode, selName, onPick }) {
  const fp = data.faceplate || {};
  const lay = useMemo(() => layoutCells(fp, data.ports), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const mgmt = mgmtPorts(data.ports);
  const mgmtCell = (p) => (
    <button key={p.name} type="button" title={`${p.name} — ${(SUB_DEFS[p.sub] || SUB_DEFS.unknown).label}${p.device ? ` · ${p.device}` : ''}`} onClick={() => onPick(p.name)}
      style={{ boxSizing: 'border-box', width: 46, height: 24, padding: 0, borderRadius: 5, font: '600 11px var(--mono)', cursor: 'pointer', ...paintOf(p, mode), ...(p.name === selName ? { outline: '2px solid #fff', outlineOffset: 2 } : {}) }}>
      Ma{String(p.name).replace(/^\D+/, '')}
    </button>
  );
  const Place = ({ t }) => <span style={{ boxSizing: 'border-box', width: 46, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #5d6b85', borderRadius: 4, fontSize: 10.5, color: 'var(--text-dim)' }}>{t}</span>;
  const mgmtBlock = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {mgmt.map(mgmtCell)}
      {!mgmt.length && <span style={{ fontSize: 10.5, color: 'var(--text-dim)', maxWidth: 90 }}>관리 포트가 수집 목록에 없음</span>}
      <Place t="USB" /><Place t="콘솔" />
    </div>
  );
  const head = (
    <div style={{ ...ROW, justifyContent: 'space-between' }}>
      <div style={{ ...ROW, gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>전면</span>
        <b style={{ ...MONO, fontSize: 12.5 }}>{fp.model || data.device?.model || '모델 모름'}</b>
        <span style={{ fontSize: 11, color: fp.source === 'model' ? 'var(--text-dim)' : 'var(--amber)' }}>
          {fp.source === 'model' ? (fp.modular ? '섀시 배치표 · 카드 안은 번호 규칙' : '모델 배치표대로 · 홀수 위 ▲ 짝수 아래 ▼') : '번호 규칙(실물 배치 아님)'}
        </span>
      </div>
      {fp.leds && fp.leds.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>표시등: {fp.leds.join(' · ')}(부품 탭에서 상태 확인)</span>}
    </div>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 16px', alignItems: 'stretch' }}>
      <div style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px 14px', background: '#0b1120', border: '1px solid #3b4a68', borderRadius: 8 }}>
        {head}
        {fp.modular ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {fp.supervisors ? <div style={NOTE}>수퍼바이저 {fp.supervisors}칸(위) — 관리 포트 · 콘솔 · USB</div> : null}
            {(lay.slots || []).map((s) => (
              <div key={s.slot} style={{ ...PANEL, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <b style={{ fontSize: 12 }}>{s.label}</b>
                <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', width: 'max-content' }}>
                    {s.groups.map((g) => <Group key={g.label} g={g} mode={mode} selName={selName} onPick={onPick} />)}
                  </div>
                </div>
              </div>
            ))}
            {!lay.slots?.length && <div style={NOTE}>슬롯 번호를 읽을 수 있는 포트가 없습니다.</div>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 8px', alignItems: 'flex-end' }}>
            {(lay.groups || []).map((g) => <Group key={g.label} g={g} mode={mode} selName={selName} onPick={onPick} />)}
            {fp.mgmt === 'front' && mgmt.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><div style={{ fontSize: 11, color: 'var(--text-dim)' }}>관리</div>{mgmtBlock}</div>
            )}
          </div>
        )}
        {fp.extra && fp.extra.length > 0 && <div style={NOTE}>배치표 밖 포트 {fp.extra.length}개: {fp.extra.slice(0, 8).join(', ')}{fp.extra.length > 8 ? ' …' : ''} — 표에서 볼 수 있습니다.</div>}
      </div>
      {(fp.mgmt === 'rear' || (fp.mgmt !== 'front' && mgmt.length > 0)) && (
        <div style={{ flex: '0 0 auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px 14px', background: '#0b1120', border: '1px solid #3b4a68', borderRadius: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fp.mgmt === 'rear' ? '후면 · 관리 포트' : '관리 포트'}</span>
          <div style={{ marginTop: 'auto' }}>{mgmtBlock}</div>
        </div>
      )}
    </div>
  );
}

function Legend({ data, mode }) {
  const ports = (data.ports || []).filter((p) => !p.mgmt);
  let items;
  const unread = !data.lldp?.read;
  if (mode === 'evidence') items = EV_ORDER.map((k) => ({ k, label: unread && (k === 'desc' || k === 'none') ? evLabel({ ev: k, lldpUnread: true }, true) : EV_DEFS[k].label, paint: EV_DEFS[k].paint, n: ports.filter((p) => p.ev === k).length }));
  else if (mode === 'util') items = UTIL_ORDER.map((k) => ({ k, label: UTIL_DEFS[k].label, paint: UTIL_DEFS[k].paint, n: ports.filter((p) => utilBand(p) === k).length }));
  else items = SUB_ORDER.map((k) => ({ k, label: SUB_DEFS[k].label, paint: SUB_DEFS[k].paint, n: data.counts?.[k] ?? 0 }));
  items = items.filter((x) => x.n > 0 || mode !== 'use' || ['use', 'spareX', 'check'].includes(x.k));
  return (
    <div style={{ ...ROW, gap: '6px 16px', fontSize: 12 }}>
      {items.map((x) => <span key={x.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}><Swatch paint={x.paint} />{x.label} <b style={MONO}>{x.n}</b></span>)}
      {mode === 'use' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Swatch round paint={{ background: '#f87171' }} />모서리 점 = 근거 확인할 것(불일치 · 근거 없음 · LLDP 만) <b style={MONO}>{ports.filter((p) => flagOf(p)).length}</b></span>}
    </div>
  );
}

function Detail({ p, data }) {
  if (!p) return <div style={NOTE}>구성도나 표에서 포트를 누르면 연결 장비와 근거가 나옵니다.</div>;
  const s = SUB_DEFS[p.sub] || SUB_DEFS.unknown;
  const ev = EV_DEFS[p.ev] || EV_DEFS.nolink;
  const pill = (paint) => ({ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', ...paint, textDecoration: 'none' });
  const rows = [
    ['포트 설명(주석)', descText(p.desc)],
    ['LLDP 이웃', lldpText(p)],
    ['링크 · 관리', `${p.oper === 'up' ? '연결됨' : p.oper === 'unknown' ? '모름' : '링크 없음'} · ${p.admin === 'down' ? '꺼짐(shutdown)' : p.admin === 'up' ? '켜짐' : '모름'}`],
    ['속도 · 트랜시버', `${speedText(p)} · ${xcvrText(p)}`],
    ['VLAN · LAG', `${p.vlan || '—'} · ${p.lag || 'LAG 아님'}`],
    ['수신 / 송신', utilText(p)],
    ['마지막 링크', lastLinkText(p, data.linkHistory?.since)],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={ROW}><b style={{ ...MONO, fontSize: 16 }}>{p.name}</b><span style={pill(s.paint)}>{s.label}</span></div>
      <div style={{ ...PANEL, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>연결 장비</div>
        <div style={ROW}>
          <span style={{ ...MONO, fontSize: 17, fontWeight: 600, overflowWrap: 'anywhere' }}>{p.device || '—'}</span>
          {p.device && <span style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 999, padding: '1px 9px' }}>{p.deviceKind === 'switch' ? 'CVP 스위치' : '종류 미상'}</span>}
        </div>
        <div style={ROW}><span style={{ fontSize: 12, color: 'var(--text-dim)' }}>근거</span><span style={pill(p.oper === 'up' ? ev.paint : EV_DEFS.nolink.paint)}>{p.oper === 'up' ? evLabel(p) : '링크 없음'}</span></div>
        <div style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{verdictText(p)}</div>
      </div>
      <div>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border-soft, #1f2a40)' }}>
            <div style={{ flex: '0 0 112px', fontSize: 12, color: 'var(--text-dim)' }}>{k}</div>
            <div style={{ flex: '1 1 0', minWidth: 0, ...MONO, fontSize: 12.5, overflowWrap: 'anywhere' }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OneSwitch({ devices, initial = null }) {
  const opts = useMemo(() => deviceOptions(devices), [devices]);
  const [sel, setSel] = useState(initial || '');
  const [q, setQ] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState('use');
  const [pick, setPick] = useState(null);
  const [filt, setFilt] = useState('all');
  useEffect(() => { if (!sel && opts.length) setSel(opts[0].id); }, [opts, sel]);
  const cur = opts.find((o) => o.id === sel) || null;
  useEffect(() => {
    if (!cur) return undefined;
    let active = true;
    setErr(null); setR(null); setPick(null);
    fetchJson('/tools/cvp/portmap', { cvpId: cur.cvpId, key: cur.key })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cur?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownOpts = q.trim() ? opts.filter((o) => `${o.label} ${o.model} ${o.corp}`.toLowerCase().includes(q.trim().toLowerCase())) : opts;
  const ports = r && Array.isArray(r.ports) ? r.ports : null;
  const selPort = ports ? (ports.find((p) => p.name === pick) || null) : null;
  const shown = ports ? filterPorts(ports, filt) : [];
  const c = r?.counts;
  const d = r?.device || {};
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={ROW}>
          <input className="input" placeholder="장비 검색(호스트명·모델·법인)" aria-label="장비 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240, minWidth: 0, flex: '1 1 160px' }} />
          <Select className="input" aria-label="장비 선택" value={sel} onChange={(e) => { setSel(e.target.value); setFilt('all'); }} style={{ maxWidth: 380, minWidth: 0, flex: '1 1 200px' }}>
            {!cur && <option value="">장비를 고르세요</option>}
            {cur && !shownOpts.some((o) => o.id === cur.id) && <option value={cur.id}>{cur.label}</option>}
            {shownOpts.map((o) => <option key={o.id} value={o.id}>{o.label}{o.model ? ` · ${o.model}` : ''}{o.corp ? ` · ${o.corp}` : ''}</option>)}
          </Select>
          <button type="button" className="btn" onClick={() => setReload((x) => x + 1)} disabled={!cur}>새로고침</button>
        </div>
        {r && <div style={NOTE}>{[d.hostname || cur?.label, d.model, d.eosVersion ? `EOS ${d.eosVersion}` : '', d.corpName ? `법인 ${d.corpName}` : '', r.cvpName ? `CVP ${r.cvpName}` : ''].filter(Boolean).join(' · ')}</div>}
        {r && <div style={NOTE}>{`포트 상태 ${r.collectedAt ? new Date(r.collectedAt).toLocaleString() : '—'} · 트랜시버 ${r.partsAt ? new Date(r.partsAt).toLocaleString() : '못 읽음'} · LLDP ${r.lldp?.read ? new Date(r.lldp.at).toLocaleString() : '못 읽음'}${r.lldp?.failing ? '(마지막 시도 실패 — 이전 값)' : ''}`}</div>}
      </div>

      {!opts.length && <div className="banner">수집된 CVP 장비가 없습니다.</div>}
      {err && <ErrorBox error={err} />}
      {cur && !r && !err && <Loading />}
      {r && !ports && <div className="banner">이 장비의 포트 목록을 아직 읽지 못했습니다(텔레메트리 스트리밍 · 수집 경로를 ‘읽은 경로’ 에서 확인하세요).</div>}

      {ports && (<>
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...ROW, gap: '6px 14px', alignItems: 'baseline' }}>
            <b>포트 사용 · 예비</b><span style={{ fontSize: 13 }}>{headline(c)}</span>
            <span style={NOTE}>관리 포트는 개수에서 뺍니다</span>
          </div>
          <div role="img" aria-label={headline(c) || ''} style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--panel-deep, #0f1626)' }}>
            {barSegs(c).map((s) => <div key={s.key} title={`${s.label} ${s.n}`} style={{ flex: `${s.n} 1 0`, background: s.color, borderRight: '2px solid var(--panel)' }} />)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {[['use', c.use, '링크가 올라온 포트'], ['spareX', c.spare, SUB_DEFS.spareX.hint ? `GBIC 꽂힘 ${c.spareX} · 빈 케이지 ${c.spareE}${c.spareC ? ` · 구리 ${c.spareC}` : ''}${c.spareU ? ` · 모름 ${c.spareU}` : ''}` : ''], ['check', c.check, SUB_DEFS.check.hint], ['off', c.off, SUB_DEFS.off.hint], ...(c.unknown ? [['unknown', c.unknown, SUB_DEFS.unknown.hint]] : [])].map(([k, n, meta]) => (
              <div key={k} style={{ ...PANEL, borderRadius: 12, padding: '12px 14px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-dim)' }}><Swatch paint={SUB_DEFS[k].paint} />{k === 'spareX' ? '예비' : SUB_DEFS[k].label}</div>
                <div style={{ ...MONO, fontSize: 24, fontWeight: 600 }}>{n}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{meta}</div>
              </div>
            ))}
          </div>
          {(r.bySpeed || []).length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={NOTE}>속도별</div>
              {r.bySpeed.map((g) => (
                <div key={g.speed ?? 'none'} style={{ ...ROW, gap: '6px 14px' }}>
                  <div style={{ flex: '0 0 130px', fontWeight: 600 }}>{speedName(g.speed)} {g.counts.total}포트</div>
                  <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--panel-deep, #0f1626)' }}>
                    {barSegs(g.counts).map((s) => <div key={s.key} style={{ flex: `${s.n} 1 0`, background: s.color, borderRight: '2px solid var(--panel)' }} />)}
                  </div>
                  <div style={{ flex: '1 1 320px', minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>{speedRowText(g.counts)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...ROW, gap: '8px 14px' }}>
            <b>전면 포트 구성</b>
            <span style={NOTE}>색 기준</span>
            <Seg label="색 기준" value={mode} onChange={setMode} items={[['use', '사용 · 예비'], ['evidence', '연결 근거'], ['util', '트래픽 사용률']]} />
            <span style={NOTE}>포트를 누르면 연결 장비와 근거가 나옵니다</span>
          </div>
          <Faceplate data={r} mode={mode} selName={pick} onPick={setPick} />
          <Legend data={r} mode={mode} />
          {mode === 'util' && <div style={NOTE}>마지막 수집의 순간 사용률(수신 · 송신 중 큰 쪽)입니다. 링크가 없는 포트는 0% 가 아니라 ‘측정 없음’ 입니다.</div>}
          {mode === 'evidence' && !r.lldp?.read && <div className="banner">이 장비의 LLDP 이웃을 읽지 못했습니다 — 연결 장비는 포트 설명만으로 표시하고 일치 · 불일치는 판정하지 않습니다. 이웃이 없다는 뜻이 아닙니다.</div>}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
          <div className="card" style={{ flex: '1 1 320px', minWidth: 0 }}><Detail p={selPort} data={r} /></div>
          <div className="card" style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={ROW}>
              <b>포트별 연결 장비</b>
              {FILTERS.map(([k, l]) => (
                <button key={k} type="button" className={`tab${filt === k ? ' active' : ''}`} aria-pressed={filt === k} onClick={() => setFilt(k)}>{l} <b style={MONO}>{filterCount(ports, k)}</b></button>
              ))}
            </div>
            <STable className="v3-table" minWidth={1180}>
              <thead>
                <tr><th>포트</th><th>분류</th><th>연결 장비</th><th>근거</th><th>설명(주석)</th><th>LLDP 이웃</th><th>트랜시버</th><th>수신 / 송신</th><th>마지막 링크</th></tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.name} style={p.name === pick ? { background: 'rgba(59,130,246,0.14)' } : undefined}>
                    <td data-sort={p.name}><button type="button" onClick={() => setPick(p.name)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-2)', cursor: 'pointer', ...MONO, fontWeight: 600 }}>{p.name}</button></td>
                    <td style={{ whiteSpace: 'nowrap' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Swatch paint={(SUB_DEFS[p.sub] || SUB_DEFS.unknown).paint} />{(SUB_DEFS[p.sub] || SUB_DEFS.unknown).label}</span></td>
                    <td style={{ ...MONO, whiteSpace: 'normal', overflowWrap: 'break-word', minWidth: 130, maxWidth: 220 }}>{p.device || '—'}</td>
                    <td style={{ color: p.oper === 'up' ? (EV_DEFS[p.ev] || EV_DEFS.nolink).color : 'var(--text-dim)', whiteSpace: 'nowrap' }}>{p.oper === 'up' ? evLabel(p, true) : (p.desc ? '설명(링크 없음)' : '—')}</td>
                    <td style={{ ...MONO, fontSize: 12, minWidth: 150, maxWidth: 240, whiteSpace: 'normal', overflowWrap: 'break-word' }} title={descText(p.desc)}>{p.desc ? p.desc : '—'}</td>
                    <td style={{ ...MONO, fontSize: 12, minWidth: 150, maxWidth: 240, whiteSpace: 'normal', overflowWrap: 'break-word' }}>{p.lldp ? lldpText(p) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{xcvrText(p)}</td>
                    <td data-sort={p.oper === 'up' ? Math.max(Number(p.inUtil) || 0, Number(p.outUtil) || 0) : ''} style={{ ...MONO, textAlign: 'right', whiteSpace: 'nowrap' }}>{utilText(p)}</td>
                    <td data-sort={p.oper === 'up' ? Date.now() : p.lastLinkAt ?? ''} style={{ whiteSpace: 'nowrap' }}>{lastLinkText(p, r.linkHistory?.since)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {!shown.length && <div style={NOTE}>필터에 맞는 포트가 없습니다.</div>}
            <div style={NOTE}>{shown.length}개 표시 · 머리글을 누르면 정렬합니다</div>
          </div>
        </div>
        <div style={NOTE}><BoldText text={PORTMAP_NOTE} /></div>
      </>)}
    </div>
  );
}

function Fleet({ onOpen }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [corp, setCorp] = useState(null);
  const [lowOnly, setLowOnly] = useState(false);
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson('/tools/cvp/portmap/summary').then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [reload]);
  if (err) return <ErrorBox error={err} />;
  if (!r) return <Loading />;
  const all = Array.isArray(r.devices) ? r.devices : [];
  const inCorp = corp == null ? all : all.filter((d) => (d.corpName || '') === corp);
  const lowMax = r.lowSpareMax ?? null;
  const rows = fleetRows(inCorp, { lowOnly, lowMax });
  const t = fleetTotals(inCorp);
  const lowN = fleetRows(inCorp, { lowOnly: true, lowMax }).length;
  const pct = (n) => (t.total ? `${Math.round((n / t.total) * 100)}%` : '—');
  const tiles = [
    ['스위치', `${t.devices}대`, `포트를 읽은 장비 ${t.read} · 못 읽음 ${t.unread}`, 'var(--text)'],
    ['전체 포트', t.total, `읽은 장비 ${t.read}대 합`, 'var(--text)'],
    ['사용 중', t.use, `${pct(t.use)} · 링크가 올라온 포트`, '#4ade80'],
    ['예비', t.spare, `${pct(t.spare)} · GBIC 꽂힘 ${t.spareX} · 빈 케이지 ${t.spareE}${t.spareC ? ` · 구리 ${t.spareC}` : ''}${t.spareU ? ` · 모름 ${t.spareU}` : ''}`, '#93c5fd'],
    ['확인 필요', t.check, '설명은 있는데 링크 없음', '#fbbf24'],
    ['여유 부족 스위치', `${lowN}대`, lowMax != null ? `예비 ${lowMax}개 이하` : '', '#fca5a5'],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={ROW}>
          <span style={NOTE}>법인</span>
          <button type="button" className={`tab${corp == null ? ' active' : ''}`} onClick={() => setCorp(null)}>전체 <b style={MONO}>{all.length}</b></button>
          {corpChips(all).map((c) => <button key={c.name} type="button" className={`tab${corp === c.name ? ' active' : ''}`} onClick={() => setCorp(c.name)}>{c.label} <b style={MONO}>{c.n}</b></button>)}
          {lowMax != null && <button type="button" className={`tab${lowOnly ? ' active' : ''}`} aria-pressed={lowOnly} onClick={() => setLowOnly((x) => !x)}>여유 부족만(예비 {lowMax}개 이하) <b style={MONO}>{lowN}</b></button>}
          <button type="button" className="btn" onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {tiles.map(([l, n, meta, col]) => (
          <div key={l} className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{l}</div>
            <div style={{ ...MONO, fontSize: 24, fontWeight: 600, color: col }}>{n}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{meta}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ ...ROW, gap: '6px 16px', fontSize: 12 }}>
          <b style={{ fontSize: 14 }}>스위치별 포트 여유</b>
          {['use', 'check', 'spareX', 'spareE', 'spareC', 'spareU', 'off', 'unknown'].map((k) => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span aria-hidden="true" style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 3, background: SUB_DEFS[k].bar }} />{SUB_DEFS[k].label}</span>)}
        </div>
        <STable className="v3-table" minWidth={980}>
          <thead>
            <tr><th>법인</th><th>스위치</th><th>모델</th><th>전체</th><th>사용</th><th>예비</th><th>확인 필요</th><th>꺼짐</th><th>확인 불가</th><th data-nosort>분포</th><th>40G 이상 예비</th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={`${d.cvpId}|${d.key}`}>
                <td>{d.corpName || '법인 미지정'}</td>
                <td data-sort={d.hostname}><button type="button" onClick={() => onOpen(d)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-2)', cursor: 'pointer', ...MONO, fontWeight: 600 }}>{d.hostname}</button></td>
                <td style={{ whiteSpace: 'normal' }}>{d.model || '—'}{d.source === 'rule' ? <span style={{ ...NOTE, marginLeft: 6 }}>(번호 규칙)</span> : null}</td>
                {d.counts ? (<>
                  <td data-sort={d.counts.total} style={{ ...MONO, textAlign: 'right' }}>{d.counts.total}</td>
                  <td data-sort={d.counts.use} style={{ ...MONO, textAlign: 'right' }}>{d.counts.use}</td>
                  <td data-sort={d.counts.spare} style={{ ...MONO, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={d.low ? { padding: '1px 8px', borderRadius: 999, background: '#5a1616', border: '1px solid #f87171', color: '#ffe9e9', fontWeight: 600 } : { fontWeight: 600, color: '#93c5fd' }}>{d.counts.spare}</span>
                  </td>
                  <td data-sort={d.counts.check} style={{ ...MONO, textAlign: 'right' }}>{d.counts.check}</td>
                  <td data-sort={d.counts.off} style={{ ...MONO, textAlign: 'right' }}>{d.counts.off}</td>
                  <td data-sort={d.counts.unknown} style={{ ...MONO, textAlign: 'right' }}>{d.counts.unknown}</td>
                  <td style={{ width: 130 }}><div style={{ display: 'flex', width: 120, height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--panel-deep, #0f1626)' }}>{barSegs(d.counts).map((s) => <div key={s.key} title={`${s.label} ${s.n}`} style={{ flex: `${s.n} 1 0`, background: s.color, borderRight: '2px solid var(--panel)' }} />)}</div></td>
                  <td data-sort={d.spareHigh ?? ''} style={{ ...MONO, textAlign: 'right' }}>{d.spareHigh ?? '—'}</td>
                </>) : (<>
                  <td data-sort="" style={{ textAlign: 'right' }}>—</td><td data-sort="">—</td><td data-sort="">—</td><td data-sort="">—</td><td data-sort="">—</td><td data-sort="">—</td>
                  <td style={{ color: 'var(--amber)', fontSize: 12, whiteSpace: 'normal', width: 130 }}>포트 목록 못 읽음(0 이 아님)</td><td data-sort="">—</td>
                </>)}
              </tr>
            ))}
          </tbody>
        </STable>
        {!rows.length && <div style={NOTE}>조건에 맞는 스위치가 없습니다.</div>}
        <div style={NOTE}>{rows.length}대 표시 · 예비가 적은 순 · 포트 목록을 못 읽은 장비는 합계에 넣지 않고 맨 뒤에 둡니다{r.truncated ? ` · ⚠ 포트 행이 상한(${r.portsMax})을 넘어 일부만 셌습니다` : ''}. 법인은 장비가 아니라 CVP 서버의 DataCenter 기준입니다.</div>
      </div>
    </div>
  );
}

export default function CvpPortMapView({ devices = [] }) {
  const [view, setView] = useState('one');
  const [jump, setJump] = useState(0);
  const [jumpTo, setJumpTo] = useState(null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      <div style={{ ...ROW, gap: '8px 14px' }}>
        <b style={{ fontSize: 15 }}>포트 구성도</b>
        <Seg label="보기" value={view} onChange={setView} items={[['one', '스위치 1대'], ['fleet', '전 스위치 여유']]} />
        <span style={NOTE}>{view === 'one' ? '전면 배치 · 포트별 연결 장비 · 사용/예비' : '어느 스위치에 예비 포트가 남았는지 — 스위치 이름을 누르면 그 장비의 구성도로 갑니다'}</span>
      </div>
      {view === 'one'
        ? <OneSwitch key={jump} devices={devices} initial={jumpTo} />
        : <Fleet onOpen={(d) => { setJumpTo(`${d.cvpId}|${d.key}`); setJump((x) => x + 1); setView('one'); }} />}
    </div>
  );
}
