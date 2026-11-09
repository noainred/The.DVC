/**
 * GpuAllocDiag — GPU 할당율 '수집 점검'(v2.939 개선 2 — 실장비 확인 도구). 서버 /tools/gpu-alloc/diag(allocTree.allocDiag)는 이미 수집한
 * 스냅샷으로 이 화면이 기대는 가정(배치 정보 · 꺼진 VM 목록 · 패스스루 장치 주소 · 프로파일 이름)을 판정한다 — vCenter 에 새로 묻지 않는다.
 * 조회는 탭을 열 때 1회 + '다시 점검'. 늦게 온 이전 응답은 버린다(useLatest).
 */
import React, { useEffect, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { diagVerdicts } from './gpuAllocText.js';

export function GpuAllocDiag() {
  const run = useLatest();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => { setBusy(true); setErr(null); run(fetchJson('/tools/gpu-alloc/diag'), (d) => { setData(d); setBusy(false); }, (e) => { setErr(e); setBusy(false); }); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const vs = diagVerdicts(data);
  return (
    <div className="gpu-alloc-diag" data-gpu-alloc-diag="">
      <div className="card gpu-alloc-panel">
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>수집 점검</b>
          <span className="muted" style={{ fontSize: 12 }}>이미 수집한 값으로 판정합니다(vCenter 에 새로 묻지 않음 · 엣지 법인도 같음).</span>
          <button type="button" className="logout-btn" style={{ flex: 'none', padding: '6px 11px', marginLeft: 'auto' }} disabled={busy} onClick={load}>{busy ? '점검 중…' : '⟳ 다시 점검'}</button>
        </div>
      </div>
      {err && <ErrorBox error={err} />}
      <div className="gpu-alloc-verdicts">
        {vs.map((v) => (
          <div key={v.key} className={`card gpu-alloc-verdict${v.tone ? ` t-${v.tone}` : ''}`}>
            <div className="muted lbl">{v.title}</div>
            <div className="txt">{v.text}</div>
          </div>
        ))}
      </div>
      {(data.unparsedProfiles || []).length > 0 && (
        <div className="card gpu-alloc-panel">
          <b style={{ fontSize: 13 }}>GB 를 읽지 못한 프로파일 이름</b>
          <div className="flex gap wrap" style={{ marginTop: 6, gap: 6 }}>
            {data.unparsedProfiles.map((p) => <span key={p.profile} className="gpu-alloc-export-sheet renamed" title={`VM ${p.vms}대`}>{p.profile} · {p.vms}대</span>)}
          </div>
        </div>
      )}
      {(data.vcenters || []).length > 0 && (
        <STable className="gpu-alloc-table" minWidth={1100}>
          <thead>
            <tr>
              <th>법인</th><th className="num">GPU 호스트</th><th className="num">vGPU GPU</th><th className="num">배치 정보 없음</th><th className="num">패스스루 GPU</th><th className="num">주소 없음</th>
              <th className="num">꺼진 vGPU VM · 목록에 있음</th><th className="num">켜진 패스스루 VM · 주소 읽힘</th><th className="num">프로파일 못 읽음</th><th className="num">NIC · HBA 패스스루 VM</th>
            </tr>
          </thead>
          <tbody>
            {data.vcenters.map((v) => (
              <tr key={v.id}>
                <td title={v.name}>{v.id}</td>
                <td className="num">{v.gpuHosts}</td>
                <td className="num">{v.vgpuGpus}</td>
                <td className={`num${v.vgpuNoPlacement ? ' neg' : ''}`}>{v.vgpuNoPlacement}</td>
                <td className="num">{v.ptGpus}</td>
                <td className={`num${v.ptNoPci ? ' neg' : ''}`}>{v.ptNoPci}</td>
                <td className="num">{v.offVgpuVms} · {v.offListed}</td>
                <td className={`num${v.ptOnPciRead < v.ptOnVms ? ' neg' : ''}`}>{v.ptOnVms} · {v.ptOnPciRead}</td>
                <td className={`num${v.unparsedVms ? ' neg' : ''}`}>{v.unparsedVms}</td>
                <td className="num">{v.nonGpuPtVms}{v.nonGpuOnlyVms ? ` (뺌 ${v.nonGpuOnlyVms})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
    </div>
  );
}

export default GpuAllocDiag;
