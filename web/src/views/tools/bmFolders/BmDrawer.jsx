/**
 * 물리서버 상세 드로어(v3.44 · 시안 docs/design/bm-drawer · 사용자 컨펌 '드로어 기본값대로').
 *   예전 400px 옆 패널(SidePanel.jsx · HwPanel.jsx)을 바꾼 것 — VM · 호스트 드로어와 같은 뼈대(.vmh-drawer · vms/vmHub.css)다.
 *   **옆 패널의 값 · 동작은 빠짐없이 옮긴다**: 상태 점 · 법인/폴더/모델/태그/종류 · 전원 · 사용률(값 없음 사유) · 전력 · 용량 · 받는 길 · 부품 장애 ·
 *   하드웨어(iDRAC 주소 접속 · OS · 요약 · iDRAC 모델/펌웨어 · 인벤토리 나이 · 부품 6종 · 관리 NIC IPv4) · 24시간 추이 · 폴더 옮기기/넣기/빼기 · 바로가기 4개.
 *   달라진 것: 폭 640 · 화면 높이 전체 · 뒤 화면 가림 · ‹ › 와 ↑↓ 로 표에 보이는 순서대로 이전/다음 서버 · 폴더 옮기기는 단추 줄 ·
 *   신호(행에 이미 있는 값 — 새 판정 없음 · drawerText.js) · 바로가기는 바닥 줄에 고정.
 * ⚠ 판정은 서버가 한다 — 여기는 그리기만(글자 · 배치는 drawerText.js · 하드웨어 글자는 hwText.js · 사유 글자는 whyText.js).
 * ⚠ 열 때 1건씩만 묻는다(/hw · /trend — 폴링 없음). ‹ › 로 넘기는 동안은 잠깐 기다렸다 묻고, 늦게 온 이전 응답은 버린다.
 * ⚠ 훅은 전부 조기 return 위(React #310 사고 규약).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../../api.js';
import Select from '../../../components/Select.jsx';
import EscClose from '../../../components/EscClose.jsx';
import { StatusDot, SrcBadge, SrcChip, WhyTip } from './parts.jsx';
import { pathText, opErrorText, ageText } from '../bmFoldersText.js';
import { SRC_COLOR } from './usageSrc.js';
import { osText, hwWhyText, OS_WHY } from './hwText.js';
import { IdracConnect } from './IdracConnect.jsx';
import { WarrantySection, FwBiosSections } from './CheckSections.jsx';   // v3.45 물리서버 점검(보증 · 펌웨어 기준선 · BIOS 편차)
import { PeerSection } from './PeerSection.jsx';   // v3.47 같은 묶음 대비
import { useBoxWidth } from './useBoxWidth.js';
import { unitText } from '../../unitText.js';
import { usageTone, TONE_COLOR, TONE_TEXT } from '../../vms/vmHubText.js';
import {
  rowTone, rowDotTitle, noUsage, powerText, bmSignalRows, bmUnknowns, noSignalText, neighborOfKey, freshNote, bmTiles, bmKvRows, specCells, partGroups, trendView,
  SIG_BADGE, SIG_DOT,
} from './drawerText.js';
import '../../vms/vmHub.css';

const FETCH_DELAY_MS = 350;   // ‹ › 로 넘기는 동안은 묻지 않는다(지나친 서버마다 엣지 왕복이 생기지 않게) — 처음 열 때는 바로 묻는다
const HW_WHY = {
  'summary-only': '엣지가 보낸 요약만 있습니다 — 엣지는 부품별 목록을 중앙으로 보내지 않습니다(부품별 목록은 그 엣지의 iDRAC 인벤토리 화면에서 봅니다).',
  'edge-none': '엣지가 하드웨어 요약을 보내지 않았습니다 — 엣지가 이 버전보다 낮거나, 그 엣지의 iDRAC 등록부 밖 서버(OME 등)이거나, 엣지가 인벤토리를 아직 읽지 못한 경우입니다.',
  'no-inv': 'iDRAC 인벤토리를 아직 읽지 못했습니다 — 등록 직후 · 수집 전 · OME 로만 보이는 서버 · 수집 서버가 아직 보내지 않은 경우 비어 있습니다.',
};
const TREND_WHY = {
  esxi: 'ESXi 호스트의 추이는 호스트 화면에서 봅니다.',
  none: '이 기간에 쌓인 사용률 값이 없습니다(수집이 꺼져 있었거나 못 읽었을 수 있습니다).',
  'no-key': '사용률 대상 키가 없습니다.',
  'no-target': '베어메탈 사용률 수집 대상이 아닙니다(특수 기능 › 베어메탈 사용률에서 그 법인 수집을 켜야 추이가 쌓입니다).',
  'old-version': '이 서버를 수집하는 엣지가 구버전이라 추이를 받지 못했습니다(엣지 업그레이드 뒤 보입니다).',
  'edge-fail': '이 서버를 수집하는 엣지에서 추이를 받지 못했습니다(잠시 뒤 다시 열어 보십시오).',
};
const VIA_TEXT = { edge: '엣지 요약', remote: '수집 서버' };

/**
 * 서버 한 대에 딸린 조회 1건 — 키가 바뀌면 다시 묻되, 넘기는 동안은 잠깐 기다린다. 응답은 물은 키에만 넣는다(늦게 온 이전 응답 버림).
 * @returns {{ d: object|null, err: string, stale: boolean }} d 가 null 이고 err 가 '' 이면 읽는 중 ·
 *   stale = 같은 서버인데 묻는 값(params — 목록 세대 등)이 바뀌어 다시 묻는 중(d 는 이전 값 — 쓰는 쪽이 보일지 정한다. 반증 B3)
 */
function useOnce(path, key, params, enabled) {
  const [st, setSt] = useState({ key: '', sig: '', d: null, err: '' });
  const first = useRef(true);
  const sig = JSON.stringify(params || {});
  useEffect(() => {
    if (!enabled || !key) return undefined;
    let alive = true;
    const delay = first.current ? 0 : FETCH_DELAY_MS;
    first.current = false;
    const t = setTimeout(() => {
      fetchJson(path, { key, ...JSON.parse(sig) })
        .then((x) => { if (alive) setSt({ key, sig, d: x, err: '' }); })
        .catch((e) => { if (alive) setSt({ key, sig, d: null, err: opErrorText(e) }); });
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [path, key, sig, enabled]);
  return st.key === key ? { ...st, stale: st.sig !== sig } : { key, d: null, err: '', stale: false };
}

/** 드로어 위에 모달(포탈 공용 Modal — 웹 SSH 창)이 떠 있는가. 그동안 드로어는 키 · 포커스를 가져가지 않는다. */
const modalAbove = () => typeof document !== 'undefined' && !!document.querySelector('.modal-overlay');

/**
 * @param note  호출부의 쓰기 결과 알림({ ok, warn, text }) — 호출부는 본문 위 카드에 그리는데 그 자리는 가림막 뒤다(좁은 화면은 화면 밖).
 *              드로어가 열린 뒤 · 서버를 넘긴 뒤에 **새로 온 것만** 단추 줄 아래에 보인다(반증 A6 — 실패가 드로어 안에서 보이지 않았다).
 */
export default function BmDrawer({ r, rows, corps, corpName, scoped, op, busy, onClose, onMove, note = null, admin = false, gen = '', onChanged = null }) {
  const rootRef = useRef(null);
  const backRef = useRef(null);
  const bodyRef = useRef(null);
  const lastIdx = useRef(-1);        // 이 서버가 목록에서 방금까지 있던 자리(넣기 · 옮기기로 목록에서 빠져도 ‹ › 를 이어 간다)
  // 열 때 · 넘길 때 이미 있던 알림은 이 서버 것이 아니다. ⚠ 렌더 중에 키로 갈아 낀다 — effect 에서 바꾸면 넘긴 첫 렌더에 이전 서버의 알림이 그려지고
  //   (ref 는 다시 그리게 하지 않으므로) 다음 렌더까지 남는다.
  const seen = useRef({ key: r?.key, note });
  if (seen.current.key !== r?.key) seen.current = { key: r?.key, note };
  const keyRef = useRef(null);       // 창 키 리스너가 부르는 지금 렌더의 처리기(아래 onKey)
  keyRef.current = null;
  const [to, setTo] = useState('');
  const isBm = r?.kind === 'bm';
  const hw = useOnce('/tools/bm-folders/hw', r?.key || '', null, !!r && isBm);
  const trend = useOnce('/tools/bm-folders/trend', r?.key || '', { hours: 24 }, !!r && isBm);
  // v3.45 물리서버 점검(보증 · 펌웨어 기준선 · BIOS 편차) — 열 때 1건. 보증은 ESXi 행에도 있다(같은 물리 박스). 기준을 지정하면 n 을 올려 다시 묻는다
  const [chkRev, setChkRev] = useState(0);
  const [baseBusy, setBaseBusy] = useState(false);
  const [baseNote, setBaseNote] = useState(null);   // { key(서버), ok, text } — 그 서버의 결과만 보인다
  //   g = 목록의 세대(호출부가 준다) — 드로어에서 폴더에 넣기 · 빼기를 하면 목록이 다시 읽히고, 그때 점검도 다시 묻는다
  //   (반증 B1: 폴더에 넣은 뒤에도 BIOS 구역이 ‘미분류 — 판정 안 함’ 그대로였다. 묶음은 배치로 정해진다).
  const chk = useOnce('/tools/bm-folders/check', r?.key || '', { n: chkRev, g: gen }, !!r);
  // v3.47 같은 묶음 대비 — 열 때 1건(베어메탈 행만). 묶음은 배치(폴더)로 정해지므로 목록 세대가 바뀌면 다시 묻는다(점검과 같은 이유)
  const peer = useOnce('/tools/bm-folders/peer', r?.key || '', { g: gen }, !!r && isBm);
  // 열 때 포커스를 드로어로(키보드 ↑↓ · Esc) · 닫을 때 원래 자리로
  useEffect(() => {
    backRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { try { backRef.current?.focus?.({ preventScroll: true }); } catch { /* 사라진 요소 */ } };
  }, []);
  // 다른 서버로 넘어가면 고르던 폴더를 비우고 본문을 맨 위로
  useEffect(() => { setTo(''); if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [r?.key]);
  // ↑↓ 는 **창**에서 듣는다(EscClose 와 같은 방식) — 드로어 요소의 onKeyDown 으로 들으면 ① React 이벤트가 포털을 넘어 올라와 웹 SSH 창 안의 키가
  //   서버를 넘겼고(반증 A1) ② 포커스가 body 로 빠지면(잠긴 단추 · 닫힌 창) 키가 죽었다(A3). 무엇을 넘길지는 아래 onKey 가 가른다.
  useEffect(() => {
    const h = (e) => keyRef.current?.(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  // 누른 단추가 잠기면(끝 서버의 ‹ › · 옮긴 뒤의 '옮기기') 포커스가 body 로 빠진다 — Tab 이 가림막 뒤 화면에서 시작하지 않게 드로어로 되돌린다(반증 A3).
  //   body 일 때만(드로어 밖에서 포커스를 쓰는 것은 건드리지 않는다) · 드로어 위에 모달(웹 SSH 창)이 떠 있으면 가져오지 않는다.
  useEffect(() => {
    if (typeof document === 'undefined' || modalAbove()) return;
    const a = document.activeElement;
    if (!a || a === document.body) rootRef.current?.focus({ preventScroll: true });
  });
  if (!r) return null;

  const corp = (corps || []).find((c) => c.vcenterId === r.corp) || null;
  const writable = !!corp?.writable;
  const folders = (corp?.folders || []).map((f) => f.path).filter((p) => !(r.place && p === r.path));
  const nb = neighborOfKey(rows, r.key, lastIdx.current);
  if (nb.index >= 0) lastIdx.current = nb.index;
  const sigs = bmSignalRows(r);
  const addr = hw.d?.addr || r.addr || '';
  const opNote = freshNote(note, seen.current.note);
  const move = (x) => { if (x) onMove(x.key); };
  // 펌웨어 기준 지정 · 해제 — 전 법인의 같은 모델에 적용되는 값이다(서버가 조회 ∧ 쓰기 전체 범위 관리자만 받는다). 성공하면 점검을 다시 묻는다
  const onBaseline = async (row, version) => {
    const model = chk.d?.model || '';
    if (!model || !row?.key) return;
    setBaseBusy(true); setBaseNote(null);
    try {
      const x = await postJson('/admin/bm-fw-baseline', { model, key: row.key, label: row.label, type: row.type, version });
      if (!x || x.ok === false) throw new Error(x?.reason || '요청을 처리하지 못했습니다.');
      setBaseNote({ key: r.key, ok: true, text: version ? `‘${row.label}’ 기준을 ${version} 로 지정했습니다(모델 ${model}).` : `‘${row.label}’ 기준 지정을 해제했습니다 — 다수 버전으로 다시 대조합니다.` });
      setChkRev((n) => n + 1);
      // 기준은 전 법인의 같은 모델에 걸린다 — 목록(칩 · 머리 배지 · 신호가 쓰는 행 값)도 다시 읽는다(반증 B2: 구역은 ‘뒤처진 것 없음’ 인데 머리 배지는 ‘펌웨어 뒤처짐 1’ 이었다)
      try { onChanged?.(); } catch { /* 목록 다시 읽기 실패는 호출부가 알린다 */ }
    } catch (e) { setBaseNote({ key: r.key, ok: false, text: opErrorText(e) }); }
    finally { setBaseBusy(false); }
  };
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (modalAbove()) return;   // 드로어 위에 모달(웹 SSH 창)이 떠 있는 동안은 드로어 키가 아니다 — 넘기면 창의 접속 대상과 화면이 어긋난다(반증 A1 실측)
    const el = e.target;
    const root = rootRef.current;
    const inside = !!root && !!el && typeof el.nodeType === 'number' && root.contains(el);
    // 드로어 **DOM 안**에서 난 키, 또는 포커스가 어디에도 없을 때(body)의 키만 — 그 밖의 요소(포털로 그린 창 등)에서 난 키는 넘기지 않는다
    if (!inside && el !== document.body) return;
    // 열린 상자(접속 · 사유) 안의 키도 넘기지 않는다
    if (inside && typeof el.closest === 'function' && el.closest('.bmf-idc-pop, .bmf-why-pop')) return;
    const tag = String(el?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowDown' && nb.next) { e.preventDefault(); move(nb.next); }
    else if (e.key === 'ArrowUp' && nb.prev) { e.preventDefault(); move(nb.prev); }
  };
  keyRef.current = onKey;

  return (
    <>
      <div className="vmh-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={rootRef} className="vmh-drawer" role="dialog" aria-modal="true" aria-label={`서버 상세 — ${r.name}`} tabIndex={-1}>
        <EscClose onClose={onClose} />
        <div className="vmh-dh">
          <div className="ttl">
            <StatusDot tone={rowTone(r)} title={rowDotTitle(r)} />
            <h2 title={r.name}>{r.name}</h2>
            <span className="grow" />
            <button type="button" className="vmh-icon-btn" aria-label="이전 서버" title="이전 서버(↑)" disabled={!nb.prev} onClick={() => move(nb.prev)}>‹</button>
            <button type="button" className="vmh-icon-btn" aria-label="다음 서버" title="다음 서버(↓)" disabled={!nb.next} onClick={() => move(nb.next)}>›</button>
            <button type="button" className="vmh-icon-btn" aria-label="닫기" title="닫기(Esc)" onClick={onClose}>×</button>
          </div>
          {sigs.length > 0 && (
            <div className="vmh-sig">{sigs.map((s) => <span key={s.kind} className={`vmh-badge ${SIG_BADGE[s.tone] || 'gray'}`} title={s.fact}>{s.badge}</span>)}</div>
          )}
          <div className="vmh-crumb">
            <span className={`badge ${r.powered === true ? 'green' : 'gray'}`}>전원 {powerText(r)}</span>
            <b className="bmd-corp">{r.corp ? corpName(r.corp) : '(법인 미지정)'}</b>
            {/* 구분 글자는 뒤 항목과 한 덩어리로 줄바꿈한다(줄 끝에 › · 만 남지 않게 — 1440 · 400 Chromium 판독) */}
            <span className="bmd-seg"><span aria-hidden="true">›</span><span title={r.place ? pathText(r.path) : undefined}>{r.place ? pathText(r.path) : '(미분류)'}</span></span>
            <span className="bmd-seg"><span aria-hidden="true">·</span><span>{isBm ? '베어메탈' : 'ESXi 호스트'}</span></span>
            {r.model ? <span className="bmd-seg"><span aria-hidden="true">·</span><span>{r.model}</span></span> : null}
            {!scoped && r.serviceTag ? <span className="bmd-seg"><span aria-hidden="true">·</span><span className="mono">{r.serviceTag}</span></span> : null}
            {nb.index >= 0 ? <span className="pos">목록 {nb.index + 1}/{nb.total}</span>
              : nb.gone ? <span className="pos" title="지금 보기의 목록에 이 서버가 없습니다(넣기 · 옮기기 · 빼기 뒤이거나 목록이 바뀌었습니다) — ‹ › 는 있던 자리의 앞뒤 서버로 갑니다">목록에서 빠짐</span> : null}
          </div>
        </div>

        <div className="vmh-acts bmd-acts">
          {/* key = 서버 — 넘기면 접속 상자 · 웹 SSH 창의 상태를 다음 서버가 물려받지 않는다(반증 A7) */}
          {isBm && addr && !scoped ? <IdracConnect key={r.key} addr={addr} name={r.name} corp={r.corp} button /> : null}
          <span className="bmd-grow" />
          {writable && r.corp ? (
            <>
              <Select className="select bmd-sel" value={to} onChange={(e) => setTo(e.target.value)} aria-label={r.place ? '옮길 폴더' : '넣을 폴더'}>
                <option value="">{r.place ? '옮길 폴더…' : '넣을 폴더…'}</option>
                {folders.map((p) => <option key={p} value={p}>{pathText(p)}</option>)}
              </Select>
              <button type="button" className="login-btn bmd-btn" disabled={busy || !to} onClick={async () => {
                const ok = await op({ op: 'assign', corp: r.corp, path: to, keys: [r.key], moveExisting: true, createMissing: false }, `‘${r.name}’ 을(를) ‘${pathText(to)}’ 에 넣었습니다.`);
                if (ok) setTo('');
              }}>{r.place ? '옮기기' : '넣기'}</button>
              {r.place === 'manual' ? <button type="button" className="logout-btn bmd-btn" disabled={busy} onClick={() => op({ op: 'unassign', keys: [r.key] }, `‘${r.name}’ 을(를) 폴더에서 뺐습니다.`)}>폴더에서 빼기</button> : null}
            </>
          ) : (
            <span className="muted bmd-ro">{!r.corp ? '법인을 몰라 폴더에 넣을 수 없습니다.' : '이 법인은 조회 전용입니다 — 폴더를 옮기거나 뺄 수 없습니다.'}</span>
          )}
        </div>

        {opNote ? <div className={`bmd-opnote${opNote.ok && !opNote.warn ? ' ok' : ' bad'}`} role={opNote.ok ? 'status' : 'alert'}>{opNote.text}</div> : null}

        <div className="vmh-db bmd-db" ref={bodyRef}>
          <DrawerSections r={r} hw={hw} trend={trend} corpName={corpName} scoped={scoped} onClose={onClose}
            afterTrend={<PeerSection r={r} peer={peer} />}
            afterIdent={<WarrantySection chk={chk} admin={admin && !scoped} />}
            afterSpec={<FwBiosSections r={r} chk={chk} onBaseline={onBaseline} busy={baseBusy} baseNote={baseNote && baseNote.key === r.key ? baseNote : null} />} />
        </div>

        <nav className="vmh-df" aria-label="바로가기">
          <span className="muted">바로가기:</span>
          <a href="#/tools/bm-usage" onClick={onClose}>베어메탈 사용률(추이)</a>
          <a href="#/tools/part-faults" onClick={onClose}>물리 부품 장애</a>
          <a href="#/tools/fleet" onClick={onClose}>통합 서버 인벤토리</a>
          <a href="#/tools/svc-inventory" onClick={onClose}>서비스 인벤토리</a>
          <span className="muted-key">Esc 닫기 · ↑↓ 이전/다음 서버</span>
        </nav>
      </aside>
    </>
  );
}

/**
 * 드로어 본문 구역(한눈에 → 추이 → 신호 → 식별 · 배치 → iDRAC · 관리 → 하드웨어 요약 → 부품 목록) — 응답 상태를 받아 그리기만 한다.
 * @param hw     { d, err } — /tools/bm-folders/hw(읽는 중이면 d null · err '')
 * @param trend  { d, err } — /tools/bm-folders/trend
 */
export function DrawerSections({ r, hw, trend, corpName, scoped, onClose, now, afterTrend = null, afterIdent = null, afterSpec = null }) {
  const isBm = r.kind === 'bm';
  const at = now ?? Date.now();   // 나이 글자의 기준 시각(시험이 넣어 볼 수 있게 — 기본은 지금)
  const sigs = bmSignalRows(r, at);
  const unknowns = bmUnknowns(r);
  const tiles = bmTiles(r);
  const kv = bmKvRows(r, { corpName, scoped });
  const none = noUsage(r);
  const d = hw.d;
  const det = d?.detail || null;
  // 요약: 방금 받은 응답이 먼저 — 응답이 '인벤토리 없음' 이면 목록 행의 예전 요약을 내세우지 않는다(반증 A11: 위에는 값 · 아래에는 '위의 이유와 같다').
  //   응답을 받기 전 · 조회 실패일 때만 목록 행의 요약(같은 출처의 값)을 쓴다.
  const sum = d ? (det?.summary || d.summary || null) : (r.hw || null);
  const os = osText(det?.os || sum?.os);
  const osHost = det?.os?.host || sum?.host || '';
  const addr = d?.addr || r.addr || '';
  const cells = specCells(sum, det);
  const groups = partGroups(det);
  const barColor = (t) => (t.src && SRC_COLOR[t.src] ? SRC_COLOR[t.src] : TONE_COLOR[usageTone(t.pct)]);
  const usageTile = (label, t) => (
    <div className="vmh-dtile">
      <span className="lb bmd-lb">{label}{t.src ? <SrcChip src={t.src} /> : null}</span>
      <span className="v" style={{ color: TONE_TEXT[usageTone(t.pct)] }}>{t.pct == null ? '—' : <>{Math.round(t.pct)}<small>%</small></>}</span>
      {t.pct == null ? null : <span className="vmh-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, t.pct))}%`, background: barColor(t) }} /></span>}
      <span className="s">{t.sub}</span>
    </div>
  );
  return (
    <>
      <section className="vmh-sec" aria-label="한눈에">
        <div className="sh"><h3>한눈에 · 지금 값</h3><span className="muted">못 읽은 값은 ‘—’ 와 사유</span></div>
        <div className="vmh-dtiles">
          {none && r.why?.code ? (
            <div className="vmh-dtile bmd-tile2">
              <span className="lb">CPU · 메모리 사용률</span>
              <WhyTip key={r.key} why={r.why} what="CPU · 메모리 사용률" />
              <span className="s wrap">{tiles.usage.cap} — 사유를 누르면 자세히</span>
            </div>
          ) : (<>{usageTile('CPU', tiles.cpu)}{usageTile('메모리', tiles.mem)}</>)}
          <div className="vmh-dtile">
            <span className="lb">전력</span>
            <span className="v">{tiles.power.watts == null ? '—' : <>{Math.round(tiles.power.watts).toLocaleString()}<small>W</small></>}</span>
            <span className="s">{tiles.power.sub}</span>
          </div>
          <div className="vmh-dtile" style={tiles.fault.state === 'bad' ? { borderColor: 'rgba(239,68,68,.5)' } : undefined}>
            <span className="lb">부품 장애</span>
            {tiles.fault.state === 'unread' ? <span className="v" style={{ color: 'var(--text-dim)' }}>—</span>
              : tiles.fault.state === 'bad' ? <span className="v" style={{ color: '#fca5a5' }}>{tiles.fault.n}<small>건</small></span>
                : <span className="v bmd-vtext">없음</span>}
            <span className="s wrap">{tiles.fault.state === 'unread' ? '값 없음 — 0건이 아닙니다' : tiles.fault.state === 'bad' ? <a href="#/tools/part-faults" onClick={onClose}>물리 부품 장애에서 보기</a> : '읽었고 0건'}</span>
          </div>
        </div>
      </section>

      <section className="vmh-sec" aria-label="24시간 추이">
        <div className="sh"><h3>CPU · 메모리 — 지난 24시간</h3>{isBm ? <span className="muted">{trend.d?.via === 'edge' && trend.d.rows?.length ? '이 서버를 수집하는 엣지에서 받았습니다(구간 평균)' : '열 때 1회 조회 · 구간 평균'}</span> : null}</div>
        {!isBm ? <div className="muted bmd-note">{TREND_WHY.esxi}</div>
          : trend.err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>{trend.err}</div>
            : !trend.d ? <div className="muted bmd-note">읽는 중…</div>
              : !trend.d.rows?.length || trend.d.why === 'none' ? <div className="muted bmd-note">{TREND_WHY[trend.d.why] || TREND_WHY.none}{trend.d.reason ? ` — ${trend.d.reason}` : ''}</div>
                : <TrendChart rows={trend.d.rows} />}
      </section>
      {afterTrend}

      <section className="vmh-sec" aria-label="신호">
        <div className="sh"><h3>신호 {sigs.length}{sigs.length ? ' — 봐야 할 것' : ''}</h3></div>
        {sigs.length ? (
          <div className="vmh-sigrows">
            {sigs.map((s) => (
              <div key={s.kind} className="vmh-sigrow">
                <span className={`vmh-dot${SIG_DOT[s.tone] ? '' : ' bmd-dot-none'}`} style={SIG_DOT[s.tone] ? { background: SIG_DOT[s.tone] } : undefined} aria-hidden="true" />
                <div className="t"><b>{s.label}</b><span>{s.fact}</span>{s.desc ? <span>{s.desc}</span> : null}</div>
                {s.link ? <a className="btn" style={{ flex: 'none' }} href={s.link[0]} onClick={onClose}>{s.link[1]}</a> : null}
              </div>
            ))}
          </div>
        ) : <div className="muted bmd-note">{noSignalText(r)}</div>}
        {unknowns.length ? <div className="muted bmd-note">값이 없어 판단하지 않은 것: {unknowns.join(' · ')} — 정상으로 세지 않습니다.</div> : null}
      </section>

      <section className="vmh-sec" aria-label="식별 · 배치">
        <div className="sh"><h3>식별 · 배치</h3></div>
        <div className="vmh-kv">
          {kv.map((x) => (
            <div key={x.label} className={x.full ? 'full' : undefined}>
              <span>{x.label}</span>
              <b className={x.mono ? 'mono' : undefined} style={x.muted ? { color: 'var(--text-dim)' } : undefined}>
                {x.src !== undefined ? (<><SrcBadge src={x.src} />{x.agent ? <span className="muted mono" style={{ fontSize: 11, marginLeft: 4 }}>{x.agent}</span> : null}</>) : x.value}
                {x.badge ? <span className={`badge ${x.badge === '손 등록' ? 'blue' : 'gray'}`} style={{ marginLeft: 6 }}>{x.badge}</span> : null}
                {x.note ? <span className="bmd-kvnote">{x.note}</span> : null}
              </b>
            </div>
          ))}
          {isBm ? (
            <div className="full">
              <span>OS</span>
              <b title={os.full || (sum ? OS_WHY : undefined)} style={os.full ? undefined : { color: 'var(--text-dim)' }}>{os.full || '—'}</b>
            </div>
          ) : null}
          {isBm && osHost ? <div className="full"><span>OS 호스트명</span><b className="mono">{osHost}</b></div> : null}
        </div>
        {isBm && !os.full && sum ? <div className="muted bmd-note">{OS_WHY}</div> : null}
      </section>

      {afterIdent}

      {isBm ? (
        <>
          <section className="vmh-sec" aria-label="iDRAC · 관리">
            <div className="sh"><h3>iDRAC · 관리</h3>{sum ? <span className="muted">인벤토리 {sum.at ? `${ageText(sum.at, at)} 읽음` : '—'}{d && VIA_TEXT[d.via] ? ` · ${VIA_TEXT[d.via]}` : ''}</span> : null}</div>
            <div className="vmh-kv">
              <div>
                <span>iDRAC 주소</span>
                <b>{addr ? (scoped ? <span className="mono">{addr}</span> : <IdracConnect key={r.key} addr={addr} name={r.name} corp={r.corp} />)
                  : <span className="muted" title="관리 주소는 관리자 판본에서만 보입니다(또는 이 서버의 iDRAC 주소를 모릅니다)">—</span>}</b>
              </div>
              <div><span>관리 NIC IPv4</span><b className="mono" style={det?.idrac?.ipv4 ? undefined : { color: 'var(--text-dim)' }}>{det?.idrac?.ipv4 || '—'}</b></div>
              <div><span>iDRAC 모델</span><b style={det?.idrac?.model ? undefined : { color: 'var(--text-dim)' }}>{det?.idrac?.model || '—'}</b></div>
              <div><span>iDRAC 펌웨어</span><b className="mono" style={sum?.fw || det?.idrac?.fw ? undefined : { color: 'var(--text-dim)' }}>{sum?.fw || det?.idrac?.fw || '—'}</b></div>
            </div>
            {hw.err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>{hw.err}</div> : null}
          </section>

          <section className="vmh-sec" aria-label="하드웨어 요약">
            <div className="sh"><h3>하드웨어 요약</h3><span className="muted">iDRAC 인벤토리</span></div>
            {cells ? (
              <div className="bmd-spec">
                {cells.map((c) => (
                  <div key={c.k}>
                    <span className="lb">{c.k}</span>
                    <span className={`v${c.plain ? ' plain' : ''}`} title={c.v}>{c.v}</span>
                    <span className="s" title={c.s || undefined}>{c.s || ' '}</span>
                  </div>
                ))}
              </div>
            ) : hw.err ? <div className="muted bmd-note">하드웨어 요약을 받지 못했습니다.</div>
              : !d ? <div className="muted bmd-note">읽는 중…</div>
                : <div className="muted bmd-note">{HW_WHY[d.why] || hwWhyText({ hwVia: d.via })}</div>}
          </section>

          {afterSpec}

          <section className="vmh-sec" aria-label="부품 목록">
            <div className="sh"><h3>부품 목록</h3>{groups ? <span className="muted">같은 부품은 묶어 개수로</span> : null}</div>
            {groups ? (
              <div className="bmd-parts">
                {groups.map((g) => (
                  <div key={g.k} className="bmd-pg">
                    <span className="k">{g.k}</span>
                    <div className="rows">
                      {g.rows == null ? <div className="bmd-pr"><span className="n" /><span className="m none">못 읽음</span><span className="x" /></div>
                        : !g.rows.length ? <div className="bmd-pr"><span className="n" /><span className="m none">없음</span><span className="x" /></div>
                          : g.rows.map((p, i) => (
                            <div key={i} className="bmd-pr"><span className="n">{p.n}</span><span className="m">{p.m}</span><span className="x">{p.x}</span></div>
                          ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : hw.err ? <div className="muted bmd-note">부품 목록을 받지 못했습니다.</div>
              : !d ? <div className="muted bmd-note">읽는 중…</div>
                : <div className="muted bmd-note">{d.why === 'summary-only' ? HW_WHY['summary-only'] : '부품 목록이 없습니다 — 위 하드웨어 요약의 이유와 같습니다.'}</div>}
          </section>
        </>
      ) : null}
    </>
  );
}

/** 24시간 CPU · 메모리 추이 — 못 읽은 점은 선을 끊고(0 으로 그리지 않는다) 둘 다 없는 구간은 띠로 표시한다. 폭은 칸의 실제 폭. */
function TrendChart({ rows }) {
  const boxRef = useRef(null);
  const boxW = useBoxWidth(boxRef, 578);
  const W = Math.max(200, boxW);
  const v = trendView(rows, { w: W - 40 });
  if (!v) return null;
  const H = 150;
  return (
    <div className="bmd-chart">
      <div ref={boxRef} style={{ minWidth: 0 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }} role="img"
          aria-label={`지난 24시간 CPU 마지막 ${unitText(v.lastCpu, '%')} · 메모리 마지막 ${unitText(v.lastMem, '%')}`}>
          {[[v.y100, '100%'], [v.y50, '50%'], [v.y0, '0%']].map(([y, t]) => (
            <g key={t}><line x1="0" x2={v.w} y1={y} y2={y} stroke={t === '0%' ? 'var(--border)' : 'var(--border-soft)'} strokeWidth="1" /><text x={v.w + 6} y={y + 3} fontSize="10" fill="var(--text-dim)">{t}</text></g>
          ))}
          {v.gaps.map((g) => <rect key={g.x} x={g.x} y={v.y100} width={g.w} height={v.y0 - v.y100} fill="rgba(139,155,180,.12)" />)}
          <path d={v.mem} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" />
          <path d={v.cpu} fill="none" stroke="var(--accent)" strokeWidth="2" />
          {v.ticks.map((t) => <text key={t.x} x={t.x} y={v.y0 + 16} fontSize="10" fill="var(--text-dim)" textAnchor={t.anchor}>{t.text}</text>)}
        </svg>
      </div>
      <div className="flex wrap" style={{ gap: '4px 14px', fontSize: 11.5, marginTop: 2 }}>
        <span className="bmf-lg"><i style={{ background: 'var(--accent)' }} />CPU {unitText(v.lastCpu, '%')}</span>
        <span className="bmf-lg"><i style={{ background: 'var(--accent-2)' }} />메모리 {unitText(v.lastMem, '%')}</span>
        <span className="muted">점 {v.n}개(구간 평균){v.gaps.length ? ' · 옅은 띠는 못 읽은 구간(선을 잇지 않습니다)' : ''}</span>
      </div>
    </div>
  );
}
