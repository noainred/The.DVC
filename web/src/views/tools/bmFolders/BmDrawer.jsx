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
import { fetchJson } from '../../../api.js';
import Select from '../../../components/Select.jsx';
import EscClose from '../../../components/EscClose.jsx';
import { StatusDot, SrcBadge, SrcChip, WhyTip } from './parts.jsx';
import { pathText, opErrorText, ageText } from '../bmFoldersText.js';
import { SRC_COLOR } from './usageSrc.js';
import { osText, hwWhyText, OS_WHY } from './hwText.js';
import { IdracConnect } from './IdracConnect.jsx';
import { unitText } from '../../unitText.js';
import { usageTone, TONE_COLOR, TONE_TEXT } from '../../vms/vmHubText.js';
import {
  rowTone, noUsage, powerText, bmSignalRows, neighborOfKey, bmTiles, bmKvRows, specCells, partGroups, trendView,
  SIG_BADGE, SIG_DOT, NO_SIGNAL_TEXT,
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
 * @returns {{ d: object|null, err: string }} d 가 null 이고 err 가 '' 이면 읽는 중
 */
function useOnce(path, key, params, enabled) {
  const [st, setSt] = useState({ key: '', d: null, err: '' });
  const first = useRef(true);
  const sig = JSON.stringify(params || {});
  useEffect(() => {
    if (!enabled || !key) return undefined;
    let alive = true;
    const delay = first.current ? 0 : FETCH_DELAY_MS;
    first.current = false;
    const t = setTimeout(() => {
      fetchJson(path, { key, ...JSON.parse(sig) })
        .then((x) => { if (alive) setSt({ key, d: x, err: '' }); })
        .catch((e) => { if (alive) setSt({ key, d: null, err: opErrorText(e) }); });
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [path, key, sig, enabled]);
  return st.key === key ? st : { key, d: null, err: '' };
}

/** 그림 폭 = 그 칸의 실제 폭(글자를 늘이거나 줄이지 않게). 재기 전 · 서버 렌더는 기본값. */
function useBoxWidth(ref, fallback) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => { const n = Math.floor(el.clientWidth); if (n > 0) setW(n); };
    read();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export default function BmDrawer({ r, rows, corps, corpName, scoped, op, busy, onClose, onMove }) {
  const rootRef = useRef(null);
  const backRef = useRef(null);
  const bodyRef = useRef(null);
  const [to, setTo] = useState('');
  const isBm = r?.kind === 'bm';
  const hw = useOnce('/tools/bm-folders/hw', r?.key || '', null, !!r && isBm);
  const trend = useOnce('/tools/bm-folders/trend', r?.key || '', { hours: 24 }, !!r && isBm);
  // 열 때 포커스를 드로어로(키보드 ↑↓ · Esc) · 닫을 때 원래 자리로
  useEffect(() => {
    backRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { try { backRef.current?.focus?.({ preventScroll: true }); } catch { /* 사라진 요소 */ } };
  }, []);
  // 다른 서버로 넘어가면 고르던 폴더를 비우고 본문을 맨 위로
  useEffect(() => { setTo(''); if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [r?.key]);
  if (!r) return null;

  const corp = (corps || []).find((c) => c.vcenterId === r.corp) || null;
  const writable = !!corp?.writable;
  const folders = (corp?.folders || []).map((f) => f.path).filter((p) => !(r.place && p === r.path));
  const nb = neighborOfKey(rows, r.key);
  const sigs = bmSignalRows(r);
  const addr = hw.d?.addr || r.addr || '';
  const move = (x) => { if (x) onMove(x.key); };
  const onKey = (e) => {
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowDown' && nb.next) { e.preventDefault(); move(nb.next); }
    else if (e.key === 'ArrowUp' && nb.prev) { e.preventDefault(); move(nb.prev); }
  };

  return (
    <>
      <div className="vmh-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={rootRef} className="vmh-drawer" role="dialog" aria-modal="true" aria-label={`서버 상세 — ${r.name}`} tabIndex={-1} onKeyDown={onKey}>
        <EscClose onClose={onClose} />
        <div className="vmh-dh">
          <div className="ttl">
            <StatusDot tone={rowTone(r)} />
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
            {nb.index >= 0 && <span className="pos">목록 {nb.index + 1}/{nb.total}</span>}
          </div>
        </div>

        <div className="vmh-acts bmd-acts">
          {isBm && addr && !scoped ? <IdracConnect addr={addr} name={r.name} corp={r.corp} button /> : null}
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

        <div className="vmh-db bmd-db" ref={bodyRef}>
          <DrawerSections r={r} hw={hw} trend={trend} corpName={corpName} scoped={scoped} onClose={onClose} />
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
export function DrawerSections({ r, hw, trend, corpName, scoped, onClose }) {
  const isBm = r.kind === 'bm';
  const sigs = bmSignalRows(r);
  const tiles = bmTiles(r);
  const kv = bmKvRows(r, { corpName, scoped });
  const none = noUsage(r);
  const d = hw.d;
  const det = d?.detail || null;
  const sum = det?.summary || d?.summary || r.hw || null;   // 상세를 받기 전 · 못 받았을 때는 목록 행의 요약(같은 값)
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
              <WhyTip why={r.why} what="CPU · 메모리 사용률" />
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
            <span className="s wrap">{tiles.fault.state === 'unread' ? '못 읽음 — 0건이 아닙니다' : tiles.fault.state === 'bad' ? <a href="#/tools/part-faults" onClick={onClose}>물리 부품 장애에서 보기</a> : '읽었고 0건'}</span>
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
        ) : <div className="muted bmd-note">{NO_SIGNAL_TEXT}</div>}
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
              <b title={os.full || OS_WHY} style={os.full ? undefined : { color: 'var(--text-dim)' }}>{os.full || '—'}</b>
            </div>
          ) : null}
          {isBm && osHost ? <div className="full"><span>OS 호스트명</span><b className="mono">{osHost}</b></div> : null}
        </div>
        {isBm && !os.full && sum ? <div className="muted bmd-note">{OS_WHY}</div> : null}
      </section>

      {isBm ? (
        <>
          <section className="vmh-sec" aria-label="iDRAC · 관리">
            <div className="sh"><h3>iDRAC · 관리</h3>{sum?.at ? <span className="muted">인벤토리 {ageText(sum.at)} 읽음{d && VIA_TEXT[d.via] ? ` · ${VIA_TEXT[d.via]}` : ''}</span> : null}</div>
            <div className="vmh-kv">
              <div>
                <span>iDRAC 주소</span>
                <b>{addr ? (scoped ? <span className="mono">{addr}</span> : <IdracConnect addr={addr} name={r.name} corp={r.corp} />)
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
