// v2.948 — SAN 스토리지 성능 › 분류 · 디렉터 매핑 탭(설계 ⑦ · 관리자). 자동 해석이 못 읽은 것만 사람이 채운다 — 저장은 표시에만 영향(표본 · 판정 데이터 불변) · 감사 로그.
//   저장은 전체 교체(지금 상태 + 편집) — 서버 directorMap.js 가 형식을 검사하고 400 사유를 돌려준다(조용히 버리지 않는다).
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, putJson, downloadFile, hasRole, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { dateClockText } from './sanStorageText.js';

const HEAVY_TIMEOUT_MS = 90_000;
const KIND_LABEL = { array: '어레이', host: '호스트(HBA)', unknown: '미확인' };
const BASIS_LABEL = { manual: '수동', serial: '시리얼 일치', name: '이름 규칙', flat: '평평한 이름', none: '없음' };
const CONF_LABEL = { manual: '수동', name: '이름 규칙', alias: '조닝 별칭', none: '구분 못 함' };

export default function SanStorageMapping({ dc, isAdmin }) {
  const [got, setGot] = useState(null);
  const [err, setErr] = useState(null);
  const [seq, setSeq] = useState(0);
  const [kinds, setKinds] = useState({});       // key → 'array'|'host'
  const [dirs, setDirs] = useState({});         // mapKey → { group, note, name }
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true);
  const canEdit = isAdmin && hasRole('admin');
  useEffect(() => {
    const ac = new AbortController();
    setGot(null); setErr(null);
    fetchJson('/tools/san-storage/mapping', dc ? { datacenterId: dc } : {}, ac.signal, { timeoutMs: HEAVY_TIMEOUT_MS, retries: 0 })
      .then((d) => { if (ac.signal.aborted) return; setGot(d); setKinds(Object.fromEntries(Object.entries(d.map?.kinds || {}).map(([k, v]) => [k, v.kind]))); setDirs({ ...(d.map?.directors || {}) }); })
      .catch((e) => { if (!ac.signal.aborted) setErr(e); });
    return () => ac.abort();
  }, [dc, seq]);
  const dirty = useMemo(() => {
    if (!got) return false;
    const k0 = Object.fromEntries(Object.entries(got.map?.kinds || {}).map(([k, v]) => [k, v.kind]));
    const d0 = Object.fromEntries(Object.entries(got.map?.directors || {}).map(([k, v]) => [k, v.group]));
    const d1 = Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, v.group]));
    return JSON.stringify(k0) !== JSON.stringify(kinds) || JSON.stringify(d0) !== JSON.stringify(d1);
  }, [got, kinds, dirs]);
  if (err) return <ErrorBox error={err.message} />;
  if (!got) return <Loading label="연결 대상 · 포트 이름을 모으는 중입니다." />;
  const targets = got.targets || [];
  const ports = (got.ports || []).filter((p) => !onlyPending || p.auto?.group == null || dirs[p.mapKey]);
  const save = async () => {
    setBusy(true); setMsg('');
    const dirBody = {};
    for (const [k, v] of Object.entries(dirs)) { const g = String(v?.group || '').trim(); if (g) dirBody[k] = { group: g, note: v.note || '', name: v.name || '' }; }
    try {
      const r = await putJson('/tools/san-storage/mapping', { kinds, directors: dirBody });
      if (r?.ok === false) { setMsg(`저장하지 못했습니다 — ${r.reason || '서버가 거부했습니다'}`); return; }
      setMsg('저장했습니다 — 현황 · 점검은 다음 조회부터 반영됩니다(집계 기억은 수집 주기만큼 남을 수 있습니다).'); setSeq((n) => n + 1); }
    catch (e) { setMsg(e.message || '저장 실패'); }
    finally { setBusy(false); }
  };
  const recent = [...Object.entries(got.map?.kinds || {}).map(([k, v]) => ({ at: v.at, by: v.by, text: `${k} 분류 → ${KIND_LABEL[v.kind]}` })),
    ...Object.entries(got.map?.directors || {}).map(([k, v]) => ({ at: v.at, by: v.by, text: `${k.split('|')[0]} 포트 ${k.split('|').slice(1).join(':')} → ${v.group}` }))]
    .filter((x) => x.at).sort((a, b) => b.at - a.at).slice(0, 8);
  return (
    <>
      <div className="sst-row">
        <div className="sst-filters">
          <span className="sst-pill">연결 대상 <b>{(got.counts?.array ?? 0) + (got.counts?.host ?? 0) + (got.counts?.unknown ?? 0)}</b></span>
          <span className="sst-pill">어레이 <b>{got.counts?.array ?? 0}</b> · 호스트(HBA) <b>{got.counts?.host ?? 0}</b> · 미확인 <b>{got.counts?.unknown ?? 0}</b></span>
          <span className="sst-pill">구분 못 한 포트 <b>{(got.ports || []).filter((p) => p.auto?.group == null && !got.map?.directors?.[p.mapKey]).length}</b> · 수동 매핑 <b>{Object.keys(got.map?.directors || {}).length}</b> · 분류 재정의 <b>{Object.keys(got.map?.kinds || {}).length}</b></span>
        </div>
        <div className="sst-acts">
          {canCsv() && isAdmin && <button type="button" className="sst-btn sm" onClick={() => downloadFile('/tools/san-storage/port-names.csv')} title="port_meta 의 연결 장비 심볼릭 이름 · WWN · 속도 — 벤더 이름 형식 확인용(스위치에 접속하지 않습니다). 공개 저장소에 올리지 마세요.">포트 이름 CSV 내보내기</button>}
          {canEdit && <button type="button" className="sst-btn primary" disabled={!dirty || busy} onClick={save}>저장</button>}
          {canEdit && dirty && <button type="button" className="sst-btn" onClick={() => setSeq((n) => n + 1)}>되돌리기</button>}
        </div>
      </div>
      {!canEdit && <div className="sst-info">관리자만 분류 · 매핑을 바꿀 수 있습니다 — 지금은 보기만 됩니다.</div>}
      {msg && <div className="sst-note">{msg}</div>}
      <div className="sst-two" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="sst-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="sst-cardhead" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)' }}><div className="sst-title"><h4>① 연결 대상 분류 — 어레이 / 호스트</h4><span className="muted" style={{ fontSize: 12 }}>· 어레이 전부와 이름 규칙만으로 분류된 것 · 재정의된 것</span></div>{got.targetsOmitted ? <span className="muted" style={{ fontSize: 12 }}>{got.targetsOmitted}개 더(상한)</span> : null}</div>
            <div className="sst-table-wrap">
              <STable minWidth={760}>
                <thead><tr><th>연결 대상(키)</th><th>법인</th><th>심볼릭 이름(첫 포트)</th><th>자동 분류 · 근거</th><th>적용</th><th>동작</th></tr></thead>
                <tbody>
                  {targets.map((t) => {
                    const applied = kinds[t.key] || t.autoKind.kind;
                    return (
                      <tr key={`${t.datacenterId}|${t.key}`}>
                        <td data-sort={t.key}><b className="mono">{t.key}</b><div className="sst-sub">포트 {t.ports}</div></td>
                        <td>{t.datacenterName}</td>
                        <td className="mono" style={{ fontSize: 11.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }} title={t.firstName}>{t.firstName || '—'}</td>
                        <td><span className={`sst-tag ${t.autoKind.kind === 'array' ? 'ok' : 'gray'}`}>{KIND_LABEL[t.autoKind.kind]} · {BASIS_LABEL[t.autoKind.basis] || t.autoKind.basis}</span></td>
                        <td>{kinds[t.key] ? <span className="sst-tag blue">{KIND_LABEL[kinds[t.key]]} · 수동</span> : <span className="muted">자동</span>}</td>
                        <td>{canEdit && (kinds[t.key]
                          ? <button type="button" className="sst-btn sm" onClick={() => setKinds((p) => { const n = { ...p }; delete n[t.key]; return n; })}>자동으로 되돌리기</button>
                          : <button type="button" className="sst-btn sm" onClick={() => setKinds((p) => ({ ...p, [t.key]: applied === 'array' ? 'host' : 'array' }))}>{applied === 'array' ? '호스트로 지정' : '어레이로 지정'}</button>)}</td>
                      </tr>
                    );
                  })}
                  {!targets.length && <tr><td colSpan={6}><div className="sst-empty"><b>후보가 없습니다</b><span>이 범위에 어레이 · 이름 규칙 분류 · 재정의가 없습니다.</span></div></td></tr>}
                </tbody>
              </STable>
            </div>
          </div>
          <div className="sst-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="sst-cardhead" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)' }}>
              <div className="sst-title"><h4>② 포트 → 디렉터 · 컨트롤러 매핑</h4><span className="muted" style={{ fontSize: 12 }}>· 자동이 '(구분 못 함)' 인 포트와 수동으로 바꾼 포트</span></div>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }} className="muted"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> 구분 못 함 · 수동만</label>
            </div>
            <div className="sst-table-wrap">
              <STable minWidth={820}>
                <thead><tr><th>어레이</th><th>스위치</th><th>포트</th><th>심볼릭 이름</th><th>자동 해석</th><th>수동 그룹</th><th>메모 · 변경</th></tr></thead>
                <tbody>
                  {ports.map((p) => {
                    const cur = dirs[p.mapKey];
                    return (
                      <tr key={p.mapKey}>
                        <td className="mono" data-sort={p.key}>{p.key}</td><td>{p.deviceName}</td><td className="mono">{p.port}</td>
                        <td className="mono" style={{ fontSize: 11.5, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.name}>{p.name || '(심볼릭 이름 없음)'}{p.nameChanged ? <span className="sst-tag warn" style={{ marginLeft: 6 }} title={`저장 당시 이름: ${p.override?.name || ''}`}>이름이 바뀜</span> : null}</td>
                        <td>{p.auto?.group ? <span className="sst-tag ok">{p.auto.group} · {CONF_LABEL[p.auto.confidence]}</span> : <span className="sst-tag gray">구분 못 함</span>}</td>
                        <td>{canEdit ? <input className={`sst-inp${cur?.group ? '' : ' dash'}`} value={cur?.group || ''} placeholder="비움 — 입력" maxLength={40} onChange={(e) => setDirs((d) => ({ ...d, [p.mapKey]: { ...(d[p.mapKey] || {}), group: e.target.value, name: p.name || '' } }))} aria-label="수동 그룹" /> : <span className="mono">{cur?.group || '—'}</span>}</td>
                        <td className="muted" style={{ fontSize: 11.5 }}>{canEdit ? <input className="sst-inp" style={{ minWidth: 120, fontFamily: 'inherit' }} value={cur?.note || ''} placeholder="메모" maxLength={200} onChange={(e) => setDirs((d) => ({ ...d, [p.mapKey]: { ...(d[p.mapKey] || {}), note: e.target.value, name: p.name || '' } }))} aria-label="메모" /> : (cur?.note || '')}{p.override?.at ? <div className="sst-sub">{p.override.by || '—'} · {dateClockText(p.override.at)}</div> : null}</td>
                      </tr>
                    );
                  })}
                  {!ports.length && <tr><td colSpan={7}><div className="sst-empty"><b>매핑할 포트가 없습니다</b><span>어레이 포트의 디렉터를 모두 이름 규칙으로 읽었습니다.</span></div></td></tr>}
                </tbody>
              </STable>
            </div>
            <div className="sst-foot" style={{ padding: '10px 16px', borderTop: '1px solid var(--border-soft)' }}>빈 칸은 저장 뒤에도 '(구분 못 함)' 으로 남습니다 — 추정해서 채우지 않습니다. 그룹 이름은 영숫자 · 공백 · _ . : - · 40자까지.{got.portsOmitted ? ` 후보 ${got.portsOmitted}개 더(상한).` : ''}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="sst-card"><h4>해석 순서(순수 함수 — 테스트가 고정)</h4><div className="sst-note">1. <b>수동 매핑</b>(이 화면) → 2. <b>이름 규칙</b>(벤더::시리얼::디렉터 포트 — PowerMax FA-1D · SAF-1d · OR-1C / PowerStore NodeA / Unity SPA) → 3. 조닝 별칭(Unity_SPA0_p8 꼴 — 이 판은 아직 넘기지 않음) → 4. <b>'(구분 못 함)'</b>.<br />분류도 같다: 수동 → 등록 스토리지 시리얼 일치 → 이름 규칙(<span className="mono">::</span>) → 호스트. 수동 값에는 '수동' 배지가 붙어 자동과 구분됩니다.</div></div>
          <div className="sst-card"><h4>저장 규약</h4><div className="sst-note">파일 <span className="mono">san-storage-map.json</span> — 관리자 전용 · 원자 쓰기 · 손상 보존 · 자격증명 아님 · 감사 로그. 키 = <span className="mono">어레이키|스위치|포트</span>. 포트가 재배선돼 심볼릭 이름이 바뀌면 '이름이 바뀜' 배지로 보이고 자동으로 지우지 않습니다.{got.map?.updatedAt ? <><br />마지막 저장 {dateClockText(got.map.updatedAt)} · {got.map.updatedBy || '—'}</> : null}</div></div>
          <div className="sst-card"><h4>최근 변경</h4>{recent.length ? <div className="sst-hist">{recent.map((x, i) => <React.Fragment key={i}><span>{dateClockText(x.at)}</span><span><b>{x.by || '—'}</b> {x.text}</span></React.Fragment>)}</div> : <div className="sst-note">아직 변경이 없습니다.</div>}</div>
          <div className="sst-info">'포트 이름 CSV 내보내기' 는 포탈이 이미 저장한 심볼릭 이름(port_meta)을 내려받습니다 — PowerStore · Unity 의 실제 이름 형식을 확인하는 가장 빠른 길이고 스위치에 새로 접속하지 않습니다. WWN · 시리얼이 들어 있어 공개 저장소에 올리지 않습니다.</div>
        </div>
      </div>
    </>
  );
}
