/**
 * 물리서버 폴더 — 서버 옆 패널(v2.984). 화면을 떠나지 않고 서버 한 대의 상태 · 폴더를 보고 옮기거나 뺀다.
 * 24시간 추이는 1단계에 없다 — 베어메탈 사용률 화면으로 넘긴다(그 화면이 대상 해석 · 범위 · 엣지 원시 이력 규약을 이미 갖고 있다).
 */
import React, { useState } from 'react';
import Select from '../../../components/Select.jsx';
import EscClose from '../../../components/EscClose.jsx';
import { UsageBar, StatusDot, SrcBadge } from './parts.jsx';
import { PLACE_LABEL, pathText, wattsText } from '../bmFoldersText.js';

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
      </div>
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
        <span className="flex wrap" style={{ gap: '4px 10px' }}>
          <a href="#/tools/bm-usage">베어메탈 사용률(추이)</a>
          <a href="#/tools/part-faults">물리 부품 장애</a>
          <a href="#/tools/fleet">통합 서버 인벤토리</a>
          <a href="#/tools/svc-inventory">서비스 인벤토리</a>
        </span>
      </div>
    </aside>
  );
}
