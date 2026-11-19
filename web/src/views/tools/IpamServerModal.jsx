// IpamServerModal.jsx — IP 관리 '서버 보기'(v3.6.0 재설계 묶음 다 — 시안 ⑤ · ⑤-2 Server.dc.html · ServerOs.dc.html).
// IP 를 누르면 그 IP 를 쓰는 서버를 서비스 태그 기준으로: 서버가 직접 쓰는 IP(iDRAC · ESXi vmk · OS) + 그 서버 위 VM 의 IP.
// 줄마다 '설정한 이름 ↔ 역DNS 이름 ↔ 이름 확인'. 판정은 서버(GET /tools/ipam/server — ipam/serverView.js), 화면은 글자만 바꾼다.
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Modal } from '../../components/Modal.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { KIND_LABEL, ROLE_LABEL, dnsFwdText, nameCheckOf } from './ipamServerText.js';

function NameCheck({ x }) {
  const c = nameCheckOf(x);
  const fwd = dnsFwdText(x);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span className={`badge ${c.tone}`} title={c.title}>{c.label}</span>
      {fwd && <span style={{ fontSize: 11, color: 'var(--amber)' }}>{fwd}</span>}
    </span>
  );
}
const dash = (v) => (v ? v : <span className="muted">—</span>);
const purposeCell = (x) => (x.purpose || x.subnetPurpose ? (
  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
    {x.purpose && <span>{x.purpose}</span>}
    {x.subnetPurpose && <span className="muted" style={{ fontSize: 11 }}>대역: {x.subnetPurpose}</span>}
  </span>) : <span className="muted">—</span>);

/** @param {{ ip?: string, serverKey?: string, onClose: () => void, onPickIp?: (ip:string) => void }} p */
export function IpamServerModal({ ip = '', serverKey = '', onClose }) {
  const [d, setD] = useState(undefined);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true; // 늦게 온 이전 응답은 버린다
    setD(undefined); setErr(null);
    fetchJson('/tools/ipam/server', serverKey ? { key: serverKey } : { ip })
      .then((r) => { if (alive) setD(r); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [ip, serverKey]);
  const s = d?.server;
  const vmRows = (d?.vms || []).flatMap((v) => (v.ips.length ? v.ips.map((x, i) => ({ ...x, vm: v.name, power: v.power, guestHost: v.guestHost, first: i === 0 })) : [{ ip: '', vm: v.name, power: v.power, guestHost: v.guestHost, first: true, none: true }]));
  return (
    <Modal title={s ? `서버 보기 — ${s.name || s.key}` : `서버 보기 — ${ip || serverKey}`} onClose={onClose} width={860} resizable minWidth={420} minHeight={360}>
      {err ? <ErrorBox message={err} /> : d === undefined ? <Loading /> : !d.found ? (
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.7, padding: 6 }}>
          {ip ? `${ip} 를 쓰는 서버를 찾지 못했습니다` : '서버를 찾지 못했습니다'} — vCenter 의 VM · ESXi 주소{d.admin ? ', iDRAC 등록 주소, 물리서버 OS 주소 등록' : ''}에 이 주소가 없습니다.
          {d.scoped ? ' 범위 계정은 자기 vCenter 의 호스트 · VM 만 찾습니다.' : ''}
          {!d.admin ? ' iDRAC · 물리 서버는 관리자에게만 보입니다.' : ''}
        </div>
      ) : (
        <div style={{ fontSize: 13, minWidth: 0 }}>
          <div className="card ipam-srv-head">
            <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{s.name || '(이름 없음)'}</b>
              <span className="badge blue">{KIND_LABEL[s.kind] || s.kind}</span>
              {s.tag ? <span className="badge gray" title="서비스 태그(일련번호)">태그 {s.tag}</span> : null}
              {s.tagShared ? <span className="badge amber" title="같은 서비스 태그를 보고한 호스트가 둘 이상입니다 — 태그로 묶지 않았습니다">태그 겹침</span> : null}
            </div>
            <div className="ipam-srv-kv">
              <span className="muted">모델</span><span>{[s.vendor, s.model].filter(Boolean).join(' ') || '—'}</span>
              {s.kind === 'esxi' && <><span className="muted">vCenter</span><span>{s.vcenterName || '—'}{s.cluster ? ` · ${s.cluster}` : ''}</span></>}
              {s.kind === 'esxi' && <><span className="muted">OS 이름</span><span>{s.osHostName ? `${s.osHostName}${s.osDomain ? `.${s.osDomain}` : ''}` : '못 읽음'}</span></>}
              {s.kind === 'bm' && <><span className="muted">OS</span><span>{s.osName || '못 읽음(iDRAC 서비스 모듈이 없으면 비어 있습니다)'}</span></>}
              {s.idrac?.ambiguous ? <><span className="muted">iDRAC</span><span style={{ color: 'var(--amber)' }}>같은 태그의 iDRAC {s.idrac.ambiguous}대 — 어느 것인지 정하지 않았습니다</span></> : null}
              {s.linkBy === 'name' && <><span className="muted">iDRAC 연결</span><span>서비스 태그가 없어 이름으로 연결했습니다</span></>}
              <span className="muted">VM</span><span>{s.kind === 'esxi' ? `${s.vmCount}대` : '해당 없음'}</span>
            </div>
          </div>
          {d.clicked && (
            <div className="muted" style={{ fontSize: 12, margin: '8px 2px' }}>
              누른 주소 <b className="mono">{d.clicked.ip}</b> 는 {d.clicked.role === 'vm' ? `이 서버 위 VM ‘${d.clicked.vm}’ 의 주소` : `이 서버의 ${ROLE_LABEL[d.clicked.role] || d.clicked.role} 주소`}입니다.
            </div>
          )}
          {(d.others || []).length > 0 && <div className="banner warn" style={{ margin: '6px 0' }}>같은 주소를 다른 서버 {d.others.length}대도 씁니다(주소 충돌 의심) — 대장의 ‘충돌’ 필터로 확인하세요.</div>}
          {(d.notes || []).map((n) => <div key={n} style={{ fontSize: 12, color: 'var(--amber)', margin: '4px 2px' }}>{n}</div>)}
          {!d.admin && <div className="muted" style={{ fontSize: 12, margin: '4px 2px' }}>iDRAC 주소 · 서비스 태그 · 물리 서버는 관리자에게만 보입니다.</div>}

          <h4 className="ipam-srv-h">이 서버가 직접 쓰는 IP <span className="muted">{(d.ips || []).length}개</span></h4>
          {(d.ips || []).length === 0 ? <div className="muted" style={{ fontSize: 12 }}>서버 주소를 읽지 못했습니다.</div> : (
            <STable className="v3-table" minWidth={640}>
              <thead><tr><th>역할</th><th>IP</th><th>인터페이스</th><th>용도</th><th>설정한 이름</th><th>역DNS 이름</th><th>이름 확인</th></tr></thead>
              <tbody>
                {d.ips.map((x) => (
                  <tr key={`${x.role}|${x.ip}`} className={d.clicked?.ip === x.ip ? 'ipam-srv-hit' : undefined}>
                    <td><span className="badge gray">{ROLE_LABEL[x.role] || x.role}</span></td>
                    <td className="mono">{x.ip}</td>
                    <td>{x.role === 'vmk' ? <>{x.dev || '관리'}{x.pg ? <span className="muted"> · {x.pg}</span> : null}{x.fromMgmt ? <span className="muted" title="수집 서버가 v3.6.0 이전이라 vmk 목록 대신 관리 IP 하나만 받았습니다"> · 관리 IP</span> : null}</> : x.role === 'idrac' ? '관리 포트' : '등록된 OS 주소'}</td>
                    <td data-sort={x.purpose || x.subnetPurpose || ''}>{purposeCell(x)}</td>
                    <td>{dash(x.setName)}</td>
                    <td>{dash(x.dns || (x.netbios ? `${x.netbios} (NetBIOS)` : ''))}</td>
                    <td data-sort={x.nameCheck}><NameCheck x={x} /></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          {s.kind === 'esxi' && (d.ips || []).some((x) => x.fromMgmt) && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>vMotion · vSAN 등 다른 vmk 주소는 수집 서버가 v3.6.0 이상이 되면 보입니다.</div>}
          {s.kind === 'bm' && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>OS 의 인터페이스별 주소(bond · 추가 주소)는 아직 모으지 않습니다 — iDRAC 주소와 ‘물리서버 OS 주소 제안’ 으로 등록한 주소만 보입니다.</div>}

          {s.kind === 'esxi' && (
            <>
              <h4 className="ipam-srv-h">이 서버 위 VM 의 IP <span className="muted">VM {(d.vms || []).length}대 · 주소 {vmRows.filter((x) => !x.none).length}개</span></h4>
              {vmRows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>이 호스트에 VM 이 없습니다.</div> : (
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <STable className="v3-table" minWidth={640} limit={600}>
                    <thead><tr><th>VM</th><th>IP</th><th>용도</th><th>OS 호스트명</th><th>역DNS 이름</th><th>이름 확인</th></tr></thead>
                    <tbody>
                      {vmRows.map((x) => (
                        <tr key={`${x.vm}|${x.ip}`} className={d.clicked?.ip && d.clicked.ip === x.ip ? 'ipam-srv-hit' : undefined}>
                          <td data-sort={x.vm} style={{ overflowWrap: 'anywhere' }}>{x.vm}{x.power && x.power !== 'POWERED_ON' ? <span className="muted"> (꺼짐)</span> : null}</td>
                          <td className="mono">{x.none ? <span className="muted">IP 없음</span> : x.ip}</td>
                          <td data-sort={x.purpose || x.subnetPurpose || ''}>{x.none ? '' : purposeCell(x)}</td>
                          <td>{dash(x.guestHost)}</td>
                          <td>{x.none ? '' : dash(x.dns || (x.netbios ? `${x.netbios} (NetBIOS)` : ''))}</td>
                          <td data-sort={x.nameCheck || ''}>{x.none ? '' : <NameCheck x={x} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
