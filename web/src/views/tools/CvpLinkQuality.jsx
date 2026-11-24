import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Seg, Tiles, CvpSelect, Pill } from './CvpNetParts.jsx';
import { VERDICT_DEFS, VERDICT_ORDER, linkqBasis, LINKQ_NOTE, speedText, numText, dateText, rowKey } from './cvpNetText.js';

/**
 * CVP › 링크 품질(v3.38 ④ 불량 링크 · ⑩ 플랩). `/tools/cvp/linkq` 마운트 1회 + 새로고침(폴링 없음).
 * 판정은 서버 cvp/linkq.js — 이 화면은 순위 · 근거를 그린다.
 */
export default function CvpLinkQualityView({ servers = [], onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [days, setDays] = useState('7');
  const [only, setOnly] = useState('all');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    fetchJson('/tools/cvp/linkq', { days, ...(cvpId ? { cvpId } : {}) }).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cvpId, days, reload]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  const shown = only === 'all' ? rows : rows.filter((x) => x.verdict === only);
  const c = r?.counts || {};
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <b style={{ fontSize: 15 }}>링크 품질</b>
          <Seg label="기간" value={days} onChange={setDays} items={[['1', '오늘'], ['7', '7일'], ['30', '30일']]} />
          <CvpSelect servers={servers} value={cvpId} onChange={setCvpId} />
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={LINKQ_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (<>
        <Tiles tiles={[
          ...VERDICT_ORDER.map((k) => [VERDICT_DEFS[k].label, c[k] ?? 0, VERDICT_DEFS[k].hint, VERDICT_DEFS[k].color]),
          ['판정 못 함', c.noData ?? 0, `링크 올라온 포트 ${numText(c.up)}개 중 기간 안에 오류 카운터를 못 읽은 포트`, 'var(--text-dim)'],
        ]} />
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={ROW}>
            <button type="button" className={`tab${only === 'all' ? ' active' : ''}`} onClick={() => setOnly('all')}>전체 <b style={MONO}>{rows.length}</b></button>
            {VERDICT_ORDER.map((k) => <button key={k} type="button" className={`tab${only === k ? ' active' : ''}`} onClick={() => setOnly(k)}>{VERDICT_DEFS[k].label} <b style={MONO}>{rows.filter((x) => x.verdict === k).length}</b></button>)}
          </div>
          <STable className="v3-table" minWidth={1100} limit={300}>
            <thead><tr><th>판정</th><th>법인</th><th>스위치</th><th>포트</th><th>속도</th><th>오류</th><th>드롭</th><th>링크 내려감</th><th>수신 광량</th><th data-nosort>근거</th><th>설명</th></tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={rowKey(x)}>
                  <td data-sort={VERDICT_ORDER.indexOf(x.verdict)}><Pill color={VERDICT_DEFS[x.verdict]?.color || 'var(--text-dim)'} title={VERDICT_DEFS[x.verdict]?.hint}>{VERDICT_DEFS[x.verdict]?.label || x.verdict}</Pill></td>
                  <td>{x.corpName || '법인 미지정'}</td>
                  <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen({ cvpId: x.cvpId, key: x.key, hostname: x.hostname })}>{x.hostname}</button></td>
                  <td style={MONO}>{x.port}</td>
                  <td data-sort={x.speedBps ?? ''}>{speedText(x.speedBps)}</td>
                  <td data-sort={x.errs ?? ''} style={{ ...MONO, textAlign: 'right' }}>{x.errs == null ? '—' : numText(x.errs)}</td>
                  <td data-sort={x.drops ?? ''} style={{ ...MONO, textAlign: 'right' }}>{x.drops == null ? '—' : numText(x.drops)}</td>
                  <td data-sort={x.downs} style={{ ...MONO, textAlign: 'right' }}>{x.downs}</td>
                  <td data-sort={x.rx ?? ''} style={{ ...MONO, textAlign: 'right' }}>{x.rx == null ? '—' : `${x.rx.toFixed(1)}`}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220, fontSize: 12.5 }}>{linkqBasis(x, r.warnDbm)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 160, overflowWrap: 'anywhere', fontSize: 12.5 }}>{x.desc == null ? '(못 읽음)' : x.desc || '(설명 없음)'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          {!shown.length && <div style={NOTE}>{rows.length ? '이 판정에 해당하는 포트가 없습니다.' : '기간 안에 오류가 늘거나 링크가 내려간 포트가 없습니다.'}</div>}
          <div style={NOTE}>
            {shown.length > 300 ? `${shown.length}개 중 정렬 순서 앞 300개 표시 · ` : ''}기간 {dateText(r.from)} ~ 오늘 · 수신 광량 주의 임계 {r.warnDbm} dBm(CVP 설정) · 플랩은 {r.flapMin}회 이상
            {r.flapRecordSince ? ` · 링크 내려감 기록은 ${dateText(r.flapRecordSince)}부터` : ' · 링크 내려감 기록이 아직 없습니다(이번 버전부터 쌓습니다)'}
            {r.omitted ? ` · ⚠ 상위 ${rows.length}개만 표시(${r.omitted}개 생략)` : ''}{r.truncated ? ' · ⚠ 포트 행이 상한을 넘어 일부만 봤습니다' : ''}
          </div>
        </div>
      </>)}
    </div>
  );
}
