/**
 * 특수 기능 › 랙 실장도(도구 키 rack) — 설계 docs/design/rack-elevation/README.md(시안 ① 조회 · ② 끌어 놓기 편집).
 *   1차 범위(2026-11-20 사용자 선택 '원장+조회+편집'): 법인 › 데이터센터 › 전산실 › 랙 원장 · 전면/후면 실장도 · 겹쳐 보기(종류 · 상태) ·
 *   서버 서비스 태그 ↔ iDRAC 연결 정보 · 미배치 서버 · 관리자 끌어 놓기 편집 · 수동 장비 · 랙 종류 · 변경 이력 · 엑셀 내보내기.
 *   엑셀 가져오기 · PDU 측정값 · 데이터센터 요약 · 평면도 · 배치 계획은 다음 차수(시안에는 있다).
 * 판정(겹침 · 범위 · 권한)은 서버가 한다 — 화면은 끌어 놓는 동안 미리 보기만 하고, 놓으면 서버 응답(409 사유)을 그대로 보여 준다.
 * 폴링하지 않는다(열 때 1회 + 새로 고침 + 쓰기 뒤 재조회). 늦게 온 이전 응답은 버린다(요청 순번).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { downloadFailText } from '../downloadFailText.js';
import RackMaskCensus from './RackMaskCensus.jsx';
import {
  U_PX, KIND_LABEL, FACE_LABEL, colorOf, legendOf, fmtU, placesForFace, placementIssue, dropStartU, boxOf, wattText,
  roomSummary, matchPlace, ACTION_LABEL, partChips, chipColor, statusKeyOf,
  diffCountText, DIFF_OP_LABEL, DIFF_TYPE_LABEL, fieldsText, matchUnplaced, UNPLACED_PAGE, defaultLabelOf, changedFields, unplacedMode, linkNameText, restoreMissingText, restoreConfirmText,
  viewAfterLoadFail, sameSpot, viewAfterMove, spotVisible, lostViewReason, modalWithRoom, conflictHint, nameTarget,
} from './rackView.js';

const card = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, minWidth: 0 };
const btn = { height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnPri = { ...btn, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#04101f' };
/** 잠긴 버튼의 모양(인라인 스타일에는 :disabled 가 없다 — 2회차 점검 화면 3: 잠긴 버튼이 평소와 똑같이 보였다). */
const off = (st, d) => (d ? { ...st, opacity: 0.5, cursor: 'not-allowed' } : st);
/** 저장 버튼 글자 — 이 창이 시작한 저장이면 '저장 중…', 다른 저장(끌어 놓기 등)을 기다리는 중이면 그렇게 말한다. */
const SLOW_SAVE_MS = 700;
const saveText = (busy, saving) => (saving ? '저장 중…' : busy ? '앞 저장을 기다리는 중…' : '저장');
const lab = { fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 };
const sel = { height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-deep)', color: 'var(--text)', minWidth: 0 };
const mono = { fontFamily: 'var(--mono)' };
const grp = { display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%' };   // 이름표 + 칸을 한 묶음으로(좁은 화면에서 서로 다른 줄로 갈라지지 않게)
const segBtn = (on) => ({ height: 30, padding: '0 12px', border: 0, background: on ? 'rgba(59,130,246,.22)' : 'transparent', color: on ? 'var(--text)' : '#aebbd0', fontWeight: 600, fontSize: 12, cursor: 'pointer' });
const seg = { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' };

function Seg({ items, value, onChange, label, wrap = false }) {
  return (
    <div style={wrap ? { ...seg, flexWrap: 'wrap', maxWidth: '100%' } : seg} role="group" aria-label={label}>
      {items.map(([k, t]) => <button key={k} type="button" style={{ ...segBtn(value === k), whiteSpace: 'nowrap' }} aria-pressed={value === k} onClick={() => onChange(k)}>{t}</button>)}
    </div>
  );
}

/** 데이터가 있는데 다시 불러오기만 실패했을 때의 한 줄 안내(화면 전체를 오류 상자로 바꾸지 않는다 — 점검 C22). */
function StaleBanner({ what, error, onRetry, locked = false }) {
  const why = error?.serverReason || error?.message || '';
  return (
    <div role="alert" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8, fontSize: 12, border: '1px solid var(--amber)', background: 'rgba(245,158,11,.12)' }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{what} 다시 불러오지 못했습니다{why ? `(${String(why).slice(0, 160)})` : ''} — 아래는 직전에 불러온 내용입니다{locked ? '(다시 불러올 때까지 편집은 잠깁니다)' : ''}.</span>
      <button type="button" style={{ ...btn, height: 26 }} onClick={onRetry}>다시 시도</button>
    </div>
  );
}

function Tile({ k, n, s, color }) {
  return (
    <div style={{ ...card, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: color || 'var(--text)' }}>{n}</div>
      {s ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s}</div> : null}
    </div>
  );
}

/** 랙 하나(정면도). 편집 모드면 끌어 놓기 대상. */
function RackColumn({ rack, places, mode, face, q, selId, onPick, edit, drag, onDragOverRack, onDropRack, onDragLeaveRack, preview }) {
  const H = rack.heightU;
  const shown = placesForFace(places, face);
  const us = useMemo(() => Array.from({ length: H }, (_, i) => H - i), [H]);
  const slotsRef = useRef(null);
  const yOf = (e) => { const r = slotsRef.current?.getBoundingClientRect(); return r ? e.clientY - r.top : 0; };
  const t = rack.totals || {};
  const pv = preview && preview.rackId === rack.id ? preview : null;
  return (
    <div style={{ width: 236, flex: '0 0 auto', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '0 2px 4px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {/* 이름은 줄이고(전체는 title) 사용 U 는 늘 보이게 — 조회 계정의 가린 이름('masked-… (이름 가림)')이 머리글을 넘쳐 사용 U · 용도를 밀어냈다(6회차 화면 D3).
            줄 · 용도 글은 **남는 폭만** 쓴다(기본 폭 0) — 7회차 화면 U1: 기본 폭이 글 폭이라 긴 용도 글이 짧은 랙 이름('A1')을 'A…' 로 밀어냈다. 긴 이름이면 줄 · 용도는 title 로만 남는다. */}
        <strong title={rack.name} style={{ ...mono, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' }}>{rack.name}</strong>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{rack.totalsStale ? `— / ${H}U` : `${t.usedU ?? 0} / ${H}U${t.usePct != null ? ` · ${t.usePct}%` : ''}`}</span>
        <span title={[rack.row && `${rack.row} 줄`, rack.role].filter(Boolean).join(' · ') || undefined} style={{ fontSize: 11, color: 'var(--text-dim)', flex: '1 1 0%', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{[rack.row && `${rack.row} 줄`, rack.role].filter(Boolean).join(' · ')}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', fontSize: 10.5, color: 'var(--text-dim)', padding: '0 2px 6px' }}>
        {/* 끌어 놓기를 화면에 먼저 반영한 랙은 합계가 옛 값이다 — 다시 불러올 때까지 숫자 대신 밝힌다(2회차 반증 C6) */}
        <span>{rack.totalsStale ? '합계 다시 불러오는 중…' : `운전 ${wattText(t.opW, t.opRead, t.devices)}`}</span>
        <span>세로 PDU A {rack.pduA} · B {rack.pduB}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, border: `2px solid ${pv ? (pv.ok ? 'var(--green)' : 'var(--red)') : '#3a4866'}`, borderRadius: 6, background: 'var(--bg)', padding: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-hidden="true">
          {Array.from({ length: rack.pduA }, (_, i) => <div key={i} title={`PDU A${i + 1}`} style={{ flex: 1, width: 6, borderRadius: 2, border: '1px solid #3a4866', background: 'var(--panel)' }} />)}
        </div>
        <div style={{ flex: '0 0 18px', display: 'flex', flexDirection: 'column' }} aria-hidden="true">
          {us.map((u) => <span key={u} style={{ height: U_PX, lineHeight: `${U_PX}px`, fontSize: 9, color: 'var(--text-dim)', textAlign: 'right', ...mono }}>{u}</span>)}
        </div>
        <div
          ref={slotsRef}
          style={{ position: 'relative', flex: 1, minWidth: 0, height: H * U_PX, background: `repeating-linear-gradient(to bottom,var(--panel-deep) 0 ${U_PX - 1}px,var(--border-soft) ${U_PX - 1}px ${U_PX}px)` }}
          onDragOver={edit ? (e) => { e.preventDefault(); onDragOverRack(rack, yOf(e)); } : undefined}
          onDrop={edit ? (e) => { e.preventDefault(); onDropRack(rack, yOf(e)); } : undefined}
          onDragLeave={edit ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) onDragLeaveRack(rack); } : undefined}
        >
          {shown.map((p) => {
            const c = colorOf(p, mode);
            const b = boxOf(p);
            const m = matchPlace(p, q);
            const rearOfFull = face === 'rear' && p.face === 'full';
            const back = rearOfFull && mode !== 'status';   // 상태 보기에서는 뒷면이어도 상태 색을 그대로(장애가 회색에 묻히지 않게)
            const isSel = p.id === selId;
            const dragging = drag?.type === 'place' && drag.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                draggable={edit}
                onDragStart={edit ? (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch { /* */ } drag.start({ type: 'place', id: p.id, size: p.uSize, face: p.face }); } : undefined}
                onDragEnd={edit ? () => drag.end() : undefined}
                onClick={() => onPick(p.id)}
                title={`${p.label || p.serial || '이름 없음'} — ${rack.name} ${fmtU(p)} · ${FACE_LABEL[p.face] || ''}`}
                aria-label={`${p.label || p.serial || '이름 없음'}, ${rack.name} ${fmtU(p)}, ${rearOfFull ? `뒷면${back ? '' : `, ${c.val}`}` : c.val}`}
                className="rk-place"
                style={{
                  position: 'absolute', left: 1, right: 1, bottom: b.bottom, height: b.height, boxSizing: 'border-box', borderRadius: 3,
                  display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px', fontSize: 10, lineHeight: 1, textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap',
                  cursor: edit ? 'grab' : 'pointer',
                  background: back ? 'var(--panel)' : c.bg, border: `1px ${rearOfFull && !back ? 'dashed' : 'solid'} ${back ? '#3a4866' : c.bd}`, color: back ? 'var(--text-dim)' : c.fg,
                  // 고른 장비 · 검색에 걸린 장비는 안쪽 그림자로 — outline 은 키보드 초점 표시 전용(styles.css .rk-place:focus-visible)이라 서로 가리지 않는다
                  boxShadow: isSel ? 'inset 0 0 0 2px #ffffff' : m ? 'inset 0 0 0 2px #fcd34d' : 'none',
                  opacity: dragging ? 0.35 : (m === false ? 0.35 : 1),
                }}
              >
                <span style={{ ...mono, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{p.label || p.serial || '이름 없음'}</span>
                <span style={{ fontWeight: 700, flex: '0 0 auto' }}>{back ? '뒷면' : c.val}</span>
              </button>
            );
          })}
          {pv ? (
            <div aria-hidden="true" style={{
              position: 'absolute', left: 1, right: 1, bottom: (pv.uStart - 1) * U_PX, height: Math.max(1, Math.min(pv.uSize, H - pv.uStart + 1)) * U_PX - 1, boxSizing: 'border-box', borderRadius: 3, pointerEvents: 'none',
              border: `2px dashed ${pv.ok ? 'var(--green)' : 'var(--red)'}`, background: pv.ok ? 'rgba(34,197,94,.2)' : 'rgba(127,29,29,.94)', overflow: 'hidden', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: pv.ok ? '#bbf7d0' : '#ffffff',
            }}>{pv.ok ? (pv.sizeUnknown ? `U${pv.uStart} 부터(높이는 다음 창에서)` : `U${pv.uStart}${pv.uSize > 1 ? `–${pv.uStart + pv.uSize - 1}` : ''} 에 놓기`) : pv.reason}</div>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-hidden="true">
          {Array.from({ length: rack.pduB }, (_, i) => <div key={i} title={`PDU B${i + 1}`} style={{ flex: 1, width: 6, borderRadius: 2, border: '1px solid #3a4866', background: 'var(--panel)' }} />)}
        </div>
      </div>
    </div>
  );
}

function Detail({ p, rack, onEdit, edit }) {
  if (!p) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' }}>랙에서 장비를 누르면 여기에 정보가 나옵니다.</div>;
  const l = p.link;
  const dl = { display: 'grid', gridTemplateColumns: '84px minmax(0,1fr)', gap: '6px 10px', fontSize: 12, margin: 0 };
  const dt = { color: 'var(--text-dim)' };
  const dd = { margin: 0, minWidth: 0, overflowWrap: 'anywhere' };
  const st = statusKeyOf(p);
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', color: '#c3cee0' }}>{KIND_LABEL[p.kind] || '기타'}</span>
        <strong style={{ ...mono, fontSize: 14, overflowWrap: 'anywhere' }}>{p.label || p.serial || '이름 없음'}</strong>
        {edit ? <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={onEdit}>고치기</button> : null}
      </div>
      <dl style={dl}>
        <dt style={dt}>위치</dt><dd style={{ ...dd, ...mono }}>{rack?.name} · {fmtU(p)} ({p.uSize}U) · {FACE_LABEL[p.face]}</dd>
        <dt style={dt}>모델</dt><dd style={dd}>{p.model || '—'}</dd>
        <dt style={dt}>{p.kind === 'server' ? '서비스 태그' : '시리얼'}</dt>
        <dd style={{ ...dd, ...mono }}>{p.serialHidden ? '— (범위 계정에는 보이지 않습니다)' : [p.serial, ...(p.extraSerials || [])].filter(Boolean).join(' / ') || '—'}</dd>
        <dt style={dt}>계획 전력</dt><dd style={dd}>운전 {wattText(p.opW)} · 정격 {wattText(p.ratedW)}</dd>
        <dt style={dt}>무게</dt><dd style={dd}>{p.weightKg == null ? '—' : `${p.weightKg} kg`}</dd>
        {p.note ? <><dt style={dt}>관리 메모</dt><dd style={dd}>{p.note}</dd></> : null}
      </dl>
      {p.kind === 'server' ? (
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>iDRAC 정보</strong>
            {l?.collectedAt ? <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>{new Date(l.collectedAt).toLocaleString()} 수집{l.remote ? ' · 엣지' : ''}</span> : null}
          </div>
          {p.linkState === 'no-serial' ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>서비스 태그가 비어 있어 iDRAC 등록 서버와 잇지 못했습니다 — 고치기에서 서비스 태그를 넣으세요.</div> : null}
          {p.linkState === 'not-found' ? <div style={{ fontSize: 12, color: '#fde68a' }}>이 서비스 태그의 서버를 iDRAC 등록 서버(이 계정이 볼 수 있는 범위)에서 찾지 못했습니다.</div> : null}
          {l ? (
            <>
              <dl style={dl}>
                {linkNameText(l) != null ? <><dt style={dt}>호스트 이름</dt><dd style={{ ...dd, ...mono }}>{linkNameText(l)}</dd></> : null}
                <dt style={dt}>모델</dt><dd style={dd}>{l.model || '—'}</dd>
                <dt style={dt}>상태</dt><dd style={dd}>{{ ok: '정상', warn: '경고', crit: '장애' }[st] || '못 읽음'}</dd>
                <dt style={dt}>전원</dt><dd style={dd}>{l.powerState === 'On' ? '켜짐' : l.powerState === 'Off' ? '꺼짐' : (l.powerState || '—')}</dd>
                <dt style={dt}>CPU · 메모리</dt>
                <dd style={dd}>{l.hw?.cpu ? `${l.hw.cpu.sockets ?? '?'} × ${l.hw.cpu.model || 'CPU'}` : '—'}{l.hw?.mem?.gib != null ? ` · ${l.hw.mem.gib} GB` : ''}</dd>
                <dt style={dt}>펌웨어</dt><dd style={dd}>{l.hw?.fw ? `iDRAC ${l.hw.fw}` : '—'}</dd>
                {l.mgmtHost !== undefined ? <><dt style={dt}>관리 주소</dt><dd style={{ ...dd, ...mono }}>{l.mgmtHost || '—'}</dd></> : null}
              </dl>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {partChips(l.parts).map((c) => { const k = chipColor(c.state); return <span key={c.k} style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: k[0], border: `1px solid ${k[1]}`, color: k[2] }}>{c.text}</span>; })}
                {!l.parts ? <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>부품 정보를 아직 수집하지 않았습니다.</span> : null}
              </div>
              {l.mgmtHost ? <a href={`https://${l.mgmtHost}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#93c5fd' }}>iDRAC 웹 콘솔 열기 ↗</a> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_PLACE = { face: 'full', uStart: '', uSize: '', kind: 'server', label: '', model: '', serial: '', extraSerials: '', note: '', opW: '', ratedW: '', weightKg: '' };

function PlaceModal({ init, racks, onClose, onSave, onRemove, busy, saving, error }) {
  const [f0] = useState(() => ({ ...EMPTY_PLACE, ...init, extraSerials: Array.isArray(init.extraSerials) ? init.extraSerials.join(' / ') : (init.extraSerials || '') }));
  const [f, setF] = useState(f0);   // f0 = 창을 연 때의 값 — 고치기는 달라진 칸만 보낸다(onSave 가 대조)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const row = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 140px' };
  const inp = { ...sel, width: '100%', boxSizing: 'border-box' };
  return (
    <Modal title={init.id ? '장비 고치기' : '장비 놓기'} onClose={onClose} width={620}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {init.serialHidden ? <div style={{ fontSize: 12, color: '#fde68a' }}>이 계정에는 시리얼이 보이지 않아 고칠 수 없습니다.</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙</span>
            <Select style={inp} value={f.rackId} onChange={set('rackId')}>{racks.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.heightU}U)</option>)}</Select></label>
          <label style={row}><span style={lab}>시작 U(아래가 1)</span><input style={inp} inputMode="numeric" value={f.uStart} onChange={set('uStart')} autoFocus={init.uStart === '' || init.uStart == null} /></label>
          <label style={row}><span style={lab}>높이(U)</span><input style={inp} inputMode="numeric" value={f.uSize} onChange={set('uSize')} placeholder="입력 필수" autoFocus={!(init.uStart === '' || init.uStart == null) && (init.uSize === '' || init.uSize == null)} /></label>
          <label style={row}><span style={lab}>면</span>
            <Select sort={false} style={inp} value={f.face} onChange={set('face')}>{Object.entries(FACE_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>종류</span>
            <Select sort={false} style={inp} value={f.kind} onChange={set('kind')}>{Object.entries(KIND_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></label>
          <label style={{ ...row, flex: '2 1 220px' }}><span style={lab}>표시 이름</span><input style={inp} value={f.label} onChange={set('label')} placeholder="예: 가상화서버 #16" autoFocus={!!init.id} /></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>모델</span><input style={inp} value={f.model} onChange={set('model')} placeholder="예: PowerEdge R740" /></label>
          <label style={row}><span style={lab}>{f.kind === 'server' ? '서비스 태그(iDRAC 연결 기준)' : '시리얼'}</span><input style={{ ...inp, ...mono }} value={f.serial} onChange={set('serial')} disabled={!!init.serialHidden} /></label>
        </div>
        <label style={{ ...row, flex: 'none' }}><span style={lab}>추가 시리얼(섀시 안 노드 등 — ‘/’ 또는 쉼표로 구분)</span><input style={{ ...inp, ...mono }} value={f.extraSerials} onChange={set('extraSerials')} disabled={!!init.serialHidden} /></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>운전 전력(W)</span><input style={inp} inputMode="decimal" value={f.opW ?? ''} onChange={set('opW')} /></label>
          <label style={row}><span style={lab}>정격 전력(W)</span><input style={inp} inputMode="decimal" value={f.ratedW ?? ''} onChange={set('ratedW')} /></label>
          <label style={row}><span style={lab}>무게(kg)</span><input style={inp} inputMode="decimal" value={f.weightKg ?? ''} onChange={set('weightKg')} /></label>
        </div>
        <label style={{ ...row, flex: 'none' }}><span style={lab}>메모(관리자에게만 보입니다 — 주소 · 접속 방법은 여기에)</span><input style={inp} value={f.note} onChange={set('note')} /></label>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {init.id ? <button type="button" style={off({ ...btn, color: '#fecaca' }, busy)} disabled={busy} onClick={onRemove}>장비 빼기</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={off(btnPri, busy)} disabled={busy} onClick={() => onSave(f, f0)}>{saveText(busy, saving)}</button>
        </div>
      </div>
    </Modal>
  );
}

function RackModal({ init, types, onClose, onSave, onRemove, busy, saving, error }) {
  const [f0] = useState(() => ({ name: '', row: '', role: '', typeId: '', heightU: 42, pduA: 2, pduB: 2, ...init }));
  const [f, setF] = useState(f0);   // f0 = 창을 연 때의 값 — 고치기는 달라진 칸만 보낸다
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const row = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 140px' };
  const inp = { ...sel, width: '100%', boxSizing: 'border-box' };
  return (
    <Modal title={init.id ? '랙 고치기' : '랙 추가'} onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙 이름</span><input style={inp} value={f.name} onChange={set('name')} placeholder="예: A4" autoFocus /></label>
          <label style={row}><span style={lab}>줄</span><input style={inp} value={f.row} onChange={set('row')} placeholder="예: A" /></label>
          <label style={row}><span style={lab}>용도</span><input style={inp} value={f.role} onChange={set('role')} placeholder="예: DVC SERVER(ESX2)" /></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙 종류</span>
            <Select style={inp} value={f.typeId} onChange={set('typeId')}>
              <option value="">직접 높이 입력</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.heightU}U</option>)}
            </Select></label>
          <label style={row}><span style={lab}>높이(U)</span><input style={inp} inputMode="numeric" value={f.typeId ? (types.find((t) => t.id === f.typeId)?.heightU ?? '') : f.heightU} disabled={!!f.typeId} onChange={set('heightU')} /></label>
          <label style={row}><span style={lab}>세로 PDU A 계통</span><input style={inp} inputMode="numeric" value={f.pduA} onChange={set('pduA')} /></label>
          <label style={row}><span style={lab}>세로 PDU B 계통</span><input style={inp} inputMode="numeric" value={f.pduB} onChange={set('pduB')} /></label>
        </div>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {init.id ? <button type="button" style={off({ ...btn, color: '#fecaca' }, busy)} disabled={busy} onClick={onRemove}>랙 지우기(빈 랙만)</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={off(btnPri, busy)} disabled={busy} onClick={() => onSave(f, f0)}>{saveText(busy, saving)}</button>
        </div>
      </div>
    </Modal>
  );
}

function NameModal({ title, init = '', extra = null, onClose, onSave, onRemove, removeLabel, busy, saving, error }) {
  const [v, setV] = useState(init);
  return (
    <Modal title={title} onClose={onClose} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={lab}>이름</span>
          <input style={{ ...sel, width: '100%', boxSizing: 'border-box' }} value={v} onChange={(e) => setV(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && !busy && v.trim()) onSave(v); }} /></label>
        {extra}
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {onRemove ? <button type="button" style={off({ ...btn, color: '#fecaca' }, busy)} disabled={busy} onClick={onRemove}>{removeLabel}</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={off(btnPri, busy || !v.trim())} disabled={busy || !v.trim()} onClick={() => onSave(v)}>{saveText(busy, saving)}</button>
        </div>
      </div>
    </Modal>
  );
}

function TypesModal({ types, onClose, onAdd, onRemove, busy, saving, error }) {
  const [name, setName] = useState(''); const [h, setH] = useState('42');
  return (
    <Modal title="랙 종류(전 법인 공용)" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <STable style={{ width: '100%', fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'right' }}>높이</th><th data-nosort="1" /></tr></thead>
          <tbody>{types.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td style={{ textAlign: 'right' }} data-sort={t.heightU}>{t.heightU}U</td>
              <td style={{ textAlign: 'right' }}><button type="button" style={off(btn, busy)} disabled={busy} onClick={() => onRemove(t.id)}>지우기</button></td></tr>
          ))}</tbody>
        </STable>
        {!types.length ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>아직 랙 종류가 없습니다. 랙을 추가할 때 높이를 직접 넣어도 됩니다.</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 160px' }}><span style={lab}>이름</span><input style={sel} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 스토리지 랙 40U" autoFocus /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 80px' }}><span style={lab}>높이(U)</span><input style={sel} inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} /></label>
          <button type="button" style={off(btnPri, busy || !name.trim())} disabled={busy || !name.trim()} onClick={() => onAdd(name, h).then((ok) => { if (ok) setName(''); })}>{saving ? '추가 중…' : busy ? '앞 저장을 기다리는 중…' : '추가'}</button>
        </div>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{error}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * 판 기록(법인별 최근 30개) — 판을 고르면 '이 판에서 바뀐 것' 과 '되돌리면 바뀌는 것' 을 보여 주고, 권한이 있으면 그 판으로 되돌린다.
 * 되돌리기는 확인을 한 번 더 받는다(원장을 통째로 바꾼다). 판 목록은 열 때 1회 + 되돌린 뒤 다시 읽는다(폴링 없음).
 */
function VersionsModal({ corpId, corpName, isAdmin, onClose, onRestored, onFailed }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [selVid, setSelVid] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [detailTick, setDetailTick] = useState(0);   // 되돌리기 충돌 뒤 고른 판의 차이를 새 원장 기준으로 다시 읽는다(점검 C14)
  const seqRef = useRef(0);
  const load = useCallback(async () => {
    try { const r = await fetchJson('/tools/rack/versions', { corp: corpId }); setList(r); setErr(null); return r; } catch (e) { setErr(e); return null; }
  }, [corpId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setDetail(null); setDetailErr(''); setConfirm(false);
    if (selVid == null) return;
    const my = ++seqRef.current;
    fetchJson(`/tools/rack/versions/${selVid}`, { corp: corpId })
      .then((d) => { if (my === seqRef.current) setDetail(d); })
      .catch((e) => { if (my === seqRef.current) setDetailErr(e?.serverReason || e?.message || '판을 읽지 못했습니다.'); });
  }, [selVid, corpId, detailTick]);
  useEffect(() => { setMsg(''); }, [selVid]);
  const restore = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/rack/op', { op: 'version.restore', corpId, versionId: selVid, expectLatestId: list?.latestId });
      if (r?.ok === false) {
        setMsg(r.reason || '되돌리지 못했습니다.');
        // 되돌리는 중 창을 닫았으면 이 창의 문구는 보이지 않는다 — 실패도 부모에 알린다(성공만 올리던 것 · 2회차 반증 B-4)
        onFailed?.(r.reason || '되돌리지 못했습니다.', corpId);
        if (r.code === 'versionConflict') { const fresh = await load(); setConfirm(false); setDetailTick((x) => x + 1); if (fresh) setMsg(`${r.reason || '그 사이 원장이 바뀌었습니다.'} 판 목록을 다시 불러왔습니다.`); }
        return;
      }
      await load();
      setSelVid(null);
      onRestored(`판 #${r.restoredFrom} 상태로 되돌렸습니다(되돌린 결과는 새 판 #${r.latestId} — 다시 되돌릴 수 있습니다).`, corpId);
    } catch (e) { const why = e?.serverReason || e?.message || '되돌리지 못했습니다.'; setMsg(why); onFailed?.(why, corpId); } finally { setBusy(false); }
  };
  const versions = list?.versions || [];
  const sel = versions.find((v) => v.id === selVid);
  const itemList = (d) => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
      {d.items.map((it, i) => (
        <li key={`${it.type}-${it.id}-${it.op}-${i}`} style={{ padding: '5px 10px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ color: it.op === 'remove' ? '#fca5a5' : it.op === 'add' ? '#bbf7d0' : '#fde68a', fontWeight: 700, flex: '0 0 auto' }}>{DIFF_TYPE_LABEL[it.type]} {DIFF_OP_LABEL[it.op]}</span>
          <span style={{ ...mono, overflowWrap: 'anywhere' }}>{it.name}</span>
          {it.where ? <span style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{it.where}</span> : null}
          {it.fields ? <span style={{ color: 'var(--text-dim)' }}>{fieldsText(it.fields)}</span> : null}
        </li>
      ))}
      {!d.items.length ? <li style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-dim)' }}>바뀐 것 없음</li> : null}
      {d.omitted ? <li style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-dim)' }}>외 {d.omitted}건은 줄였습니다.</li> : null}
    </ul>
  );
  return (
    <Modal title={`판 기록 — ${corpName}`} onClose={onClose} width={980}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          변경이 저장될 때마다 이 법인의 랙 실장도 전체(데이터센터 · 전산실 · 랙 · 장비 배치)를 한 판으로 남깁니다. 법인마다 {list?.keep != null ? `최근 ${list.keep}개만` : '정해진 개수의 최근 판만'} 남고 더 오래된 판은 지워집니다.
        </span>
        {err && list ? <StaleBanner what="판 목록을" error={err} onRetry={load} /> : null}
        {err && !list ? <ErrorBox error={err} /> : !list ? <Loading label="판 기록" /> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: '1 1 300px', minWidth: 0, maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button type="button" onClick={() => setSelVid(v.id)} aria-pressed={v.id === selVid} autoFocus={i === 0}
                    style={{ width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, borderBottom: '1px solid var(--border-soft)', cursor: 'pointer', background: v.id === selVid ? 'rgba(59,130,246,.16)' : 'transparent', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 44 }}>
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-dim)' }}>
                      <span style={mono}>#{v.id}</span><span style={mono}>{new Date(v.ts).toLocaleString()}</span>
                      {i === 0 ? <span style={{ color: '#93c5fd', fontWeight: 700 }}>지금 원장</span> : null}
                      {v.user ? <span>{v.user}</span> : null}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{ACTION_LABEL[v.action] || v.action}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{v.detail}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>랙 {v.counts?.racks ?? '—'} · 장비 {v.counts?.places ?? '—'}</span>
                  </button>
                </li>
              ))}
              {!versions.length ? <li style={{ padding: 12, fontSize: 12, color: 'var(--text-dim)' }}>아직 저장된 판이 없습니다.</li> : null}
            </ul>
            <div style={{ flex: '2 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selVid == null && versions.length ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>목록에서 판을 고르면 무엇이 바뀌었는지 보여 줍니다.</span> : null}
              {detailErr ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{detailErr}</div> : null}
              {selVid != null && !detail && !detailErr ? <Loading label="판" /> : null}
              {detail && !detail.readable ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>이 판을 읽지 못했습니다(손상) — 보거나 되돌릴 수 없습니다.</div> : null}
              {detail?.readable ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>이 판에서 바뀐 것 <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 12 }}>(바로 앞 판 → 판 #{detail.version.id})</span></strong>
                    {detail.changes ? <><span style={{ fontSize: 12 }}>{diffCountText(detail.changes.counts)}</span>{itemList(detail.changes)}</> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{detail.prevUnreadable ? '바로 앞 판을 읽지 못해(손상) 비교할 수 없습니다.' : '앞 판이 남아 있지 않아 비교할 수 없습니다(가장 오래된 판).'}</span>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>되돌리면 바뀌는 것 <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 12 }}>(지금 원장 → 판 #{detail.version.id})</span></strong>
                    {detail.restore ? <><span style={{ fontSize: 12 }}>{diffCountText(detail.restore.counts)}</span>{itemList(detail.restore)}</> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{restoreMissingText(isAdmin)}</span>}
                  </div>
                  {list.canRestore && sel && selVid !== list.latestId ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 12px', border: `1px solid ${confirm ? 'var(--red)' : 'var(--border)'}`, borderRadius: 10, background: confirm ? 'rgba(239,68,68,.10)' : 'transparent' }}>
                      {!confirm ? (
                        <button type="button" style={btnPri} onClick={() => setConfirm(true)}>이 판으로 되돌리기</button>
                      ) : (
                        <>
                          <span style={{ fontSize: 12, flex: '1 1 260px' }}>{restoreConfirmText(corpName, selVid, !!detail.restore)}</span>
                          <button type="button" style={off(btn, busy)} disabled={busy} onClick={() => setConfirm(false)}>취소</button>
                          <button type="button" style={off({ ...btnPri, background: 'var(--red)', borderColor: 'var(--red)', color: '#ffffff' }, busy)} disabled={busy} onClick={restore}>{busy ? '되돌리는 중…' : '되돌리기 확인'}</button>
                        </>
                      )}
                    </div>
                  ) : null}
                  {sel && selVid === list.latestId ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>지금 원장과 같은 판입니다.</span> : null}
                  {!list.canRestore ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>되돌리기는 관리자(이 법인 쓰기 범위)만 할 수 있습니다.</span> : null}
                </>
              ) : null}
              {msg ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{msg}</div> : null}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function RackTool() {
  const [tree, setTree] = useState(null);
  const [treeErr, setTreeErr] = useState(null);
  const [corpId, setCorpId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [viewRaw, setView] = useState(null);
  const [viewErr, setViewErr] = useState(null);
  const [loadingRoom, setLoadingRoom] = useState(false);
  const [mode, setMode] = useState('kind');
  const [face, setFace] = useState('front');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(false);
  const [selId, setSelId] = useState('');
  const [modal, setModalRaw] = useState(null);   // { kind, ... }
  const modalRef = useRef(null);
  modalRef.current = modal;
  // 창을 연 자리로 초점을 되돌린다(창 안 첫 칸으로 옮긴 초점이 닫은 뒤 문서 맨 앞으로 떨어지지 않게 — 2회차 점검 화면 6).
  const lastFocus = useRef(null);
  const setModal = useCallback((m) => {
    if (m && !modalRef.current && typeof document !== 'undefined') lastFocus.current = document.activeElement;
    // 장비 · 랙 창은 **연 때의 전산실**을 담아 둔다 — 늦게 온 응답이 선택을 바꾼 뒤 그 창으로 다른 전산실에 쓰지 않게(3회차 점검 화면 1 · savePlace 등의 wrongRoom).
    setModalRaw(modalWithRoom(m, roomIdRef.current));
  }, []);
  useEffect(() => {
    if (modal) return;
    const el = lastFocus.current; lastFocus.current = null;
    if (el && el !== document.body && el.isConnected && typeof el.focus === 'function') el.focus();
  }, [modal]);
  const [busy, setBusy] = useState(false);
  const [busyModal, setBusyModal] = useState(null);   // 지금 가고 있는 저장을 시작한 창(끌어 놓기면 null)
  // '저장 중' 한 줄은 저장이 SLOW_SAVE_MS 넘게 걸릴 때만 보인다 — 바로 끝나는 저장(끌어 놓기)마다 줄이 생겼다 사라져 랙 그림이 한 번 내려갔다 올라왔다(4회차 점검 화면 제안 1 · 실측 29px).
  //   줄 조건에는 busy 도 함께 본다 — slowSave 는 effect 에서야 꺼지므로, 저장이 끝나 창이 닫히는 렌더에 줄이 잠깐 비쳤다(5회차 점검 화면 1 · 재현).
  const [slowSave, setSlowSave] = useState(false);
  useEffect(() => {
    if (!busy) { setSlowSave(false); return undefined; }
    const t = setTimeout(() => setSlowSave(true), SLOW_SAVE_MS);
    return () => clearTimeout(t);
  }, [busy]);
  // 저장 중에도 창은 닫을 수 있다 — 응답이 오지 않으면 갇히기 때문(2회차 점검 화면 3). 늦게 온 응답은 '그 저장을 시작한 창' 일 때만 창을 닫고 오류를 싣는다(run 의 sameModal).
  const closeModal = useCallback(() => { setModal(null); }, [setModal]);
  const corpIdRef = useRef('');
  corpIdRef.current = corpId;
  const siteIdRef = useRef('');
  siteIdRef.current = siteId;
  const lastRoomErr = useRef(null);   // 가장 최근 전산실 조회 실패(충돌 뒤 문구가 ‘없어짐’ 과 ‘일시 실패’ 를 가른다)
  const [modalErr, setModalErr] = useState('');
  const [note, setNote] = useState(null);     // { tone, text }
  const [dragInfo, setDragInfo] = useState(null);
  const [preview, setPreview] = useState(null);
  const seq = useRef(0);
  const roomIdRef = useRef('');
  roomIdRef.current = roomId;
  const viewRawRef = useRef(null);
  viewRawRef.current = viewRaw;
  // 화면 · 쓰기에 쓰는 전산실 응답은 **지금 고른 전산실의 것만**(늦게 온 다른 전산실 응답 · 법인을 바꾼 뒤 남은 응답으로 보이지 않는 원장에 쓰지 않게 — 점검 C1).
  const view = viewRaw && viewRaw.room?.id === roomId ? viewRaw : null;
  const treeSeq = useRef(0);

  const loadTree = useCallback(async () => {
    const my = ++treeSeq.current;
    try {
      const t = await fetchJson('/tools/rack');
      if (my !== treeSeq.current) return null;   // 늦게 온 이전 응답은 버린다
      setTree(t); setTreeErr(null);
      return t;
    } catch (e) { if (my === treeSeq.current) setTreeErr(e); return null; }
  }, []);

  const loadRoom = useCallback(async (id) => {
    const my = ++seq.current;   // 빈 전산실로 바꿀 때도 올린다 — 앞 요청의 늦은 응답이 되살아나지 않게(점검 C1)
    if (!id) { setView(null); setViewErr(null); setLoadingRoom(false); return null; }
    setLoadingRoom(true);
    setViewErr(null);   // ‘낡음’(= 편집 잠금)은 화면 자료에 붙어 있어(staleErr) 여기서 지워지지 않는다 — 이 오류는 보여 줄 화면이 없을 때만 쓴다
    try {
      const v = await fetchJson(`/tools/rack/room/${encodeURIComponent(id)}`);
      if (my !== seq.current || id !== roomIdRef.current) return null;   // 늦게 온 이전 응답 · 다른 전산실 응답은 버린다
      setView({ ...v, loadSeq: my }); setViewErr(null); lastRoomErr.current = null;
      return v;
    } catch (e) {
      // 2회차 반증 B-3: ‘다시 불러오지 못한 화면’ 표시를 오류 상태 하나(viewErr)에 두면, 다른 전산실을 눌렀다 곧바로 돌아올 때 그 표시만 지워지고 낡은 화면이 잠금 없이 그려졌다.
      //   표시를 **그 전산실의 화면 자료**에 붙인다 — 그 전산실을 다시 불러오는 데 성공해 자료가 통째로 바뀔 때만 사라진다(이 실패보다 나중에 받은 자료는 건드리지 않는다).
      //   1회차 점검 정확성 2: 일시 실패(5xx · 네트워크)에 직전 화면까지 지우지 않는다 — 없어진 전산실(404) · 권한 없음(403)일 때만 비운다.
      setView((v) => viewAfterLoadFail(v, id, my, e));
      if (my === seq.current && id === roomIdRef.current) { setViewErr(e); lastRoomErr.current = e; }
      return null;
    } finally { if (my === seq.current) setLoadingRoom(false); }
  }, []);

  useEffect(() => { loadTree(); }, [loadTree]);

  // 고른 법인 · 데이터센터 · 전산실이 목록에서 사라졌으면 첫 항목으로(목록이 바뀔 때만).
  const sites = useMemo(() => (tree?.sites || []).filter((s) => s.corpId === corpId), [tree, corpId]);
  const rooms = useMemo(() => (tree?.rooms || []).filter((r) => r.siteId === siteId), [tree, siteId]);
  useEffect(() => {
    if (!tree) return;
    const corps = tree.corps || [];
    if (!corps.some((c) => c.id === corpId)) setCorpId(corps.find((c) => (tree.sites || []).some((s) => s.corpId === c.id))?.id || corps[0]?.id || '');
  }, [tree, corpId]);
  useEffect(() => { if (tree && !sites.some((s) => s.id === siteId)) setSiteId(sites[0]?.id || ''); }, [tree, sites, siteId]);
  useEffect(() => { if (tree && !rooms.some((r) => r.id === roomId)) setRoomId(rooms[0]?.id || ''); }, [tree, rooms, roomId]);
  // 전산실을 바꾸면 고른 장비 · 미리 보기를 지우고 다시 불러온다(알림 줄은 사용자가 직접 고를 때만 지운다 — 선택 칸의 onChange).
  useEffect(() => { setSelId(''); setPreview(null); loadRoom(roomId); }, [roomId, loadRoom]);

  const corp = (tree?.corps || []).find((c) => c.id === corpId);
  const canEdit = !!view?.canEdit && !view.staleErr;   // 다시 불러오지 못한(낡은) 화면에서는 편집을 잠근다 — ‘다시 시도’ 로 최신을 받은 뒤에
  const corpWritable = !!corp?.writable;
  useEffect(() => { if (!canEdit && !corpWritable) setEdit(false); }, [canEdit, corpWritable]);

  const placesByRack = useMemo(() => {
    const m = new Map();
    for (const p of view?.places || []) { if (!m.has(p.rackId)) m.set(p.rackId, []); m.get(p.rackId).push(p); }
    return m;
  }, [view]);
  const selected = (view?.places || []).find((p) => p.id === selId) || null;
  const selRack = selected ? (view?.racks || []).find((r) => r.id === selected.rackId) : null;
  const sum = useMemo(() => roomSummary(view), [view]);
  // 개선 3: 미배치 서버는 검색어로 거르고(랙 강조와 같은 검색 칸), 한 번에 UNPLACED_PAGE 대씩 그린다(예전엔 앞 50대만 끌 수 있었다).
  const [exporting, setExporting] = useState(false);
  const [unplacedShow, setUnplacedShow] = useState(UNPLACED_PAGE);
  const unplacedHit = useMemo(() => (view?.unplaced || []).filter((u) => matchUnplaced(u, q)), [view, q]);
  useEffect(() => { setUnplacedShow(UNPLACED_PAGE); }, [q, roomId]);

  const say = (tone, text) => setNote({ tone, text });

  /** 지금 보고 있는 자리(법인 · 데이터센터 · 전산실 · 열린 창) — 늦게 온 응답이 ‘그 쓰기를 시작한 자리’ 인지 대조하는 데 쓴다. */
  const whereNow = () => ({ corp: corpIdRef.current, site: siteIdRef.current, room: roomIdRef.current, modal: modalRef.current });
  /** 그 뒤로 사용자가 자리를 옮기거나 다른 창을 열지 않았는가(쓰기 뒤 선택을 새 항목으로 옮겨도 되는가). */
  const unmoved = (at) => sameSpot(at, whereNow());

  /**
   * 쓰기 연산 하나 — 409(충돌 · 겹침)는 사유를 그대로 보여 주고, 판이 바뀌었으면 최신을 다시 불러온다.
   * `roomId` · `siteId` · `corpId` = 이 쓰기의 대상 자리. 응답이 왔을 때 그 자리를 보고 있지 않으면 알림을 띄우지 않는다
   * (저장 중에도 창을 닫을 수 있어, 닫고 다른 법인 · 전산실로 간 화면에 ‘추가했습니다’ 가 떴다 — 2회차 반증 C5 · 3회차 점검 화면 2).
   */
  const run = useCallback(async (body, { okText = '저장했습니다.', closeModal = true, roomId: writeRoom = '', siteId: writeSite = '', corpId: writeCorp = '' } = {}) => {
    // 1회차 점검 성능 축: 응답이 늦는 동안 전산실을 바꾸거나 다른 창을 열 수 있다 — 이 쓰기를 시작한 전산실 · 창일 때만 rev 반영 · 창 닫기 · 알림을 한다.
    const modalAtStart = modalRef.current;
    const sameModal = () => modalRef.current === modalAtStart;
    const sameRoom = () => spotVisible({ room: writeRoom, site: writeSite, corp: writeCorp }, { room: roomIdRef.current, site: siteIdRef.current, corp: corpIdRef.current });
    setBusy(true); setBusyModal(modalAtStart); setModalErr('');
    try {
      const r = await postJson('/tools/rack/op', body);
      if (r?.ok === false) {
        const why = r.reason || '저장하지 못했습니다.';
        if (r.code === 'revConflict') {
          const fresh = await loadRoom(roomIdRef.current);
          // 창을 닫지 않는다(입력 유지 — 점검 C20). 최신 배치를 못 불러왔으면 그렇게 말한다(불러온 것처럼 '다시 저장하면 반영' 이라 하지 않는다 — 2회차 점검 화면 5).
          //   전산실이 없어졌거나 권한이 없어졌으면(404 · 403) 다시 저장해도 되지 않는다 — 처음부터 닫고 새로 고치라고 말한다.
          const hint = conflictHint(fresh, lastRoomErr.current);
          if (sameModal()) setModalErr(hint === 'fresh' ? `${why} 고친 칸은 그대로 두었습니다 — 다시 저장하면 고친 칸만 반영합니다.` : hint === 'gone' ? `${why} 그런데 이 전산실을 더 불러올 수 없습니다 — 창을 닫고 새로 고친 뒤 다시 하세요.` : `${why} 그런데 최신 배치를 불러오지 못했습니다 — 잠시 뒤 다시 저장하세요(고친 칸은 그대로 두었습니다).`);
          if (sameRoom()) say('warn', why);
          return null;
        }
        if (sameModal()) setModalErr(why);
        if (sameRoom()) say('err', why);
        return null;
      }
      // 이 화면의 rev 로 쓴 변경이 성공했으면 새 rev 를 바로 반영한다 — 다시 불러오기 전에 이어서 끌어 놓아도 자기 변경과 충돌하지 않게(점검 C19).
      //   같은 전산실일 때만(rev 숫자는 전산실끼리 같을 수 있다 — 되돌리기는 법인의 전산실 전부에 같은 rev 를 준다).
      if (Number.isInteger(r?.rev) && Number.isInteger(body?.rev) && writeRoom) setView((v) => (v && v.room?.id === writeRoom && v.rev === body.rev ? { ...v, rev: r.rev } : v));
      if (closeModal && sameModal()) setModal(null);
      if (sameRoom()) say('ok', r?.unchanged ? '바뀐 것이 없어 저장하지 않았습니다.' : okText);
      return r;
    } catch (e) {
      const why = e?.serverReason || e?.message || '저장하지 못했습니다.';
      if (sameModal()) setModalErr(why);
      if (sameRoom()) say('err', why);
      return null;
    } finally { setBusy(false); setBusyModal(null); }
  }, [loadRoom, setModal]);

  // 쓰기 뒤 다시 불러올 전산실은 **그때 고른 전산실**(쓰는 동안 전산실을 바꿨으면 옛 전산실로 화면이 돌아가지 않게 — 점검 C2).
  const afterRoomWrite = async (r) => { if (r) await Promise.all([loadRoom(roomIdRef.current), loadTree()]); return r; };

  // ── 끌어 놓기 ──
  const drag = useMemo(() => ({
    start: (d) => setDragInfo(d),
    end: () => { setDragInfo(null); setPreview(null); },
  }), []);
  const candOf = (rack, y) => {
    if (!dragInfo) return null;
    const size = dragInfo.size || 1;
    const uStart = dropStartU(y, rack.heightU, size);
    const sizeUnknown = dragInfo.type === 'server';   // 미배치 서버는 높이를 모른다 — 가리킨 U 를 시작 U 로 창에 채우고 겹침은 높이를 넣은 뒤 서버가 판정한다
    if (uStart == null) return { rackId: rack.id, uStart: 1, uSize: size, ok: false, reason: '랙보다 큼', sizeUnknown };
    const issue = placementIssue(rack, placesByRack.get(rack.id) || [], { face: dragInfo.face || 'full', uStart, uSize: size }, dragInfo.type === 'place' ? dragInfo.id : '');
    return { rackId: rack.id, uStart, uSize: size, ok: !issue, reason: issue?.code === 'overlap' ? '다른 장비와 겹침' : issue ? '놓을 수 없는 자리' : '', sizeUnknown };
  };
  const onDragOverRack = (rack, y) => {
    const c = candOf(rack, y);
    if (c && (!preview || preview.rackId !== c.rackId || preview.uStart !== c.uStart || preview.ok !== c.ok)) setPreview(c);
  };
  const onDragLeaveRack = (rack) => { setPreview((pv) => (pv && pv.rackId === rack.id ? null : pv)); };
  const onDropRack = async (rack, y) => {
    const c = candOf(rack, y);
    const d = dragInfo;
    setDragInfo(null); setPreview(null);
    if (!c || !d) return;
    if (busy) { say('warn', '앞 변경을 저장하는 중입니다 — 끝난 뒤 다시 놓으세요.'); return; }
    if (!c.ok) { say('err', `${rack.name} U${c.uStart} 자리에는 놓을 수 없습니다(${c.reason}).`); return; }
    if (d.type === 'place') {
      if (!view) return;
      // 랙 id 는 항상 보낸다 — 쓰기 직후 재조회가 오기 전의 화면은 장비 위치가 옛 값이라, 화면의 위치로 '같은 랙' · '제자리' 를 판단하면 서버가 다른 랙 안에서 옮긴다
      //   (2회차 점검 정확성 2 · 재현). 제자리면 서버가 unchanged 로 답한다.
      const writeRoom = view.room.id;
      const r = await run({ op: 'place.update', id: d.id, rackId: rack.id, rev: view.rev, place: { uStart: c.uStart } },
        { okText: `${rack.name} U${c.uStart} 자리로 옮겼습니다.`, closeModal: false, roomId: writeRoom });
      // 내 옮기기를 화면에 바로 반영한다(재조회가 끝날 때까지 낡은 위치 + 새 rev 로 남지 않게).
      //   랙을 건너 옮겼으면 두 랙의 머리 합계(사용 U · 전력 · 대수)는 옛 값이다 — 다시 불러올 때까지 숫자 대신 ‘다시 불러오는 중’ 으로(2회차 반증 C6).
      if (r && !r.unchanged) setView((v) => viewAfterMove(v, writeRoom, d.id, rack.id, c.uStart));
      afterRoomWrite(r);
    } else if (d.type === 'server') {
      // 미배치 서버 — 높이를 모르므로 1U 로 가정하지 않고 입력 창을 연다(위치는 놓은 자리로 채운다).
      setModalErr('');
      setModal({ kind: 'place', init: { rackId: rack.id, uStart: c.uStart, uSize: '', face: 'full', kind: 'server', label: defaultLabelOf(d), model: d.model || '', serial: d.serviceTag || '' } });
    }
  };

  // 장비 · 랙 창의 저장 전 확인: 화면 자료가 있고, 그 창을 연 전산실을 지금도 보고 있는가(아니면 다른 전산실의 rev · 랙으로 쓰게 된다 — 3회차 점검 화면 1).
  const ROOM_CHANGED_TEXT = '이 창을 연 뒤 보고 있는 전산실이 바뀌었습니다 — 창을 닫고 다시 여세요.';
  // 전산실이 바뀐 창은 저장을 누르기 전에도 알린다(그 창의 '랙' 칸에는 지금 보고 있는 다른 전산실의 랙이 보인다 — 4회차 점검 화면 제안 3).
  const roomChangedText = lostViewReason(view, modal) === 'roomChanged' ? ROOM_CHANGED_TEXT : '';
  // 저장을 눌러 남은 '전산실이 바뀌었습니다' 문구는, 원래 전산실로 돌아와 더는 해당하지 않으면 보이지 않는다(그때는 저장도 된다 — 5회차 점검 화면 관찰).
  const shownModalErr = modalErr === ROOM_CHANGED_TEXT ? '' : modalErr;
  const lostView = () => {
    const why = lostViewReason(view, modal);
    if (why === 'noView') setModalErr('전산실을 다시 불러오지 못했습니다 — 창을 닫고 새로 고친 뒤 다시 하세요.');
    else if (why === 'roomChanged') setModalErr(ROOM_CHANGED_TEXT);
    return !!why;
  };
  const nothingChanged = () => { setModal(null); say('ok', '바뀐 것이 없어 저장하지 않았습니다.'); };
  const savePlace = async (f, f0) => {
    if (lostView()) return;
    const keys = ['face', 'uStart', 'uSize', 'kind', 'label', 'model', 'note', 'opW', 'ratedW', 'weightKg', ...(modal.init.serialHidden ? [] : ['serial', 'extraSerials'])];
    let r;
    if (modal.init.id) {
      // 1회차 점검 성능 축(MEDIUM · 재현): 창을 연 때의 값을 전부 보내면, 그 사이 바뀐 값(내 직전 옮기기 · 다른 관리자의 변경)을 옛 값으로 조용히 되돌린다 — 달라진 칸만 보낸다.
      const place = changedFields(f0, f, keys);
      const moved = String(f.rackId ?? '') !== String(f0?.rackId ?? '');
      if (!Object.keys(place).length && !moved) { nothingChanged(); return; }
      r = await run({ op: 'place.update', id: modal.init.id, ...(moved ? { rackId: f.rackId } : {}), rev: view.rev, place }, { roomId: view.room.id });
    } else {
      const place = Object.fromEntries(keys.map((k) => [k, f[k]]));
      r = await run({ op: 'place.add', rackId: f.rackId, rev: view.rev, place }, { okText: '장비를 놓았습니다.', roomId: view.room.id });
    }
    if (r?.id) setSelId(r.id);
    afterRoomWrite(r);
  };

  const exportXlsx = async () => {
    if (exporting || !view?.room?.id) return;
    setExporting(true);   // 내보내기는 서버에서 동시 1건 — 끝날 때까지 이 버튼만 잠근다
    try { await downloadFile(`/tools/rack/room/${encodeURIComponent(view.room.id)}/xlsx`, `rack-${view.room.name || 'room'}.xlsx`); }
    catch (e) { say('err', downloadFailText ? downloadFailText(e) : (e?.message || '내려받지 못했습니다.')); }
    finally { setExporting(false); }
  };

  if (treeErr && !tree) return <ErrorBox error={treeErr} />;
  if (!tree) return <Loading label="랙 실장도" />;

  const corps = tree.corps || [];
  const types = tree.types || [];
  const racks = view?.racks || [];
  const legend = legendOf(mode);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={grp}>
          <label style={lab} htmlFor="rk-corp">법인</label>
          <Select id="rk-corp" style={sel} value={corpId} onChange={(e) => { setNote(null); setCorpId(e.target.value); }}>
            {!corps.length ? <option value="">볼 수 있는 법인이 없습니다</option> : null}
            {corps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </span>
        <span style={grp}>
          <label style={lab} htmlFor="rk-site">데이터센터</label>
          <Select id="rk-site" style={sel} value={siteId} onChange={(e) => { setNote(null); setSiteId(e.target.value); }}>
            {!sites.length ? <option value="">등록된 데이터센터 없음</option> : null}
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </span>
        <span style={{ ...grp, flexWrap: 'wrap' }}>
          <span style={lab}>전산실</span>
          {rooms.length ? <Seg label="전산실" wrap items={rooms.map((r) => [r.id, `${r.name} · 랙 ${r.racks}`])} value={roomId} onChange={(id) => { setNote(null); setRoomId(id); }} /> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>없음</span>}
        </span>
        <span style={grp}>
          <span style={lab}>겹쳐 보기</span>
          <Seg label="겹쳐 보기" items={[['kind', '종류'], ['status', '상태']]} value={mode} onChange={setMode} />
        </span>
        <Seg label="면" items={[['front', '전면'], ['rear', '후면']]} value={face} onChange={setFace} />
        <SearchBox value={q} onChange={setQ} placeholder="이름 · 모델 · 시리얼 · 호스트 이름 찾기" style={{ flex: '1 1 240px', minWidth: 200 }} />
        {/* 다시 불러오는 중 표시는 이 버튼의 글자로(폭 고정) — 랙 카드 안에 줄로 두면 끌어 놓을 때마다 랙 그림이 27px 내려갔다 올라왔다(5회차 점검 화면 2 · 실측) */}
        <button type="button" style={{ ...btn, minWidth: 112 }} aria-busy={loadingRoom && !!view} onClick={() => { loadTree(); loadRoom(roomId); }}>{loadingRoom && view ? '불러오는 중…' : '새로 고침'}</button>
        {view && canCsv() ? <button type="button" style={off(btn, exporting)} disabled={exporting} onClick={exportXlsx}>{exporting ? '내보내는 중…' : '엑셀 내보내기'}</button> : null}
        {corpId ? <button type="button" style={btn} onClick={() => setModal({ kind: 'versions' })}>판 기록</button> : null}
        {tree.canEditTypes ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'types' }); }}>랙 종류</button> : null}
        {tree.canEditTypes ? <button type="button" style={btn} onClick={() => setModal({ kind: 'census' })}>가림 집계</button> : null}
        {(canEdit || corpWritable) ? <button type="button" style={edit ? btn : btnPri} aria-pressed={edit} onClick={() => setEdit((x) => !x)}>{edit ? '편집 끝내기' : '배치 편집'}</button> : null}
      </div>

      {edit ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', border: '1px solid var(--accent)', background: 'rgba(59,130,246,.12)', borderRadius: 10, fontSize: 12 }}>
          <strong style={{ fontSize: 13 }}>배치 편집 중</strong>
          <span style={{ color: 'var(--text-dim)' }}>장비를 끌어 다른 자리 · 다른 랙에 놓으면 <strong style={{ color: 'var(--text)' }}>바로 저장</strong>됩니다(다른 사람이 먼저 바꿨으면 저장하지 않고 최신을 불러옵니다). 끌지 않고 옮기려면 장비를 눌러 ‘고치기’.</span>
          <span style={{ flex: 1 }} />
          {corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'site', corpId }); }}>+ 데이터센터</button> : null}
          {siteId && corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'room', siteId, siteName: sites.find((x) => x.id === siteId)?.name || '' }); }}>+ 전산실</button> : null}
          {siteId && corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'site-edit', id: siteId, name: sites.find((x) => x.id === siteId)?.name || '' }); }}>데이터센터 이름 · 삭제</button> : null}
          {view && canEdit ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'room-edit', id: view.room.id, name: view.room.name || '' }); }}>전산실 이름 · 삭제</button> : null}
          {view && canEdit ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'rack', init: {} }); }}>+ 랙</button> : null}
          {view && canEdit && racks.length ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'place', init: { rackId: racks[0].id, kind: 'other' } }); }}>+ 수동 장비</button> : null}
        </div>
      ) : null}

      {treeErr && tree ? <StaleBanner what="목록을" error={treeErr} onRetry={() => { loadTree(); loadRoom(roomIdRef.current); }} /> : null}
      {/* 저장 중 창을 닫았거나 끌어 놓은 직후 — 저장이 아직 가고 있음을 밝힌다(응답이 늦으면 다른 저장이 막히는 이유가 화면에 없었다 — 3회차 점검 화면 제안 1) */}
      {busy && slowSave && !modal ? <div role="status" style={{ fontSize: 12, color: 'var(--text-dim)', padding: '0 2px' }}>변경을 저장하는 중입니다… 끝날 때까지 다른 저장은 기다립니다.</div> : null}
      {note ? (
        <div role={note.tone === 'err' ? 'alert' : 'status'} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8, fontSize: 12,
          border: `1px solid ${note.tone === 'ok' ? 'var(--green)' : note.tone === 'warn' ? 'var(--amber)' : 'var(--red)'}`,
          background: note.tone === 'ok' ? 'rgba(34,197,94,.10)' : note.tone === 'warn' ? 'rgba(245,158,11,.12)' : 'rgba(239,68,68,.12)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{note.text}</span>
          <button type="button" style={{ ...btn, height: 26 }} onClick={() => setNote(null)}>닫기</button>
        </div>
      ) : null}

      {!corps.length ? (
        <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--text-dim)' }}>이 계정이 볼 수 있는 법인이 없습니다(법인에 할당된 vCenter 가 범위 안에 있어야 합니다).</div>
      ) : !sites.length || !rooms.length ? (
        <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <strong>{!sites.length ? `${corp?.name || ''} 에 등록된 데이터센터가 없습니다.` : '이 데이터센터에 전산실이 없습니다.'}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{corpWritable ? (edit ? '아래 버튼으로 추가하세요.' : '‘배치 편집’ 을 켜고 데이터센터 · 전산실 · 랙을 추가하세요.') : '관리자가 데이터센터 · 전산실 · 랙을 등록하면 여기에 실장도가 나옵니다.'}</span>
          {corpWritable ? <button type="button" style={btnPri} onClick={() => { setEdit(true); setModalErr(''); setModal(!sites.length ? { kind: 'site', corpId } : { kind: 'room', siteId, siteName: sites.find((x) => x.id === siteId)?.name || '' }); }}>{!sites.length ? '데이터센터 추가' : '전산실 추가'}</button> : null}
        </div>
      ) : viewErr && !view ? <ErrorBox error={viewErr} /> : !view ? <Loading label="전산실" /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
            <Tile k="랙" n={sum.racks} s={sum.heightsText || '—'} />
            <Tile k="사용 U" n={sum.usedStale ? `— / ${sum.totalU}U` : `${sum.usedU} / ${sum.totalU}U`} s={sum.usedStale ? '다시 불러오는 중…' : sum.usePct == null ? '—' : `${sum.usePct}% · 빈 자리 ${sum.freeU}U`} />
            <Tile k="배치된 장비" n={sum.devices} s={`서버 ${sum.servers} · 그 밖 ${sum.manual}`} />
            <Tile k="미배치 서버" n={sum.unplaced} s="iDRAC 등록 · 원장에 없음" color={sum.unplaced ? '#fcd34d' : undefined} />
            <Tile k="서버 장애 · 경고" n={`${sum.crit} · ${sum.warn}`} s={`못 읽음 ${sum.unknown} · 연결 안 됨 ${sum.nolink}`} color={sum.crit ? '#fca5a5' : undefined} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
            <div style={{ ...card, flex: '999 1 560px' }}>
              {view.staleErr ? <div style={{ padding: '6px 14px' }}><StaleBanner what="전산실을" error={view.staleErr} locked onRetry={() => loadRoom(roomIdRef.current)} /></div> : null}
              {!racks.length ? (
                <div style={{ padding: 18, fontSize: 13, color: 'var(--text-dim)' }}>이 전산실에 랙이 없습니다.{canEdit ? ' ‘배치 편집’ › ‘+ 랙’ 으로 추가하세요.' : ''}</div>
              ) : (
                <div style={{ display: 'flex', gap: 14, overflowX: 'auto', padding: 12, alignItems: 'flex-end' }}>
                  {racks.map((r) => (
                    <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 auto' }}>
                      <RackColumn rack={r} places={placesByRack.get(r.id) || []} mode={mode} face={face} q={q} selId={selId} onPick={setSelId}
                        edit={edit && canEdit} drag={{ ...drag, ...(dragInfo || {}) }} onDragOverRack={onDragOverRack} onDropRack={onDropRack} onDragLeaveRack={onDragLeaveRack} preview={preview} />
                      {edit && canEdit ? <button type="button" style={{ ...btn, height: 26, alignSelf: 'flex-start' }} aria-label={`랙 ${r.name} 고치기`} onClick={() => { setModalErr(''); setModal({ kind: 'rack', init: r }); }}>랙 고치기</button> : null}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '8px 14px', borderTop: '1px solid var(--border-soft)', fontSize: 11.5, color: '#aebbd0' }}>
                {legend.map((l) => <span key={l.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 18, height: 12, borderRadius: 3, background: l.bg, border: `1px solid ${l.bd}` }} />{l.label}</span>)}
                {face === 'rear' ? <span>{mode === 'status' ? '후면 보기 — 점선 테두리 = 앞에서 꽂은 전체 깊이 장비의 뒷면(색은 상태)' : '후면 보기 — 회색 = 앞에서 꽂은 전체 깊이 장비의 뒷면'}</span> : null}
                <span>랙 옆 세로 띠 = 세로 PDU(A · B 계통 수 — 전력 측정값은 표시하지 않습니다)</span>
              </div>
            </div>

            <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={card}>
                <Detail p={selected} rack={selRack} edit={edit && canEdit} onEdit={() => { setModalErr(''); setModal({ kind: 'place', init: { ...selected } }); }} />
              </div>
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
                  <strong>미배치 서버</strong><span style={{ color: 'var(--text-dim)' }}>{q.trim() && unplacedMode(view) === 'list' ? `${unplacedHit.length} / ${view.unplacedTotal}` : view.unplacedTotal}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>{edit && canEdit ? '랙으로 끌어 놓기' : 'iDRAC 등록 · 원장에 없음'}</span>
                </div>
                {unplacedMode(view) === 'list' ? (<>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {unplacedHit.slice(0, unplacedShow).map((u) => (
                  <div key={u.serverId}
                    draggable={edit && canEdit}
                    onDragStart={edit && canEdit ? (e) => { try { e.dataTransfer.setData('text/plain', u.serverId); } catch { /* */ } setDragInfo({ type: 'server', size: 1, face: 'full', ...u }); } : undefined}
                    onDragEnd={edit && canEdit ? () => drag.end() : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderTop: '1px solid var(--border-soft)', minHeight: 44, boxSizing: 'border-box', cursor: edit && canEdit ? 'grab' : 'default' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', color: '#c3cee0' }}>서버</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ ...mono, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name || u.hostname || u.serverId}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{[u.model, u.serviceTag].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                    {edit && canEdit && racks.length ? <button type="button" style={{ ...btn, height: 26 }} aria-label={`${u.name || u.hostname || '서버'} 놓기`} onClick={() => { setModalErr(''); setModal({ kind: 'place', init: { rackId: racks[0].id, kind: 'server', label: defaultLabelOf(u), model: u.model || '', serial: u.serviceTag || '' } }); }}>놓기</button> : null}
                  </div>
                ))}
                </div>
                {q.trim() && !unplacedHit.length && (view.unplaced || []).length ? <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>검색어와 맞는 미배치 서버가 없습니다.</div> : null}
                {unplacedHit.length > unplacedShow ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{unplacedShow}대를 보여 줍니다({unplacedHit.length - unplacedShow}대 더 있음) — 검색 칸에 이름 · 모델 · 서비스 태그를 넣어 좁힐 수 있습니다.</span>
                    <button type="button" style={{ ...btn, height: 26 }} onClick={() => setUnplacedShow((n) => n + UNPLACED_PAGE)}>더 보기</button>
                  </div>
                ) : null}
                {view.unplacedTotal > (view.unplaced || []).length ? <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>서버가 많아 앞 {(view.unplaced || []).length}대만 받았습니다(전체 {view.unplacedTotal}대) — 검색은 받은 목록 안에서만 됩니다.</div> : null}
                </>) : <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>미배치 서버의 목록(등록부 이름 · 서비스 태그)은 관리자에게만 보입니다 — 이 계정에는 대수만 보입니다.</div>}
                {view.serversNoTag ? <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>서비스 태그를 못 읽었거나 태그가 공통 기본값(여러 서버가 같은 값)인 서버 {view.serversNoTag}대는 태그로 이을 수 없어 미배치에서 뺐습니다.</div> : null}
              </div>
              <div style={card}>
                <div style={{ padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center' }}><strong>변경 이력</strong><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>최근 {view.logs.length}건</span></div>
                {view.logs.length ? (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 300, overflowY: 'auto', borderTop: '1px solid var(--border-soft)' }}>
                    {view.logs.map((l, i) => (
                      <li key={`${l.ts}-${i}`} style={{ padding: '7px 14px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0 8px', color: 'var(--text-dim)', fontSize: 11 }}>
                          <span style={mono}>{new Date(l.ts).toLocaleString()}</span>
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{ACTION_LABEL[l.action] || l.action}</span>
                          {l.user ? <span>{l.user}</span> : null}
                        </span>
                        <span style={{ overflowWrap: 'anywhere' }}>{l.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : <div style={{ padding: '0 14px 12px', fontSize: 12, color: 'var(--text-dim)' }}>아직 변경이 없습니다.</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {modal?.kind === 'place' ? (
        <PlaceModal init={modal.init} racks={racks} busy={busy} saving={busy && busyModal === modal} error={roomChangedText || shownModalErr} onClose={closeModal} onSave={savePlace}
          onRemove={async () => {
            if (lostView()) return;
            if (!window.confirm(`‘${modal.init.label || modal.init.serial || '이름 없음'}’ 을(를) 랙에서 뺄까요? 판 기록에서 되돌릴 수 있습니다.`)) return;
            const r = await run({ op: 'place.remove', id: modal.init.id, rev: view.rev }, { okText: '장비를 뺐습니다.', roomId: view.room.id }); if (r) setSelId(''); afterRoomWrite(r);
          }} />
      ) : null}
      {modal?.kind === 'rack' ? (
        <RackModal init={modal.init} types={types} busy={busy} saving={busy && busyModal === modal} error={roomChangedText || shownModalErr} onClose={closeModal}
          onSave={async (f, f0) => {
            if (lostView()) return;
            let r;
            if (modal.init.id) {   // 고치기는 달라진 칸만(장비 고치기와 같은 이유)
              const rack = changedFields(f0, f, ['name', 'row', 'role', 'pduA', 'pduB']);
              if (String(f.typeId || '') !== String(f0?.typeId || '')) { rack.typeId = f.typeId; if (!f.typeId) rack.heightU = f.heightU; }
              else if (!f.typeId && String(f.heightU ?? '').trim() !== String(f0?.heightU ?? '').trim()) rack.heightU = f.heightU;
              if (!Object.keys(rack).length) { nothingChanged(); return; }
              r = await run({ op: 'rack.update', id: modal.init.id, rev: view.rev, rack }, { roomId: view.room.id });
            } else {
              const rack = { name: f.name, row: f.row, role: f.role, pduA: f.pduA, pduB: f.pduB, typeId: f.typeId, ...(f.typeId ? {} : { heightU: f.heightU }) };
              r = await run({ op: 'rack.add', roomId: view.room.id, rev: view.rev, rack }, { okText: '랙을 추가했습니다.', roomId: view.room.id });
            }
            afterRoomWrite(r);
          }}
          onRemove={async () => {
            if (lostView()) return;
            if (!window.confirm(`랙 ‘${modal.init.name || ''}’ 을(를) 지울까요? 판 기록에서 되돌릴 수 있습니다.`)) return;
            afterRoomWrite(await run({ op: 'rack.remove', id: modal.init.id, rev: view.rev }, { okText: '랙을 지웠습니다.', roomId: view.room.id }));
          }} />
      ) : null}
      {/* 이름 창은 **연 때의 대상**(modal.id · siteId · corpId)에 쓴다 — 늦게 온 추가 응답이 선택을 바꾼 뒤 저장 · 지우기가 새 항목으로 나갔다(3회차 점검 화면 1 · 재현).
          쓰기 뒤 선택을 새 항목으로 옮기는 것은 사용자가 그 사이 자리를 옮기거나 다른 창을 열지 않았을 때만(unmoved). */}
      {modal?.kind === 'site' ? (
        <NameModal title={`데이터센터 추가 — ${(corps.find((c) => c.id === modal.corpId) || corp)?.name || ''}`} busy={busy} saving={busy && busyModal === modal} error={modalErr} onClose={closeModal}
          onSave={async (name) => {
            const at = whereNow(); const target = nameTarget(modal, at).corpId;
            const r = await run({ op: 'site.add', corpId: target, name }, { okText: '데이터센터를 추가했습니다.', corpId: target });
            if (r) { await loadTree(); if (unmoved(at)) setSiteId(r.id); }
          }} />
      ) : null}
      {modal?.kind === 'site-edit' ? (
        <NameModal title={`데이터센터 이름 · 삭제 — ${modal.name || ''}`} init={modal.name || ''} busy={busy} saving={busy && busyModal === modal} error={modalErr} onClose={closeModal}
          onSave={async (name) => { const { id } = nameTarget(modal); if (await run({ op: 'site.rename', id, name }, { siteId: id })) await loadTree(); }}
          onRemove={async () => { const { id } = nameTarget(modal); if (!window.confirm(`데이터센터 ‘${modal.name || ''}’ 을(를) 지울까요? 판 기록에서 되돌릴 수 있습니다.`)) return; if (await run({ op: 'site.remove', id }, { okText: '데이터센터를 지웠습니다.', siteId: id })) await loadTree(); }} removeLabel="데이터센터 지우기(전산실이 없을 때만)" />
      ) : null}
      {modal?.kind === 'room' ? (
        <NameModal title={`전산실 추가${modal.siteName ? ` — ${modal.siteName}` : ''}`} busy={busy} saving={busy && busyModal === modal} error={modalErr} onClose={closeModal}
          onSave={async (name) => {
            const at = whereNow(); const target = nameTarget(modal, at).siteId;
            const r = await run({ op: 'room.add', siteId: target, name }, { okText: '전산실을 추가했습니다.', siteId: target });
            if (r) { await loadTree(); if (unmoved(at)) setRoomId(r.id); }
          }} />
      ) : null}
      {modal?.kind === 'room-edit' ? (
        <NameModal title={`전산실 이름 · 삭제 — ${modal.name || ''}`} init={modal.name || ''} busy={busy} saving={busy && busyModal === modal} error={modalErr} onClose={closeModal}
          onSave={async (name) => { const { id } = nameTarget(modal); if (await run({ op: 'room.rename', id, name }, { roomId: id })) await Promise.all([loadTree(), loadRoom(roomIdRef.current)]); }}
          onRemove={async () => { const { id } = nameTarget(modal); if (!window.confirm(`전산실 ‘${modal.name || ''}’ 을(를) 지울까요? 판 기록에서 되돌릴 수 있습니다.`)) return; if (await run({ op: 'room.remove', id }, { okText: '전산실을 지웠습니다.', roomId: id })) await loadTree(); }} removeLabel="전산실 지우기(랙이 없을 때만)" />
      ) : null}
      {modal?.kind === 'versions' ? (
        <VersionsModal corpId={corpId} corpName={corp?.name || corpId} isAdmin={!!tree.isAdmin} onClose={closeModal}
          onRestored={async (text, forCorp) => {
            // 되돌리는 동안 창을 닫았거나 법인을 바꿨을 수 있다 — 그 창이 아직 열려 있을 때만 닫고, 그 법인을 보고 있을 때만 알린다.
            if (modalRef.current === modal) setModal(null);
            if (forCorp === corpIdRef.current) say('ok', text);
            await Promise.all([loadTree(), loadRoom(roomIdRef.current)]);
          }}
          onFailed={(text, forCorp) => {
            // 창이 아직 열려 있으면 창 안 문구로 충분하다 — 닫았을 때만(그리고 그 법인을 보고 있을 때만) 알림 줄에 올린다.
            if (modalRef.current !== modal && spotVisible({ corp: forCorp }, { corp: corpIdRef.current })) say('err', `판 되돌리기를 하지 못했습니다 — ${text}`);
          }} />
      ) : null}
      {modal?.kind === 'census' ? <RackMaskCensus onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'types' ? (
        <TypesModal types={types} busy={busy} saving={busy && busyModal === modal} error={modalErr} onClose={closeModal}
          onAdd={async (name, heightU) => { const r = await run({ op: 'type.add', name, heightU }, { okText: '랙 종류를 추가했습니다.', closeModal: false }); if (r) await loadTree(); return !!r; }}
          onRemove={async (id) => { if (!window.confirm(`랙 종류 ‘${types.find((t) => t.id === id)?.name || ''}’ 을(를) 지울까요?`)) return; if (await run({ op: 'type.remove', id }, { okText: '랙 종류를 지웠습니다.', closeModal: false })) await loadTree(); }} />
      ) : null}
    </div>
  );
}
