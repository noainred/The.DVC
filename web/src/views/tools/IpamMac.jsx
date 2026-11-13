// IpamMac.jsx — IP 대장 '제조사 · MAC' 칸과 IP 상세 창의 'MAC · 제조사' 묶음(v2.999, 시안 docs/design/ipam-alerts-mac-dns ④ ⑥).
// 문구는 ipamMacText.js(순수), 판정(표시 MAC · 제조사 · 종류 · 오래됨 · 같은 MAC 의 IP)은 서버가 행 · 상세에 실어 보낸다.
import React from 'react';
import { fmtDt } from './ipamShared.jsx';
import { MAC_SRC, macKindBadge, macVendorText, macStaleText } from './ipamMacText.js';

const MONO = { fontFamily: 'var(--mono)' };

/** 출처 배지(ARP · NetBIOS). */
export function MacSrcBadge({ src, style }) {
  const m = MAC_SRC[src];
  if (!m) return null;
  return <span className={`badge ${m.tone}`} title={m.title} style={{ fontSize: 10, ...style }}>{m.label}</span>;
}
function KindBadge({ kind, platform }) {
  const b = macKindBadge(kind, platform);
  return b ? <span className={`badge ${b.tone}`} title={b.title} style={{ fontSize: 10 }}>{b.label}</span> : null;
}

/** 목록 칸 — 위: 제조사(+ 종류 배지) · 아래: MAC(작은 고정폭). MAC 이 없으면 '—'. */
export function MacCell({ r }) {
  if (!r?.mac) return <span className="muted">—</span>;
  const vendor = macVendorText({ vendor: r.macVendor, kind: r.macKind, platform: r.macPlatform });
  const dim = !r.macVendor && r.macKind !== 'virtual';
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.35 }}>
      <span className="flex" style={{ alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
        <span className={dim ? 'muted' : undefined}>{vendor}</span>
        {r.macKind === 'virtual' && <KindBadge kind="virtual" platform={null} />}
      </span>
      <span style={{ ...MONO, fontSize: 11, color: r.macStale ? 'var(--text-faint)' : 'var(--text-dim)' }}
        title={`${MAC_SRC[r.macSrc]?.title || ''}${r.macStale ? ' · 마지막 스캔이 이 MAC 을 다시 보지 못했습니다(IP 를 누르면 확인 시각)' : ''}${r.macShared ? ` · 같은 MAC 의 IP ${r.macShared}개` : ''}`}>
        {r.mac}{r.macSrc === 'netbios' ? ' · NetBIOS' : ''}{r.macStale ? ' · 지난 확인' : ''}{r.macShared ? ` · IP ${r.macShared}개` : ''}
      </span>
    </span>
  );
}

/**
 * IP 상세 창의 'MAC · 제조사' 묶음 — scan = 서버 scanDetailOf(ip)(hw 가 MAC 묶음). scan 이 없거나 조회 중이면 그리지 않는다(호스트명 묶음이 말한다).
 * @param {{ scan:object|null|undefined }} props
 */
export function MacBlock({ scan }) {
  if (!scan || typeof scan !== 'object') return null;
  const hw = scan.hw && typeof scan.hw === 'object' ? scan.hw : null;
  const hist = Array.isArray(hw?.history) ? hw.history : [];
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>MAC · 제조사</div>
      {!hw || !hw.mac ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
          이 IP 의 MAC 을 알지 못합니다 — 스캐너와 다른 서브넷이면 이웃 표(ARP)로 알 수 없고, NetBIOS 도 답하지 않았습니다.
        </div>
      ) : (
        <>
          <div className="flex" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
            <b style={{ ...MONO, fontSize: 15, overflowWrap: 'anywhere' }}>{hw.mac}</b>
            <span>{macVendorText(hw)}</span>
            <MacSrcBadge src={hw.src} />
            <KindBadge kind={hw.kind} platform={hw.platform} />
          </div>
          {hw.src === 'arp' && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {hw.stale ? <span style={{ display: 'block' }}>{macStaleText(hw, scan.nameMissMax)}</span> : null}
              {hw.arpAt ? `${fmtDt(hw.arpAt)} 스캔에서 확인` : ''}
            </div>
          )}
          {hw.nbMac && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }} title={MAC_SRC.netbios.title}>
              NetBIOS 가 말한 MAC <span style={MONO}>{hw.nbMac}</span> — NIC 가 여럿이면 다른 NIC 의 MAC 입니다(충돌로 보지 않습니다)
            </div>
          )}
          {hw.sameMac?.total > 0 && (
            <div style={{ fontSize: 12.5, marginTop: 8, overflowWrap: 'anywhere' }}>
              <span className="muted">같은 MAC 의 다른 IP</span>{' '}
              <span style={MONO}>{hw.sameMac.ips.join(', ')}</span>
              {hw.sameMac.total > hw.sameMac.ips.length && <span className="muted"> 외 {(hw.sameMac.total - hw.sameMac.ips.length).toLocaleString()}개</span>}
              <span className="muted"> ({hw.sameMac.total.toLocaleString()}개 — IP 를 여럿 가진 장비이거나 대신 답하는 라우터일 수 있습니다)</span>
            </div>
          )}
        </>
      )}
      {hist.length > 0 && (
        // MAC 이력 — 표가 아니라 줄바꿈되는 행(400px 에서 3열 표가 잘린다 — v2.991 호스트명 묶음과 같은 판단).
        <div role="list" aria-label="MAC 이력" style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {hist.map((x, i) => (
            <div role="listitem" key={`${x.mac}-${x.first}`} className="flex" style={{ flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2, padding: '7px 12px', borderTop: i ? '1px solid rgba(36,48,73,.5)' : 'none', fontSize: 12.5 }}>
              {/* 기간은 줄바꿈되게(400px 에서 nowrap + 고정 폭이 '~ 2026. 11. 13. 오전 2:4' 로 잘렸다 — Chromium 판독) */}
              <span className="muted" style={{ flex: '1 1 240px', minWidth: 0 }}>{fmtDt(x.first)}{x.last && x.last !== x.first ? ` ~ ${fmtDt(x.last)}` : ''}</span>
              <span style={{ ...MONO, flex: '0 0 auto' }}>{x.mac}</span>
              <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{macVendorText(x)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
