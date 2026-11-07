/**
 * GpuAllocPlace — GPU 할당율 '배치 추천'(v2.937 개선 4 — 사용자 결정 '시안 없이 바로 구현').
 * vGPU 프로파일을 고르면 그 VM 을 하나 더 놓을 수 있는 GPU 를 보여 준다. 판정은 화면이 이미 받은 계층(서버 allocTree 의 슬롯·용량)만 쓴다 —
 * 새로 묻지 않는다(gpuAllocText.placementCandidates · 순수 · 시험). 화면의 법인 칩 선택을 따른다.
 */
import React, { useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { placementCandidates, profileOptions, profileGB, numText } from './gpuAllocText.js';

const SKIP_TEXT = { down: '끊긴 호스트', noPlacement: '배치 정보 없음', mixed: '혼합 크기', otherProfile: '다른 프로파일이 올라감', capUnknown: '용량 모름', small: '용량이 작음' };

export function GpuAllocPlace({ tree, vcSel }) {
  const opts = useMemo(() => profileOptions(tree, vcSel), [tree, vcSel]);
  const [pick, setPick] = useState('');
  const [typed, setTyped] = useState('');
  const profile = (typed.trim() || pick || opts[0]?.profile || '').trim();
  const r = useMemo(() => (profile ? placementCandidates(tree, profile, vcSel) : null), [tree, profile, vcSel]);
  const skipped = r ? Object.entries(r.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${SKIP_TEXT[k]} ${n}장`) : [];
  return (
    <div className="gpu-alloc-place" data-gpu-alloc-place="">
      <div className="card gpu-alloc-panel">
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>어디에 놓을 수 있나</b>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>프로파일
            <Select sort={false} className="input" value={typed ? '' : (pick || opts[0]?.profile || '')} onChange={(e) => { setPick(e.target.value); setTyped(''); }} style={{ maxWidth: 260 }}>
              {opts.length === 0 && <option value="">(쓰는 프로파일 없음)</option>}
              {opts.map((o) => <option key={o.profile} value={o.profile}>{o.profile} — VM {o.vms}대</option>)}
            </Select>
          </label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>또는 직접
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="예: nvidia_l4-12q" style={{ maxWidth: 200 }} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>
          같은 GPU 에는 같은 vGPU 프로파일만 올라갑니다. 그래서 <b>같은 프로파일이 올라간 GPU 의 남은 슬롯</b>을 먼저(빈 GPU 를 아껴 두도록 남은 슬롯이 적은 것부터),
          그다음 <b>모델이 맞는 빈 GPU</b>를 보여 줍니다. 끊긴 호스트 · 배치 정보 없는 GPU · 다른 프로파일 GPU 는 뺍니다. 켜진 VM 기준이라 꺼진 VM 이 다시 켜질 자리는 따로 세지 않습니다.
        </div>
      </div>
      {!profile ? null : r.per == null || !r.family ? (
        <div className="card gpu-alloc-panel"><span className="muted">‘{profile}’ 을 프로파일로 읽지 못했습니다 — 이름 끝이 ‘-숫자+문자’(예: -12q · -24c)여야 GB 를 압니다.</span></div>
      ) : (
        <>
          <div className="gpu-alloc-kpis">
            <div className="card gpu-alloc-kpi"><div className="muted lbl">프로파일</div><div className="val" style={{ fontSize: 18 }}>{profile}</div><div className="muted sub">{numText(profileGB(profile))} GB · 계열 {r.family.toUpperCase()}{r.mig ? ' · MIG' : ''}</div></div>
            <div className="card gpu-alloc-kpi spare"><div className="muted lbl">같은 프로파일 GPU 의 남은 슬롯</div><div className="val">{r.same}<small> 대</small></div><div className="muted sub">지금 바로 놓을 수 있는 수</div></div>
            <div className="card gpu-alloc-kpi"><div className="muted lbl">빈 GPU 에 놓으면</div><div className="val">{r.empty}<small> 대</small></div><div className="muted sub">{r.mig ? 'MIG 구성에 따라 다름(추정)' : '빈 GPU 를 이 프로파일로 쓸 때'}</div></div>
          </div>
          {skipped.length > 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>모델이 맞지만 뺀 GPU: {skipped.join(' · ')}</div>}
          {r.rows.length === 0 ? (
            <div className="card gpu-alloc-panel"><span className="muted">놓을 수 있는 GPU 가 없습니다{vcSel && vcSel.size ? ` (법인 ${[...vcSel].join(', ')} 선택 중)` : ''}.</span></div>
          ) : (
            <STable className="gpu-alloc-table" minWidth={980}>
              <thead><tr><th>법인</th><th>클러스터</th><th>호스트</th><th className="num">GPU</th><th>모델</th><th>지금</th><th className="num">놓을 수 있는 수</th><th>비고</th></tr></thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.id}>
                    <td title={x.vcName}>{x.vc}</td>
                    <td>{x.cluster}</td>
                    <td>{x.host}</td>
                    <td className="num">#{x.gpu}</td>
                    <td>{x.model}</td>
                    <td><span className={`badge ${x.kind === 'same' ? 'teal' : 'gray'}`}>{x.now}</span></td>
                    <td className="num spare" data-sort={x.fit}><b>{x.fit}</b></td>
                    <td className="note">{x.note}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
        </>
      )}
    </div>
  );
}

export default GpuAllocPlace;
