import React, { useEffect, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { NOTE, MONO, ROW, GRID1, LINKBTN, Tiles, CvpSelect, Pill } from './CvpNetParts.jsx';
import { CHANNEL_DEFS, MLAG_DEFS, REDUNDANCY_NOTE, channelText, rowKey, TONE } from './cvpNetText.js';
import { agoText } from './cvpText.js';

/**
 * CVP › 이중화(v3.39 ⑧) — MLAG 상태 · 포트 채널 멤버. `/tools/cvp/redundancy` 마운트 1회 + 새로고침. 판정은 서버 cvp/redundancy.js.
 */
const BAD_CH = new Set(['degraded', 'down', 'unknown']);
const BAD_MLAG = new Set(['peerDown', 'notConnected', 'inactive', 'unknown']);

export default function CvpRedundancyView({ servers = [], onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [onlyBad, setOnlyBad] = useState(true);
  useEffect(() => {
    let active = true;
    setErr(null); setR(null);
    fetchJson('/tools/cvp/redundancy', cvpId ? { cvpId } : {}).then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [cvpId, reload]);
  const rows = r && Array.isArray(r.rows) ? r.rows : [];
  const bad = (x) => BAD_MLAG.has(x.mlag.state) || x.channels.some((ch) => BAD_CH.has(ch.state));
  const shown = onlyBad ? rows.filter(bad) : rows;
  const c = r?.counts || { ch: {}, mlag: {} };
  return (
    <div style={GRID1}>
      <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={ROW}>
          <b style={{ fontSize: 15 }}>이중화</b>
          <button type="button" className={`tab${onlyBad ? ' active' : ''}`} aria-pressed={onlyBad} onClick={() => setOnlyBad((x) => !x)}>문제 있는 장비만 <b style={MONO}>{rows.filter(bad).length}</b></button>
          <CvpSelect servers={servers} value={cvpId} onChange={setCvpId} />
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
        </div>
        <div style={NOTE}><BoldText text={REDUNDANCY_NOTE} /></div>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (<>
        <Tiles tiles={[
          ['채널 이중화 상실', (c.ch.degraded ?? 0) + (c.ch.down ?? 0), `일부만 ${c.ch.degraded ?? 0} · 전부 내려감 ${c.ch.down ?? 0}`, TONE.red],
          ['채널 정상', c.ch.ok ?? 0, `채널 ${c.channels ?? 0}개 중 · 확인 불가 ${c.ch.unknown ?? 0}`, TONE.green],
          ['MLAG 문제', (c.mlag.peerDown ?? 0) + (c.mlag.notConnected ?? 0) + (c.mlag.inactive ?? 0), `피어 링크 ${c.mlag.peerDown ?? 0} · 협상 ${c.mlag.notConnected ?? 0} · 비활성 ${c.mlag.inactive ?? 0}`, TONE.red],
          ['MLAG 정상', c.mlag.ok ?? 0, `안 씀 ${c.mlag.off ?? 0}`, TONE.green],
          ['못 읽음', (c.mlag.unread ?? 0) + (c.lagUnread ?? 0), `MLAG 상태 ${c.mlag.unread ?? 0}대 · 채널 소속 ${c.lagUnread ?? 0}대`, 'var(--text-dim)'],
        ]} />
        <div className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <STable className="v3-table" minWidth={940} limit={400}>
            <thead><tr><th>스위치 · 법인</th><th>MLAG</th><th data-nosort>MLAG 세부</th><th>문제 채널</th><th data-nosort>포트 채널(올라온 멤버 / 켜진 멤버)</th></tr></thead>
            <tbody>
              {shown.map((x) => {
                const badCh = x.channels.filter((ch) => BAD_CH.has(ch.state));
                return (
                  <tr key={rowKey(x)}>
                    <td data-sort={x.hostname}><button type="button" style={LINKBTN} onClick={() => onOpen && onOpen({ cvpId: x.cvpId, key: x.key, hostname: x.hostname })}>{x.hostname}</button><div style={{ ...NOTE, fontSize: 11.5 }}>{x.corpName || '법인 미지정'}</div></td>
                    <td data-sort={Object.keys(MLAG_DEFS).indexOf(x.mlag.state)}><Pill color={MLAG_DEFS[x.mlag.state][1]}>{MLAG_DEFS[x.mlag.state][0]}</Pill>{x.mlag.state === 'unread' && x.mlag.enabled === true ? <div style={{ ...NOTE, fontSize: 11.5 }}>인벤토리상 MLAG 켜짐</div> : null}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 180, fontSize: 12.5 }}>
                      {x.mlag.raw ? `상태 ${x.mlag.raw.state || '—'} · 협상 ${x.mlag.raw.negotiation || '—'} · 피어 링크 ${x.mlag.peerLink || ''} ${x.mlag.raw.peerLinkState || '—'}` : '—'}
                      {x.mlag.at ? <div style={{ ...NOTE, fontSize: 11.5 }}>읽은 시각 {agoText(x.mlag.at)}{x.mlag.domain ? ` · 도메인 ${x.mlag.domain}` : ''}</div> : null}
                    </td>
                    <td data-sort={badCh.length} style={{ ...MONO, textAlign: 'right' }}>{x.lagUnread ? '—' : badCh.length}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 300 }}>
                      {x.lagPartial ? <div style={{ ...NOTE, color: TONE.amber }}>채널 소속을 일부만 읽었습니다 — 빠진 멤버가 있을 수 있습니다</div> : null}
                      {x.lagUnread ? <span style={NOTE}>채널 소속 못 읽음</span> : !x.channels.length ? <span style={NOTE}>포트 채널 없음</span> : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {x.channels.map((ch) => (
                            <span key={ch.po} title={ch.members.map((m) => `${m.port} ${m.admin === 'down' ? '꺼짐' : m.oper}`).join('\n')}
                              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', padding: '2px 8px', borderRadius: 6, border: `1px solid ${CHANNEL_DEFS[ch.state][1]}`, fontSize: 12 }}>
                              <span style={MONO}>{ch.po.replace(/^Port-Channel/i, 'Po')}</span><b style={{ ...MONO, color: CHANNEL_DEFS[ch.state][1] }}>{channelText(ch)}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          {!shown.length && <div style={NOTE}>{onlyBad ? '문제 있는 장비가 없습니다.' : '장비가 없습니다.'}</div>}
          <div style={NOTE}>채널 칸에 마우스를 올리면 멤버 포트와 상태가 보입니다. {shown.length > 400 ? `${shown.length}대 중 정렬 순서 앞 400대 표시. ` : ''}{r.truncated ? '⚠ 포트 행이 상한을 넘어 일부만 봤습니다.' : ''}</div>
        </div>
      </>)}
    </div>
  );
}
