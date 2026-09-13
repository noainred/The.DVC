/**
 * 고아 VMDK 찾기(v2.505) — 데이터스토어에 있지만 **어떤 VM 에도 연결되지 않은** 가상디스크.
 *
 * 사용자 요청: "VMDK 같은 파일이 VM에 연결되지 않은 상태인지 찾아내는 기능".
 *
 * 화면 설계 의도:
 *  1. 스캔은 데이터스토어 1개씩 **라이브**로 돈다(파일 많으면 수십 초). 그래서 먼저 목록에서
 *     대상을 고르게 하고, 스캔 불가 vCenter(엣지 위임)는 **목록에서 미리 밝힌다** — 누르고 나서
 *     실패하는 것보다 정직하다.
 *  2. 결과는 '삭제 대상' 이 아니라 **'확인 필요 후보'** 다. 공유 데이터스토어 경고와 신뢰도를
 *     결과 위에 둔다(아래로 밀면 안 읽는다).
 *  3. 왜 후보에서 빠졌는지(FCD·콘텐츠 라이브러리·Replication·CBT)를 접어서라도 보여준다 —
 *     "왜 내가 아는 그 파일이 안 나오지" 에 답해야 한다.
 *  4. **삭제 버튼은 없다**(의도적). 서버에도 삭제 API 가 없다.
 *
 * 판정·문구는 `orphanVmdkText.js`(순수, 테스트 고정). 이 파일은 조립만 한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, DataTable, SearchBox } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';
// 서버 문구의 `**강조**` 를 굵게 — 별표가 그대로 보이는 v2.439/v2.440 재발 방지(components/boldText.jsx).
import BoldText from '../../components/boldText.jsx';
import {
  fmtBytes, summaryText, basisText, verdictLabel, verdictTone,
  confidenceTone, confidenceLabel, scanStateNote, truncatedNote,
  excludedByReason, excludeLabel, HOLD_HOURS, VERDICT,
} from './orphanVmdkText.js';

export function OrphanVmdk({ scope }) {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const { loading, data, error } = useTool('/tools/orphan-vmdk/datastores', scope ? { vcenterId: scope } : {});
  const [dsId, setDsId] = useState('');
  const [q, setQ] = useState('');
  const [holdHours, setHoldHours] = useState(24);
  const [res, setRes] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState('');
  const [showExcluded, setShowExcluded] = useState(false);

  // 대상을 바꾸면 이전 결과를 비운다 — 다른 데이터스토어 결과가 남아 있으면 오판한다
  // (루트 CLAUDE.md: 스코프 변경 시 직전 데이터 표시 금지와 같은 규칙).
  useEffect(() => { setRes(null); setScanErr(''); }, [dsId]);

  const items = data?.items || [];
  const picked = useMemo(() => items.find((d) => d.id === dsId) || null, [items, dsId]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((d) => !needle || `${d.name} ${d.vcenterId}`.toLowerCase().includes(needle));
  }, [items, q]);

  const runScan = async () => {
    if (!dsId || scanning) return;
    setScanning(true); setScanErr(''); setRes(null);
    try {
      const r = await fetchJson(`/tools/orphan-vmdk?datastoreId=${encodeURIComponent(dsId)}&recentHours=${holdHours}`);
      setRes(r);
    } catch (e) {
      // 오류를 삼키지 않는다(v2.493) — '고아 0건' 과 '조회 실패' 는 사용자가 할 일이 다르다.
      setScanErr(e?.message || '스캔에 실패했습니다.');
    } finally { setScanning(false); }
  };

  if (loading) return <Loading label="데이터스토어 목록" />;
  if (error) return <ErrorBox message={error} />;

  const note = scanStateNote({ ds: dsId, loading: scanning, error: scanErr, result: res });
  const trunc = truncatedNote(res);
  const exRows = excludedByReason(res?.excluded);

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>이 기능이 하는 일</div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          데이터스토어의 실제 파일 목록과, 그 데이터스토어를 쓰는 <b>VM 전부가 소유한 파일 목록</b>
          (vCenter <code>layoutEx.file</code>)을 대조해 <b>아무 VM 도 쓰지 않는 VMDK</b> 를 찾습니다.
          <br />
          <b>삭제 기능은 제공하지 않습니다.</b> 결과는 언제나 <b>확인 필요 후보</b>이며, 삭제 판단은 사람이 합니다 —
          아래 경고를 반드시 읽어 주세요.
        </div>
      </div>

      {/* 대상 선택 */}
      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <SearchBox value={q} onChange={setQ} placeholder="데이터스토어·vCenter 검색" />
        <span className="muted" style={{ fontSize: 12 }}>판정 보류 창</span>
        {HOLD_HOURS.map(([h, l]) => (
          <button key={h} className={holdHours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }}
            onClick={() => setHoldHours(h)}
            title="이 시간 안에 변경된 파일은 '판정 보류'로 뺍니다(복제·백업 진행 중일 수 있습니다).">{l}</button>
        ))}
        <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={!dsId || scanning} onClick={runScan}>
          {scanning ? '스캔 중…' : '🔍 스캔 실행'}
        </button>
      </div>

      <DataTable rows={rows} initialSort={{ key: 'usedGB', dir: 'desc' }} columns={[
        {
          key: 'name',
          label: '데이터스토어',
          render: (d) => (
            <button className="cell-link" onClick={() => setDsId(d.id)} style={{ fontWeight: dsId === d.id ? 700 : 400 }}>
              {dsId === d.id ? '▶ ' : ''}{d.name}
            </button>
          ),
        },
        { key: 'vcenterId', label: 'vCenter', render: (d) => <span className="muted" style={{ fontSize: 12 }}>{d.vcenterId}</span> },
        { key: 'type', label: '유형', render: (d) => <span className="muted" style={{ fontSize: 12 }}>{d.type || '—'}</span> },
        { key: 'usedGB', label: '사용 GB', align: 'right', render: (d) => <span>{d.usedGB == null ? '—' : Math.round(d.usedGB).toLocaleString()}</span> },
        { key: 'freeGB', label: '여유 GB', align: 'right', render: (d) => <span>{d.freeGB == null ? '—' : Math.round(d.freeGB).toLocaleString()}</span> },
        {
          key: 'scannable',
          label: '스캔',
          render: (d) => (d.scannable
            ? <span className="badge green" style={{ fontSize: 11 }}>가능</span>
            : <span className="badge amber" style={{ fontSize: 11 }} title={d.notScannableReason}>불가</span>),
        },
      ]} emptyText="조회 범위에 데이터스토어가 없습니다." />

      {picked && !picked.scannable && (
        <div className="badge amber" style={{ fontSize: 12, marginTop: 10, display: 'block', padding: '8px 10px' }}>
          {picked.notScannableReason} — 그 법인 포탈에서 실행하세요.
        </div>
      )}

      {/* 상태 문구 */}
      {note && (
        <div className={note.kind === 'error' ? 'badge amber' : 'muted'}
          style={{ fontSize: 12.5, marginTop: 12, display: 'block', padding: note.kind === 'error' ? '8px 10px' : 0 }}>
          {note.text}
        </div>
      )}
      {scanning && <Loading label="데이터스토어 탐색" />}

      {/* 결과 */}
      {res && !res.mock && (
        <div style={{ marginTop: 16 }}>
          {/* ⚠ 경고와 신뢰도를 결과 위에 둔다(아래로 밀면 안 읽는다). 지우지 말 것. */}
          <div className="card" style={{ borderColor: 'var(--amber)', marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              <b>⚠ 삭제 전 반드시 확인</b><br />
              <BoldText text={res.sharedDatastoreWarning} />
            </div>
          </div>
          <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
            <span className={`badge ${confidenceTone(res.confidence?.level)}`}>{confidenceLabel(res.confidence?.level)}</span>
            <span className="muted" style={{ fontSize: 12 }}>{res.confidence?.text}</span>
          </div>
          {trunc && <div className="badge amber" style={{ fontSize: 12, marginBottom: 10, display: 'block', padding: '8px 10px' }}>{trunc}</div>}

          <div className="kpis" style={{ marginBottom: 12 }}>
            <Card label="소유 VM 없음" value={`${res.summary?.orphanDisks ?? 0}개`} meta={fmtBytes(res.summary?.orphanBytes)} accent="var(--red)" />
            <Card label="미등록 VM 폴더" value={`${res.summary?.unregisteredDisks ?? 0}개`} meta={fmtBytes(res.summary?.unregisteredBytes)} accent="var(--amber)" />
            <Card label="판정 보류" value={`${res.summary?.holdDisks ?? 0}개`} meta={fmtBytes(res.summary?.holdBytes)} />
            <Card label="제외(정상)" value={`${res.summary?.excludedFiles ?? 0}개`} meta={fmtBytes(res.summary?.excludedBytes)} />
          </div>
          <div style={{ fontSize: 12.5, marginBottom: 4 }}><BoldText text={summaryText(res)} /></div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>{basisText(res)}</div>

          <DataTable rows={res.disks || []} initialSort={{ key: 'sizeBytes', dir: 'desc' }} columns={[
            {
              key: 'verdict',
              label: '판정',
              render: (d) => <span className={`badge ${verdictTone(d.verdict)}`} style={{ fontSize: 11 }} title={VERDICT[d.verdict]?.desc || ''}>{verdictLabel(d.verdict)}</span>,
            },
            { key: 'folder', label: '폴더', render: (d) => <span style={{ fontSize: 12, fontFamily: 'monospace' }}>{d.folder}</span> },
            { key: 'name', label: '디스크', render: (d) => <b style={{ fontSize: 12, fontFamily: 'monospace' }}>{d.name}</b> },
            {
              key: 'sizeBytes',
              label: '크기',
              align: 'right',
              render: (d) => <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(d.sizeBytes)}</b>,
            },
            {
              key: 'files',
              label: '파일',
              sortValue: (d) => (d.files || []).length,
              render: (d) => (
                <span className="muted" style={{ fontSize: 11.5 }} title={(d.files || []).map((f) => `${f.name} (${fmtBytes(f.sizeBytes)})`).join('\n')}>
                  {(d.files || []).length}개
                </span>
              ),
            },
            { key: 'modified', label: '최종 변경', render: (d) => <span className="muted" style={{ fontSize: 11.5 }}>{d.modified ? new Date(d.modified).toLocaleString('ko-KR') : '—'}</span> },
            { key: 'reason', label: '비고', render: (d) => <span className="muted" style={{ fontSize: 11.5 }}>{d.reason || ''}</span> },
          ]} emptyText="연결되지 않은 VMDK 후보가 없습니다." />

          {/* 왜 후보에서 빠졌는가 — "내가 아는 그 파일이 왜 안 나오지" 에 답한다. */}
          {exRows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button className="tab" style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setShowExcluded((v) => !v)}>
                {showExcluded ? '▾' : '▸'} 후보에서 제외한 파일 {res.summary?.excludedFiles}개 ({fmtBytes(res.summary?.excludedBytes)})
              </button>
              {showExcluded && (
                <div style={{ marginTop: 8 }}>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                    아래는 <b>VM 소유가 아닌 것이 정상</b>인 파일들입니다 — 지우면 쿠버네티스 PV·콘텐츠 라이브러리·복제 구성이 깨집니다.
                  </div>
                  <DataTable rows={exRows} initialSort={{ key: 'sizeBytes', dir: 'desc' }} columns={[
                    { key: 'reason', label: '제외 사유', render: (e) => <span>{excludeLabel(e.reason)}</span> },
                    { key: 'files', label: '파일 수', align: 'right', render: (e) => <span>{e.files.toLocaleString()}</span> },
                    { key: 'sizeBytes', label: '크기', align: 'right', render: (e) => <span>{fmtBytes(e.sizeBytes)}</span> },
                  ]} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default OrphanVmdk;
