import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Seg, Tiles, CvpSelect, Pill } from './CvpNetParts.jsx';
import { CONFIG_DEFS, BUG_DEFS, LIFE_DEFS, bugText, lifeText, COMPLIANCE_NOTE, rowKey, TONE } from './cvpNetText.js';

/**
 * CVP › 버전 준수(v3.41 ③). `/tools/cvp/compliance` 마운트 1회 + 새로고침(폴링 없음). CVP 가 준 값을 그대로 — 판정은 서버 cvp/compliance.js(상태 분류만).
 */
const FILTERS = [['all', '전체'], ['life', '지원 종료 지남 · 곧'], ['bugs', '버그 · CVE 높음'], ['config', '설정 불일치'], ['unread', '못 읽음']];
const pick = (rows, f) => (f === 'life' ? rows.filter((r) => ['passed', 'soon'].includes(r.life.state))
  : f === 'bugs' ? rows.filter((r) => r.bugs.state === 'high')
    : f === 'config' ? rows.filter((r) => ['warn', 'bad'].includes(r.config.state))
      : f === 'unread' ? rows.filter((r) => r.bugs.state === 'unread' || r.life.state === 'unread' || r.config.state === 'unread') : rows);

export default function CvpComplianceView({ servers = [], onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState('devices');
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    fetchJson('/tools/cvp/compliance', cvpId ? { cvpId } : {}).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cvpId, reload]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  const c = r?.counts || {};
  const shown = pick(rows, filter);
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <b style={{ fontSize: 15 }}>버전 준수</b>
          <Seg label="보기" value={view} onChange={setView} items={[['devices', '장비별'], ['versions', '버전별']]} />
          <CvpSelect servers={servers} value={cvpId} onChange={setCvpId} />
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={COMPLIANCE_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (<>
        <Tiles tiles={[
          ['지원 종료 지남', c.life?.passed ?? 0, '소프트웨어 · 하드웨어 중 이른 날 기준', TONE.red],
          [`${r.soonDays}일 안 종료`, c.life?.soon ?? 0, '', TONE.amber],
          ['버그 · CVE 높음', c.bugs?.high ?? 0, `CVE 노출 장비 ${c.cveDevices ?? 0}대`, TONE.red],
          ['설정 불일치 · 오류', (c.config?.warn ?? 0) + (c.config?.bad ?? 0), 'CVP 준수 코드 기준', TONE.amber],
          ['못 읽음', Math.max(c.bugs?.unread ?? 0, c.life?.unread ?? 0), `버그 ${c.bugs?.unread ?? 0} · 수명주기 ${c.life?.unread ?? 0} · 준수 ${c.config?.unread ?? 0}`, 'var(--text-dim)'],
        ]} />
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {view === 'devices' ? (<>
            <div style={ROW}>{FILTERS.map(([k, l]) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l} <b style={MONO}>{pick(rows, k).length}</b></button>)}</div>
            <STable className="v3-table" minWidth={1000} limit={500}>
              <thead><tr><th>스위치 · 법인</th><th>모델</th><th>EOS</th><th>수명주기</th><th data-nosort>종료일</th><th>버그 · CVE</th><th data-nosort>노출</th><th>설정 준수</th></tr></thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={rowKey(x)}>
                    <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen({ cvpId: x.cvpId, key: x.key, hostname: x.hostname })}>{x.hostname}</button><div style={{ ...NOTE, fontSize: 11.5 }}>{x.corpName || '법인 미지정'}</div></td>
                    <td>{x.model || '—'}</td>
                    <td style={MONO}>{x.version || '—'}</td>
                    <td data-sort={['passed', 'soon', 'ok', 'none', 'unread'].indexOf(x.life.state)}><Pill color={LIFE_DEFS[x.life.state][1]}>{LIFE_DEFS[x.life.state][0]}</Pill></td>
                    <td style={{ whiteSpace: 'normal', minWidth: 160, fontSize: 12.5 }}>{lifeText(x.life)}</td>
                    <td data-sort={['high', 'low', 'none', 'unread'].indexOf(x.bugs.state)}><Pill color={BUG_DEFS[x.bugs.state][1]}>{BUG_DEFS[x.bugs.state][0]}</Pill></td>
                    <td style={{ fontSize: 12.5 }}>{bugText(x.bugs)}</td>
                    <td data-sort={['bad', 'warn', 'unknown', 'ok', 'unread'].indexOf(x.config.state)}><Pill color={CONFIG_DEFS[x.config.state][1]}>{CONFIG_DEFS[x.config.state][0]}</Pill>{x.config.code && x.config.code !== '0000' ? <span style={{ ...NOTE, marginLeft: 6 }}>코드 {x.config.code}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {!shown.length && <div style={NOTE}>조건에 맞는 장비가 없습니다.</div>}
            <div style={NOTE}>{shown.length > 500 ? `${shown.length}대 중 정렬 순서 앞 500대 표시 · ` : ''}준수 코드의 뜻은 CVP 가 정합니다 — 이 화면은 ‘0000’ 만 준수로 읽고 그 밖의 코드는 그대로 보입니다.</div>
          </>) : (<>
            <STable className="v3-table" minWidth={760}>
              <thead><tr><th>EOS 버전</th><th>장비</th><th>모델</th><th>버그 · CVE 높음</th><th>CVE 노출</th><th>지원 종료 지남</th><th>곧 종료</th><th>버그 못 읽음</th></tr></thead>
              <tbody>
                {(r.versions || []).map((v) => (
                  <tr key={v.version || '-'}>
                    <td style={MONO}>{v.version || '(버전 모름)'}</td>
                    <td style={{ ...MONO, textAlign: 'right' }}>{v.devices}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 180, fontSize: 12.5 }}>{v.models.join(', ') || '—'}</td>
                    <td style={{ ...MONO, textAlign: 'right', color: v.bugHigh ? TONE.red : undefined }}>{v.bugHigh}</td>
                    <td style={{ ...MONO, textAlign: 'right' }}>{v.cveDevices}</td>
                    <td style={{ ...MONO, textAlign: 'right', color: v.lifePassed ? TONE.red : undefined }}>{v.lifePassed}</td>
                    <td style={{ ...MONO, textAlign: 'right', color: v.lifeSoon ? TONE.amber : undefined }}>{v.lifeSoon}</td>
                    <td style={{ ...MONO, textAlign: 'right' }}>{v.bugUnread}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            <div style={NOTE}>같은 버전이라도 모델에 따라 노출이 다를 수 있습니다(CVP 가 장비마다 판정).</div>
          </>)}
        </div>
      </>)}
    </div>
  );
}
