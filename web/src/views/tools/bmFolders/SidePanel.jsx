/**
 * 물리서버 폴더 — 서버 옆 패널(v2.984). 화면을 떠나지 않고 서버 한 대의 상태 · 폴더를 보고 옮기거나 뺀다.
 * v2.987: 24시간 CPU · 메모리 추이(서버 비교와 같은 경로 — 이 노드 수집은 로컬, 엣지 수집은 그 엣지에서 서버당 요청 1개) · 관리 주소(관리자 판본만).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import Select from '../../../components/Select.jsx';
import EscClose from '../../../components/EscClose.jsx';
import { UsageBar, StatusDot, SrcBadge } from './parts.jsx';
import { PLACE_LABEL, pathText, wattsText, opErrorText } from '../bmFoldersText.js';
import { unitText } from '../../unitText.js';

export default function SidePanel({ r, corps, corpName, scoped, op, busy, onClose }) {
  const [to, setTo] = useState('');
  const corp = corps.find((c) => c.vcenterId === r.corp) || null;
  const writable = !!corp?.writable;
  const folders = (corp?.folders || []).map((f) => f.path).filter((p) => !(r.place && p === r.path));
  const tone = r.faults > 0 ? 'red' : r.cpu == null && r.mem == null ? 'none' : r.powered === false ? 'gray' : 'green';
  return (
    <aside className="card bmf-drawer" aria-label={`서버 상세 — ${r.name}`}>
      <EscClose onClose={onClose} />
      <div className="flex gap" style={{ alignItems: 'center', minWidth: 0 }}>
        <StatusDot tone={tone} />
        <b style={{ fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="logout-btn" style={{ padding: '4px 10px', flex: 'none' }} onClick={onClose}>닫기</button>
      </div>
      <div className="flex wrap" style={{ gap: 5 }}>
        <span className="bmf-tag">법인:{r.corp ? corpName(r.corp) : '(미지정)'}</span>
        <span className="bmf-tag">폴더:{r.place ? pathText(r.path) : '(미분류)'}</span>
        {r.model ? <span className="bmf-tag">모델:{r.model}</span> : null}
        {!scoped && r.serviceTag ? <span className="bmf-tag">태그:{r.serviceTag}</span> : null}
        <span className="bmf-tag">종류:{r.kind === 'esxi' ? 'ESXi 호스트' : '베어메탈'}</span>
      </div>
      {r.faults > 0 ? <div className="bmf-band red">부품 장애 {r.faults}건 — 특수 기능 › 물리 부품 장애에서 내용을 봅니다.</div> : null}
      <div className="bmf-kv">
        <span className="k">전원</span><span>{r.powered === true ? '켜짐' : r.powered === false ? '꺼짐' : '모름'}</span>
        <span className="k">CPU</span><UsageBar v={r.cpu} w={150} />
        <span className="k">메모리</span><UsageBar v={r.mem} w={150} />
        <span className="k">전력</span><span>{wattsText(r.watts)}</span>
        <span className="k">용량</span><span>{r.cores != null ? `${r.cores}코어` : '—'} · {r.memGB != null ? `${r.memGB} GB` : '—'}</span>
        <span className="k">받는 길</span><span><SrcBadge src={r.src} />{r.agent ? <span className="muted mono" style={{ fontSize: 11, marginLeft: 4 }}>{r.agent}</span> : null}</span>
        <span className="k">부품 장애</span><span>{r.faults == null ? '—(못 읽음)' : r.faults > 0 ? `${r.faults}건` : '없음'}</span>
        {r.addr ? <><span className="k">관리 주소</span><span className="mono" style={{ fontSize: 12 }}>{r.addr}</span></> : null}
      </div>
      <Trend k={r.key} kind={r.kind} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>폴더</span>
        <div className="bmf-mini">
          <b>{r.place ? `${r.corp ? corpName(r.corp) : ''} › ${pathText(r.path)}` : '(미분류)'}</b>
          <span className="muted" style={{ fontSize: 12 }}>{r.place ? PLACE_LABEL[r.place] : r.corp ? '아직 폴더가 없습니다' : '법인을 몰라 폴더에 넣을 수 없습니다'}{r.place === 'rule' ? ' — 규칙이 넣은 자리입니다(옮기면 손 등록이 됩니다)' : ''}</span>
        </div>
        {writable && r.corp ? (
          <div className="flex wrap gap" style={{ alignItems: 'center' }}>
            <Select className="select" value={to} onChange={(e) => setTo(e.target.value)} aria-label="옮길 폴더" style={{ maxWidth: 220 }}>
              <option value="">{r.place ? '옮길 폴더…' : '넣을 폴더…'}</option>
              {folders.map((p) => <option key={p} value={p}>{pathText(p)}</option>)}
            </Select>
            <button type="button" className="login-btn" style={{ padding: '5px 10px' }} disabled={busy || !to} onClick={async () => {
              const ok = await op({ op: 'assign', corp: r.corp, path: to, keys: [r.key], moveExisting: true, createMissing: false }, `‘${r.name}’ 을(를) ‘${pathText(to)}’ 에 넣었습니다.`);
              if (ok) setTo('');
            }}>{r.place ? '옮기기' : '넣기'}</button>
            {r.place === 'manual' ? <button type="button" className="logout-btn" style={{ padding: '5px 10px' }} disabled={busy} onClick={() => op({ op: 'unassign', keys: [r.key] }, `‘${r.name}’ 을(를) 폴더에서 뺐습니다.`)}>폴더에서 빼기</button> : null}
          </div>
        ) : r.corp && !writable ? <span className="muted" style={{ fontSize: 12 }}>이 법인은 조회 전용입니다.</span> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>바로가기</span>
        <span className="flex wrap bmf-links" style={{ gap: '4px 10px' }}>
          <a href="#/tools/bm-usage">베어메탈 사용률(추이)</a>
          <a href="#/tools/part-faults">물리 부품 장애</a>
          <a href="#/tools/fleet">통합 서버 인벤토리</a>
          <a href="#/tools/svc-inventory">서비스 인벤토리</a>
        </span>
      </div>
    </aside>
  );
}

const WHY = {
  esxi: 'ESXi 호스트의 추이는 호스트 화면에서 봅니다.',
  none: '이 기간에 쌓인 사용률 값이 없습니다(수집이 꺼져 있었거나 못 읽었을 수 있습니다).',
  'no-key': '사용률 대상 키가 없습니다.',
  'no-target': '베어메탈 사용률 수집 대상이 아닙니다(특수 기능 › 베어메탈 사용률에서 그 법인 수집을 켜야 추이가 쌓입니다).',
  'old-version': '이 서버를 수집하는 엣지가 구버전이라 추이를 받지 못했습니다(엣지 업그레이드 뒤 보입니다).',
  'edge-fail': '이 서버를 수집하는 엣지에서 추이를 받지 못했습니다(잠시 뒤 다시 열어 보십시오).',
};
/** 24시간 CPU · 메모리 추이 — 서버를 바꾸면 늦게 온 이전 응답은 버린다. 못 읽은 점은 선을 끊는다(0 으로 그리지 않는다). */
function Trend({ k, kind }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const cur = useRef('');
  useEffect(() => {
    cur.current = k; setD(null); setErr('');
    if (kind !== 'bm') { setD({ rows: [], why: 'esxi' }); return; }
    fetchJson('/tools/bm-folders/trend', { key: k, hours: 24 }).then((r) => { if (cur.current === k) setD(r); }).catch((e) => { if (cur.current === k) setErr(opErrorText(e)); });
  }, [k, kind]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>CPU · 메모리 — 지난 24시간</span>
      {err ? <span style={{ fontSize: 12, color: 'var(--red)' }}>{err}</span> : !d ? <span className="muted" style={{ fontSize: 12 }}>읽는 중…</span>
        : !d.rows?.length || d.why === 'none' ? <span className="muted" style={{ fontSize: 12 }}>{WHY[d.why] || WHY.none}{d.reason ? ` — ${d.reason}` : ''}</span> : <Spark rows={d.rows} />}
      {d?.via === 'edge' && d.rows?.length ? <span className="muted" style={{ fontSize: 11 }}>이 서버를 수집하는 엣지에서 받았습니다(구간 평균)</span> : null}
    </div>
  );
}
function Spark({ rows }) {
  const W = 356; const H = 96; const t0 = rows[0].ts; const t1 = rows[rows.length - 1].ts || t0 + 1;
  const x = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * (W - 30);
  const y = (v) => H - 14 - (Math.max(0, Math.min(100, v)) / 100) * (H - 24);
  const path = (k) => {
    let s = ''; let pen = false;
    for (const p of rows) { if (p[k] == null) { pen = false; continue; } s += `${pen ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)} `; pen = true; }
    return s.trim();
  };
  const last = (k) => { for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i][k] != null) return rows[i][k]; return null; };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`지난 24시간 CPU 마지막 ${unitText(last('cpu'), '%')} · 메모리 마지막 ${unitText(last('mem'), '%')}`}>
        {[0, 50, 100].map((v) => <g key={v}><line x1="0" x2={W - 30} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" /><text x={W - 26} y={y(v) + 3} fontSize="10" fill="var(--text-dim)">{v}%</text></g>)}
        <path d={path('mem')} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" />
        <path d={path('cpu')} fill="none" stroke="var(--accent)" strokeWidth="2" />
      </svg>
      <div className="flex wrap" style={{ gap: '4px 12px', fontSize: 11.5 }}>
        <span className="bmf-lg"><i style={{ background: 'var(--accent)' }} />CPU {last('cpu') ?? '—'}{last('cpu') != null ? '%' : ''}</span>
        <span className="bmf-lg"><i style={{ background: 'var(--accent-2)' }} />메모리 {last('mem') ?? '—'}{last('mem') != null ? '%' : ''}</span>
        <span className="muted">점 {rows.length}개(구간 평균)</span>
      </div>
    </div>
  );
}
