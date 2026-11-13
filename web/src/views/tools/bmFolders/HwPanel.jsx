/**
 * 물리서버 폴더 옆 패널 — 하드웨어(iDRAC) 상세(v3.3.0). 패널이 열릴 때 1건만 받는다(GET /tools/bm-folders/hw — 목록에는 요약만).
 * 서버를 바꾸면 늦게 온 이전 응답은 버린다. 값이 없으면 '—' 와 이유(원인을 단정하지 않는다).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { opErrorText, ageText } from '../bmFoldersText.js';
import { memSizeText, diskSizeText, speedText, osText, hwLines, hwWhyText, OS_WHY } from './hwText.js';
import { IdracConnect } from './IdracConnect.jsx';

const WHY = {
  'summary-only': '엣지가 보낸 요약만 있습니다 — 엣지는 부품별 목록을 중앙으로 보내지 않습니다(부품별 목록은 그 엣지의 iDRAC 인벤토리 화면에서 봅니다).',
  'edge-none': '엣지가 하드웨어 요약을 보내지 않았습니다 — 엣지가 이 버전보다 낮거나, 그 엣지의 iDRAC 등록부 밖 서버(OME 등)이거나, 엣지가 인벤토리를 아직 읽지 못한 경우입니다.',
  'no-inv': 'iDRAC 인벤토리를 아직 읽지 못했습니다 — 등록 직후 · 수집 전 · OME 로만 보이는 서버 · 수집 서버가 아직 보내지 않은 경우 비어 있습니다.',
};

export default function HwPanel({ r, scoped }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const cur = useRef('');
  useEffect(() => {
    cur.current = r.key; setD(null); setErr('');
    if (r.kind !== 'bm') return;
    fetchJson('/tools/bm-folders/hw', { key: r.key }).then((x) => { if (cur.current === r.key) setD(x); }).catch((e) => { if (cur.current === r.key) setErr(opErrorText(e)); });
  }, [r.key, r.kind]);
  if (r.kind !== 'bm') return null;
  const det = d?.detail || null;
  const sum = det?.summary || d?.summary || null;
  const os = osText(det?.os || sum?.os);
  const lines = hwLines(sum);
  const addr = d?.addr || r.addr || '';
  return (
    <div className="bmf-hwsec">
      <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>하드웨어(iDRAC)</span>
      {/* 상세를 못 받아도 관리 주소(목록 행에 이미 있는 값)와 접속은 그대로 보인다(반증 F12 — 예전 '관리 주소' 칸 회귀 방지) */}
      {err ? (<>
        {r.addr ? <div className="bmf-kv"><span className="k">iDRAC 주소</span><span>{scoped ? <span className="mono" style={{ fontSize: 12 }}>{r.addr}</span> : <IdracConnect addr={r.addr} name={r.name} corp={r.corp} />}</span></div> : null}
        <span style={{ fontSize: 12, color: 'var(--red)' }}>{err}</span>
      </>) : !d ? <span className="muted" style={{ fontSize: 12 }}>읽는 중…</span> : (
        <>
          <div className="bmf-kv">
            <span className="k">iDRAC 주소</span>
            <span>{addr ? (scoped ? <span className="mono" style={{ fontSize: 12 }}>{addr}</span> : <IdracConnect addr={addr} name={r.name} corp={r.corp} />) : <span className="muted" title="관리 주소는 관리자 판본에서만 보입니다(또는 이 서버의 iDRAC 주소를 모릅니다)">—</span>}</span>
            <span className="k">OS</span>
            <span title={os.full || OS_WHY}>{os.full || <span className="muted">—</span>}{(det?.os?.host || sum?.host) ? <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>{det?.os?.host || sum?.host}</span> : null}</span>
            {sum ? (<>
              <span className="k">요약</span><span>{lines.l1}<br />{lines.l2}<br />{lines.l3}</span>
              <span className="k">iDRAC</span><span className="mono" style={{ fontSize: 12 }}>{[det?.idrac?.model, sum.fw || det?.idrac?.fw].filter(Boolean).join(' · ') || '—'}</span>
              <span className="k">인벤토리</span><span className="muted" style={{ fontSize: 12 }}>{sum.at ? `${ageText(sum.at)} 읽음` : '—'}{d.via === 'edge' ? ' · 엣지 요약' : d.via === 'remote' ? ' · 수집 서버' : ''}</span>
            </>) : null}
          </div>
          {!os.full && sum ? <span className="muted" style={{ fontSize: 11.5 }}>{OS_WHY}</span> : null}
          {!sum ? <span className="muted" style={{ fontSize: 12 }}>{WHY[d.why] || hwWhyText({ hwVia: d.via })}</span> : null}
          {d.why === 'summary-only' ? <span className="muted" style={{ fontSize: 11.5 }}>{WHY['summary-only']}</span> : null}
          {det ? <Detail det={det} /> : null}
        </>
      )}
    </div>
  );
}

const unk = <span className="muted">못 읽음</span>;
function Detail({ det }) {
  const sec = (title, list, render) => (
    <div>
      <span className="muted" style={{ fontSize: 11.5 }}>{title}</span>
      {list == null ? <div style={{ fontSize: 12 }}>{unk}</div> : !list.length ? <div className="muted" style={{ fontSize: 12 }}>없음</div> : <ul>{list.map((x, i) => <li key={i}>{render(x)}</li>)}</ul>}
    </div>
  );
  const nx = (x) => (x.n > 1 ? `${x.n} × ` : '');
  return (
    <div className="bmf-hwsec">
      {sec('CPU', det.cpus, (x) => `${nx(x)}${x.model || '모델 모름'}${x.cores ? ` · ${x.cores}코어` : ''}${x.threads ? `/${x.threads}스레드` : ''}${x.mhz ? ` · 최대 ${(x.mhz / 1000).toFixed(1)}GHz` : ''}`)}
      {sec('메모리(DIMM)', det.dimms, (x) => `${nx(x)}${x.gb ? memSizeText(x.gb) : '크기 모름'}${x.type ? ` ${x.type}` : ''}${x.mhz ? ` ${x.mhz}MHz` : ''}${x.maker ? ` · ${x.maker}` : ''}`)}
      {sec('디스크', det.disks, (x) => `${nx(x)}${x.model || '모델 모름'}${x.gb ? ` · ${diskSizeText(x.gb)}` : ''}${x.media ? ` · ${x.media}` : ''}${x.proto ? `(${x.proto})` : ''}`)}
      {sec('스토리지 컨트롤러', det.ctrls, (x) => `${nx(x)}${x.model}${x.fw ? ` · 펌웨어 ${x.fw}` : ''}`)}
      {sec('NIC', det.nics, (x) => `${x.model || '모델 모름'} · ${x.ports}포트(링크 업 ${x.up})${x.speeds?.length ? ` · ${x.speeds.map(speedText).join('/')}` : ''}`)}
      {sec('FC HBA', det.hbas, (x) => `${x.model || '모델 모름'}${x.ports ? ` · ${x.ports}포트` : ''}`)}
      {det.idrac?.ipv4 ? <span className="muted" style={{ fontSize: 11.5 }}>iDRAC 관리 NIC IPv4 <span className="mono">{det.idrac.ipv4}</span></span> : null}
    </div>
  );
}
