// VmExport.jsx — 특수 기능 'VM 전체 정보 내보내기'(v2.275 → v2.799 '필요한 항목만 고르기').
// 사용자 요청: "VM 전체 정보 CSV 버그 수정 · 추가할 수 있는 정보 · 클로드 디자인으로 멋지게 · vm list export(v2.798) 참고".
// 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC(① 본 화면 ② 엣지 위임 vCenter ③ 400px) 승인 — 시안대로.
// 항목·묶음·빠른 조합은 서버 카탈로그(GET /tools/vm-export/catalog)를 그대로 쓴다(복제하지 않는다). 미리보기는 실시간을 부르지 않는다
// (화면을 여는 것만으로 vCenter 전량 조회를 하지 않게 — v2.799 결함 6). 저장값은 계정에(PUT /tools/vm-export/prefs — 본인 것만).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, postDownload, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { ErrorBox, Loading } from '../../components/primitives.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import ExportPreviewModal from '../../components/ExportPreviewModal.jsx';   // v2.801 미리보기 크게 보기(전체 화면 팝업)
import { PREVIEW_BIG } from './exportPreviewText.js';
import {
  SLOT_COUNT, NAME_MAX, SAVE_WHAT, TONE, badgeOf, sourceTiles, dropCol, moveCol, toggleCol, addCols, dropCols, initialState, valueToSave, applyValue,
  slotLabel, defaultLine, savedText, exportBody, targetCount, liveMissCount, footerText, cellKind,
} from './vmExportText.js';
import './vmExport.css';

const fmtN = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—');
const Badge = ({ b }) => (b.text ? <span className="vmx-badge" style={{ color: TONE[b.tone]?.color, borderColor: TONE[b.tone]?.border }}>{b.text}</span> : null);

// embedded(v2.800): vCenter 화면의 창 안에 띄울 때 — 창 제목이 이름을 말하므로 h2 를 빼고, 아래 막대를 창 바닥에 붙인다(포탈 상태바 높이를 빼지 않는다).
export function VmExport({ scope, embedded = false }) {
  const csvOk = canCsv();
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [st, setSt] = useState(null);           // { cols, fmt, disk, tagCols, live, target, folder, tmpl }
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [save, setSave] = useState(null);       // { slot, name, what, alsoDefault } — 열렸을 때만
  const [msg, setMsg] = useState(null);         // { ok, text }
  const [busy, setBusy] = useState('');
  const [pv, setPv] = useState(null);
  const [drag, setDrag] = useState({ from: '', over: '' });
  const [prefName, setPrefName] = useState('');
  const [big, setBig] = useState(false);        // v2.801 '크게 보기' 팝업
  const pvGen = useRef(0);

  useEffect(() => {
    setCat(null); setErr(null); setSt(null); setPv(null); setMsg(null); setSave(null);
    if (!scope || !csvOk) return undefined;
    let alive = true;
    fetchJson(`/tools/vm-export/catalog?vcenterId=${encodeURIComponent(scope)}`)
      .then((r) => {
        if (!alive) return;
        const s0 = initialState(r, r.prefs);
        setCat(r); setPrefs(r.prefs || null); setSt(s0);
        setPrefName(r.prefs?.def && Number.isInteger(r.prefs.def.from) ? (r.prefs.slots?.[r.prefs.def.from - 1]?.name || '') : '');
        // 처음에는 고른 항목이 있는 묶음과 새 묶음을 펼친다(시안 ① — 나머지는 접힘). 좁은 화면은 '기본' 만(시안 ③ — 400px 에서 항목 80여 줄이 한 줄씩 늘어섰다).
        const narrow = typeof window !== 'undefined' && window.innerWidth < 720;
        setOpen(new Set((r.groups || []).filter((g) => (narrow ? g.id === 'base' : g.isNew || g.items.some((it) => s0.cols.includes(it.key)))).map((g) => g.id)));
      })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [scope, csvOk]);

  const itemOf = useMemo(() => new Map((cat?.groups || []).flatMap((g) => g.items).map((it) => [it.key, it])), [cat]);
  const status = cat?.status || {};

  // 미리보기 — 고른 것이 바뀌면 0.5초 뒤 대상 첫 3대. 늦게 온 이전 응답은 버린다(실시간은 부르지 않는다).
  const pvKey = st ? JSON.stringify([scope, st.cols, st.disk, st.tagCols, st.live, st.target, st.folder, st.tmpl, st.ynDays]) : '';
  useEffect(() => {
    if (!st || !scope) return undefined;
    if (!st.cols.length || (st.target === 'folder' && !st.folder)) { pvGen.current += 1; setPv(null); return undefined; }
    const my = ++pvGen.current;
    const h = setTimeout(() => {
      postJson(`/tools/vm-export/preview?vcenterId=${encodeURIComponent(scope)}`, exportBody(st))
        .then((r) => { if (my === pvGen.current) setPv(r?.ok === false ? { error: r.reason || '미리보기를 받지 못했습니다' } : r); })
        .catch((e) => { if (my === pvGen.current) setPv({ error: e?.serverReason || e?.message || '미리보기를 받지 못했습니다' }); });
    }, 500);
    return () => clearTimeout(h);
  }, [pvKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!csvOk) return <div className="card muted" style={{ fontSize: 12.5 }}>{CSV_DENIED_NOTE}</div>;
  if (!scope) return <div className="card"><span className="muted">위 <b>범위</b>에서 vCenter 를 선택하세요 — 그 vCenter 의 VM 을 필요한 항목만 골라(호스트·클러스터·NIC·디스크·게스트 파티션·태그 등) CSV · 엑셀로 내려받습니다.</span></div>;
  if (err) return <ErrorBox error={err} />;
  if (!cat || !st) return <Loading label="항목 목록을 불러오는 중" />;

  const set = (patch) => setSt((x) => ({ ...x, ...patch }));
  const ql = q.trim().toLowerCase();
  const presetOn = (p) => p.keys.length === st.cols.length && p.keys.every((k, i) => st.cols[i] === k);
  const liveBlocked = st.live && status.live?.state && status.live.state !== 'ok';
  const missLive = liveMissCount(st.cols, itemOf, status, st.live);
  const tiles = sourceTiles(status, { liveOn: st.live });
  const folders = status.folders || [];
  const rows = pv && !pv.error ? pv.rows : targetCount(status, st.target, st.folder);
  const canDownload = st.cols.length > 0 && !busy && (st.target !== 'folder' || !!st.folder);

  const download = async () => {
    if (!canDownload) return;
    setBusy('down'); setMsg(null);
    try { await postDownload(`/tools/vm-export.${st.fmt}?vcenterId=${encodeURIComponent(scope)}`, exportBody(st, prefName)); }
    catch (e) { setMsg({ ok: false, text: downloadFailText(e) }); }
    finally { setBusy(''); }
  };
  const putPref = async (slot, value, alsoDefault = false) => {
    setBusy('save'); setMsg(null);
    try {
      const r = await putJson('/tools/vm-export/prefs', { slot, value, alsoDefault });
      if (r?.ok === false) { setMsg({ ok: false, text: r.reason || '저장하지 못했습니다.' }); return false; }
      setPrefs(r.prefs); setMsg({ ok: true, text: savedText(slot, value, alsoDefault) });
      if (slot !== 'default') setPrefName(value.name || '');
      return true;
    } catch (e) { setMsg({ ok: false, text: e?.serverReason || e?.message || '저장하지 못했습니다.' }); return false; }
    finally { setBusy(''); }
  };
  const openSave = () => {
    const empty = (prefs?.slots || []).findIndex((s) => !s);
    const i = empty >= 0 ? empty : 0;
    setSave({ slot: i + 1, name: prefs?.slots?.[i]?.name || `이름${i + 1}`, what: { fmt: true, view: true, live: true, target: false }, alsoDefault: false });
  };
  const pickSlot = (n) => setSave((s) => ({ ...s, slot: n, name: prefs?.slots?.[n - 1]?.name || `이름${n}` }));
  const slotTarget = save ? prefs?.slots?.[save.slot - 1] : null;
  const toggleGroup = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chipKey = (e, k) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set({ cols: moveCol(st.cols, k, e.key === 'ArrowLeft' ? -1 : 1) }); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); set({ cols: toggleCol(st.cols, k) }); }
  };

  return (
    <div className={embedded ? 'vmx vmx-embedded' : 'vmx'} data-vm-export="">
      {/* 머리 */}
      <div className="vmx-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 520px' }}>
          {!embedded && <h2>VM 전체 정보 내보내기 <span className="vmx-chipvc">{cat.status?.vcenterName || scope}</span></h2>}
          <div className="sub">선택한 vCenter 의 VM 을 필요한 항목만 골라 CSV · 엑셀로 내려받습니다. 예전 열 그대로가 필요하면 ‘예전 CSV 그대로’ 조합을 누르세요.</div>
        </div>
      </div>

      {/* 데이터 출처 상태 */}
      <div className="vmx-tiles" aria-label="데이터 출처 상태">
        {tiles.map((t) => (
          <div key={t.key} className={`vmx-tile${t.tone === 'no' ? ' bad' : ''}`}>
            <div className="t"><span className="dot" style={{ background: t.dot }} />{t.name}</div>
            <div className="v">{t.value}</div>
            <div className="m">{t.meta}</div>
          </div>
        ))}
      </div>

      {liveBlocked && (
        <div className="vmx-alert" role="status">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fcd34d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 1 }}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4" /><path d="M12 17.5v.5" /></svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <b>이 vCenter 는 실시간 보강을 쓸 수 없습니다.</b>
            <span>{status.live?.reason || '사유를 모릅니다'}</span>
            <span>‘캐시 · 실시간’ 항목은 구성 캐시 값으로 채우고, 실시간에만 있는 항목(NIC · MAC · UUID · 생성일 · 디스크 파일 · 디스크별 Thin)은 파일에 ‘{cat.missingText}’ 으로 씁니다.</span>
            <span className="d">예전에는 이 경우 디스크 · 파티션 칸이 모두 빈칸이었습니다 — 이제 구성 캐시(디스크 용량 · 데이터스토어 · 모드)와 게스트 파티션 수집 값을 씁니다.</span>
          </div>
        </div>
      )}

      {/* 대상 · 형식 · 실시간 */}
      <div className="vmx-card vmx-row" style={{ gap: '10px 28px' }}>
        <div className="vmx-row">
          <span className="vmx-lbl">대상</span>
          <label><input type="radio" name="vmx-target" checked={st.target === 'all'} onChange={() => set({ target: 'all' })} />전체 VM <b>{fmtN(status.vmTotal)}대</b></label>
          <label><input type="radio" name="vmx-target" checked={st.target === 'on'} onChange={() => set({ target: 'on' })} />켜진 VM 만 <b>{fmtN(status.vmOn)}대</b></label>
          <label><input type="radio" name="vmx-target" checked={st.target === 'folder'} onChange={() => set({ target: 'folder' })} disabled={!folders.length} />폴더 고르기</label>
          {st.target === 'folder' && (
            <Select sort={false} className="input" aria-label="폴더" value={st.folder} onChange={(e) => set({ folder: e.target.value })} style={{ maxWidth: 340, minWidth: 0 }}>
              <option value="">폴더를 고르세요</option>
              {folders.map((f) => <option key={f.path} value={f.path}>{`${'  '.repeat(f.depth - 1)}${f.path} (하위 포함 ${f.count}대)`}</option>)}
            </Select>
          )}
          <label className="vmx-lbl"><input type="checkbox" checked={st.tmpl} onChange={() => set({ tmpl: !st.tmpl })} />템플릿 포함</label>
        </div>
        <div className="vmx-row">
          <span className="vmx-lbl">형식</span>
          <label><input type="radio" name="vmx-fmt" checked={st.fmt === 'csv'} onChange={() => set({ fmt: 'csv' })} />CSV</label>
          <label><input type="radio" name="vmx-fmt" checked={st.fmt === 'xlsx'} onChange={() => set({ fmt: 'xlsx' })} />엑셀(데이터 · 읽는 법)</label>
        </div>
        <div className="vmx-row" style={{ marginLeft: 'auto' }}>
          <span className="vmx-lbl">실시간 보강</span>
          <div className="vmx-seg" role="group" aria-label="실시간 보강">
            <button type="button" aria-pressed={st.live} onClick={() => set({ live: true })}>켜기 — NIC · UUID · 생성일 · 디스크 파일</button>
            <button type="button" aria-pressed={!st.live} onClick={() => set({ live: false })}>끄기 — 캐시만(빠름)</button>
          </div>
        </div>
      </div>

      {/* 빠른 조합 · 내 저장값 */}
      <div className="vmx-card vmx-deep">
        <div className="vmx-row" style={{ gap: '6px 8px' }}>
          <span className="vmx-lbl" style={{ marginRight: 6 }}>빠른 조합</span>
          {cat.presets.map((p) => (
            <button key={p.id} type="button" className={`vmx-pill${presetOn(p) ? ' on' : ''}`} aria-pressed={presetOn(p)} onClick={() => { set({ cols: [...p.keys] }); setPrefName(''); }}>
              {p.name}<span className="n">{p.keys.length}</span>
            </button>
          ))}
        </div>
        <div className="vmx-sep" />
        <div className="vmx-row" style={{ gap: '6px 8px' }}>
          <span className="vmx-lbl" style={{ marginRight: 6 }}>내 저장값</span>
          {Array.from({ length: SLOT_COUNT }, (_, i) => {
            const s = prefs?.slots?.[i]; const l = slotLabel(s, i); const isDef = prefs?.def?.from === i + 1;
            return (
              <button key={i} type="button" className={`vmx-slot${l.empty ? ' empty' : ''}`} disabled={l.empty}
                title={l.empty ? '비어 있음 — 지금 설정 저장하기로 채웁니다' : `${l.cols}개 항목 · 눌러서 불러오기`}
                onClick={() => { setSt((x) => applyValue(x, s)); setPrefName(l.name); setMsg({ ok: true, text: `${i + 1}번 ‘${l.name}’ 을 불러왔습니다(${l.cols}개 항목${s?.droppedCols ? ` · 없어진 항목 ${s.droppedCols}개 뺌` : ''}).` }); }}>
                <span className="no">{l.no}</span>{l.name}{isDef && <span className="def">기본</span>}
              </button>
            );
          })}
          <span className="vmx-row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button type="button" className="vmx-btn green" disabled={!st.cols.length || busy === 'save' || prefs?.unreadable}
              onClick={() => putPref('default', valueToSave(st, { fmt: true, view: true, live: true, target: true }, '기본값'))}>지금 설정을 기본값으로</button>
            <button type="button" className={`vmx-btn${save ? ' primary' : ''}`} disabled={!st.cols.length || prefs?.unreadable} onClick={() => (save ? setSave(null) : openSave())}>지금 설정 저장하기…</button>
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{prefs?.unreadable ? '저장값 파일을 읽지 못해 저장할 수 없습니다(손상 사본은 설정 폴더에 남았습니다).' : defaultLine(prefs)}</div>
        {save && (
          <div className="vmx-save">
            <div className="col">
              <b style={{ fontSize: 12.5 }}>어느 칸에</b>
              <div className="nums">
                {Array.from({ length: SLOT_COUNT }, (_, i) => (
                  <button key={i} type="button" aria-label={`${i + 1}번 칸`} aria-pressed={save.slot === i + 1} className={`vmx-btn${save.slot === i + 1 ? ' primary' : ''}`} onClick={() => pickSlot(i + 1)}>{i + 1}</button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 11.5 }}>{slotTarget ? `${save.slot}번 ‘${slotTarget.name}’ 을 덮어씁니다` : `${save.slot}번은 비어 있습니다`}</span>
            </div>
            <label className="col">
              <b style={{ fontSize: 12.5 }}>이름</b>
              <input className="input" value={save.name} maxLength={NAME_MAX} onChange={(e) => setSave((s) => ({ ...s, name: e.target.value }))} style={{ width: 220, maxWidth: '100%' }} />
            </label>
            <div className="col">
              <b style={{ fontSize: 12.5 }}>저장할 내용</b>
              <div className="vmx-row" style={{ gap: '4px 14px' }}>
                {SAVE_WHAT.map(([k, label, fixed]) => (
                  <label key={k} className={fixed ? 'vmx-lbl' : ''}>
                    <input type="checkbox" checked={fixed || !!save.what[k]} disabled={fixed} onChange={() => setSave((s) => ({ ...s, what: { ...s.what, [k]: !s.what[k] } }))} />{label}
                  </label>
                ))}
              </div>
              <label style={{ color: '#86efac' }}>
                <input type="checkbox" checked={save.alsoDefault} onChange={() => setSave((s) => ({ ...s, alsoDefault: !s.alsoDefault }))} />이 칸을 기본값으로도 쓰기(화면을 열면 이것으로 시작)
              </label>
            </div>
            <span className="vmx-row" style={{ marginLeft: 'auto', gap: 8 }}>
              <button type="button" className="vmx-btn" onClick={() => setSave(null)}>취소</button>
              <button type="button" className="vmx-btn primary" disabled={busy === 'save'}
                onClick={async () => { if (await putPref(save.slot, valueToSave(st, save.what, save.name), save.alsoDefault)) setSave(null); }}>
                {slotTarget ? `${save.slot}번에 덮어쓰기` : `${save.slot}번에 저장`}
              </button>
            </span>
          </div>
        )}
      </div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      {/* 본문 — 왼쪽 항목 · 오른쪽 고른 항목·미리보기 */}
      <div className="vmx-body">
        <div className="vmx-left">
          <div className="vmx-row" style={{ gap: 8 }}>
            <label className="vmx-search">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: 'var(--text-dim)' }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="항목 찾기 — 예: MAC, 태그, 파티션, UUID" aria-label="항목 찾기" />
            </label>
            <span className="muted" style={{ fontSize: 12 }}>전체 {itemOf.size}개 항목 · 새 항목 {[...itemOf.values()].filter((it) => it.isNew).length}개</span>
          </div>
          <div className="vmx-legend">
            <span><b style={{ color: TONE.ok.color }}>항상</b> 30초 인벤토리</span>
            <span><b style={{ color: TONE.cache.color }}>캐시</b> 주기 수집(구성 · 장치 · 태그)</span>
            <span><b style={{ color: TONE.live.color }}>실시간</b> 내려받을 때 vCenter 에 한 번 조회</span>
            <span><b style={{ color: TONE.opt.color }}>수집 켜야 함</b> 게스트 파티션</span>
            <span>모으지 못한 값은 파일에 ‘{cat.missingText}’ · 못 읽은 값은 빈칸</span>
          </div>
          {cat.groups.map((g) => {
            const items = g.items.filter((it) => !ql || it.label.toLowerCase().includes(ql) || g.name.toLowerCase().includes(ql) || it.key.toLowerCase().includes(ql));
            if (!items.length) return null;
            const keys = g.items.map((it) => it.key); const n = keys.filter((k) => st.cols.includes(k)).length;
            const isOpen = !!ql || open.has(g.id);
            return (
              <div key={g.id} className={`vmx-grp${isOpen ? ' open' : ''}`}>
                <div className="vmx-grp-h">
                  <button type="button" className="tog" aria-expanded={isOpen} onClick={() => toggleGroup(g.id)}>
                    <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{g.name}
                    {g.isNew && <span className="vmx-new">새 묶음</span>}
                    <span className="cnt">{n} / {keys.length}</span>
                  </button>
                  <span className="vmx-row" style={{ marginLeft: 'auto', gap: 6 }}>
                    <button type="button" className="vmx-btn small" onClick={() => set({ cols: addCols(st.cols, keys) })}>모두</button>
                    <button type="button" className="vmx-btn small" onClick={() => set({ cols: dropCols(st.cols, keys) })}>해제</button>
                  </span>
                </div>
                {isOpen && (
                  <>
                    <div className="vmx-items">
                      {items.map((it) => {
                        const on = st.cols.includes(it.key);
                        return (
                          <label key={it.key} className={`vmx-item${on ? ' on' : ''}`}>
                            <input type="checkbox" checked={on} onChange={() => set({ cols: toggleCol(st.cols, it.key) })} />
                            <span className="l">{it.label}{it.isNew && <span className="nw">새</span>}</span>
                            <Badge b={badgeOf(it, status, st.live)} />
                          </label>
                        );
                      })}
                    </div>
                    {g.note && <div className="vmx-note">{g.note}</div>}
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="vmx-right">
          <div className="vmx-card">
            <div className="vmx-row" style={{ alignItems: 'baseline', gap: '4px 10px', marginBottom: 8 }}>
              <b>고른 항목 {st.cols.length}개{pv?.head ? ` → ${pv.head.length}열` : ''}</b>
              <span className="muted" style={{ fontSize: 12 }}>이 순서대로 열이 됩니다 · 끌어서 순서(← → 키) · × 로 빼기</span>
            </div>
            <div className="vmx-chips">
              {st.cols.map((k) => (
                <span key={k} className={`vmx-chip${drag.from === k ? ' drag' : ''}${drag.over === k && drag.from !== k ? ' over' : ''}`} draggable tabIndex={0}
                  aria-label={`${itemOf.get(k)?.label || k} — 화살표로 순서 · Delete 로 빼기`}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDrag({ from: k, over: '' }); }}
                  onDragOver={(e) => { e.preventDefault(); if (drag.over !== k) setDrag((d) => ({ ...d, over: k })); }}
                  onDrop={(e) => { e.preventDefault(); set({ cols: dropCol(st.cols, drag.from, k) }); setDrag({ from: '', over: '' }); }}
                  onDragEnd={() => setDrag({ from: '', over: '' })}
                  onKeyDown={(e) => chipKey(e, k)}>
                  <span className="h" aria-hidden="true">⋮⋮</span>
                  <span className="lbl">{itemOf.get(k)?.label || k}</span>
                  <button type="button" className="x" aria-label="빼기" onClick={() => set({ cols: toggleCol(st.cols, k) })}>×</button>
                </span>
              ))}
              {!st.cols.length && <span className="muted">아직 고른 항목이 없습니다 — 왼쪽에서 고르거나 빠른 조합을 누르세요.</span>}
            </div>
          </div>

          <div className="vmx-card">
            <div className="vmx-row" style={{ alignItems: 'baseline', gap: '4px 10px', marginBottom: 8 }}>
              <b>미리보기</b>
              <span className="muted" style={{ fontSize: 12 }}>대상 첫 3대 · 내려받는 파일과 같은 값 · 실시간 항목은 내려받을 때 조회</span>
              <button type="button" className="vmx-btn" style={{ marginLeft: 'auto' }} disabled={!st.cols.length || (st.target === 'folder' && !st.folder)} onClick={() => setBig(true)}
                title={`대상 첫 ${PREVIEW_BIG}대를 화면 가득 봅니다`}>⤢ 크게 보기</button>
            </div>
            {pv?.error ? <div className="banner warn">{pv.error}</div>
              : !pv ? <div className="muted" style={{ fontSize: 12 }}>{st.cols.length ? (st.target === 'folder' && !st.folder ? '폴더를 고르면 보입니다.' : '미리보기를 만드는 중…') : '항목을 고르면 보입니다.'}</div>
                : !pv.cells.length ? <div className="muted" style={{ fontSize: 12 }}>대상에 VM 이 없습니다.</div> : (
                  <div className="vmx-pv">
                    <STable minWidth={Math.max(360, pv.head.length * 110)}>
                      <thead><tr>{pv.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                      <tbody>{pv.cells.map((row, ri) => (
                        <tr key={ri}>{row.map((c, ci) => <td key={ci} className={cellKind(c)} title={String(c ?? '')}>{String(c ?? '')}</td>)}</tr>
                      ))}</tbody>
                    </STable>
                  </div>
                )}
          </div>

          <div className="vmx-card vmx-deep" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <b style={{ fontSize: 12.5 }}>표기 방식</b>
            <label className="vmx-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="radio" name="vmx-disk" checked={st.disk === 'slots'} onChange={() => set({ disk: 'slots' })} /><span>디스크는 1~7번 슬롯 열(슬롯당 용량 · 타입 · 모드 · 데이터스토어 · 파일) <span className="muted">— 예전과 같음</span></span></label>
            <label className="vmx-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="radio" name="vmx-disk" checked={st.disk === 'join'} onChange={() => set({ disk: 'join' })} /><span>디스크는 한 칸에 ‘ ; ’ 로 이어 쓰기 <span className="muted">— 열이 35개 줄어듦</span></span></label>
            <label className="vmx-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}><input type="checkbox" checked={st.tagCols} onChange={() => set({ tagCols: !st.tagCols })} /><span>vSphere 태그는 카테고리마다 따로 열(‘태그: 환경’ · ‘태그: 서비스’ …)</span></label>
            {/* v2.801 '여부' 기준 일수 — 최근 N일 Veeam 백업 · 백업용 스냅샷 생성(서버 YN_DAYS — 카탈로그가 준다) */}
            <div className="vmx-row" style={{ gap: '6px 8px', alignItems: 'center' }} role="group" aria-label="‘여부’ 기준 일수">
              <span>‘여부’ 기준</span>
              {(cat.ynDays || []).map((d) => (
                <button key={d} type="button" className={`vmx-pill${st.ynDays === d ? ' on' : ''}`} aria-pressed={st.ynDays === d} onClick={() => set({ ynDays: d })}>{d}일</button>
              ))}
              <span className="muted" style={{ fontSize: 12 }}>— 최근 N일 Veeam 백업 · 백업용 스냅샷 생성 여부(예 · 아니오 · 모름)</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>시각은 포탈 시각(KST, UTC+9)으로 쓰고 머리에 표기합니다 — 예전 파일은 UTC(…Z)였습니다.</div>
          </div>
        </div>
      </div>

      {/* 아래 막대 */}
      <div className="vmx-foot">
        <span className="sum">
          <b>{footerText({ items: st.cols.length, colsCount: pv?.head?.length ?? null, rows })}</b>
          {missLive > 0
            ? <span className="warn">실시간 항목 {missLive}개는 {st.live ? '이 vCenter 에서' : '실시간 보강을 꺼서'} ‘{cat.missingText}’</span>
            : <span className="muted">{st.live && status.live?.state === 'ok' ? `실시간 보강 켜짐 · 내려받을 때 ${cat.status?.vcenterName || scope} 에 한 번 로그인합니다` : '캐시 값으로 만듭니다'}</span>}
        </span>
        <span className="acts">
          <button type="button" className="vmx-btn" disabled={!st.cols.length} onClick={() => { set({ cols: [] }); setPrefName(''); }}>고른 항목 비우기</button>
          <button type="button" className="vmx-btn primary" disabled={!canDownload} onClick={download}>
            {busy === 'down' ? '만드는 중…' : `⤓ ${st.fmt === 'xlsx' ? '엑셀' : 'CSV'} 내려받기`}
          </button>
        </span>
      </div>
      {big && (
        <ExportPreviewModal
          title={`미리보기 — ${status.vcenterName || scope}`}
          sub={`대상 첫 ${PREVIEW_BIG}대까지 · 고른 항목 ${st.cols.length}개 · 내려받는 파일과 같은 값 · 실시간 항목은 내려받을 때 조회`}
          load={() => postJson(`/tools/vm-export/preview?vcenterId=${encodeURIComponent(scope)}`, { ...exportBody(st), rows: PREVIEW_BIG })}
          groupName={(g) => (cat.groups || []).find((x) => x.id === g)?.name || g}
          onDownload={download} downloadDisabled={!canDownload} downloadLabel={busy === 'down' ? '만드는 중…' : `⤓ ${st.fmt === 'xlsx' ? '엑셀' : 'CSV'} 내려받기`}
          onClose={() => setBig(false)}
        />
      )}
    </div>
  );
}
