// IpamHome.jsx — IP 관리 '현황' 탭(v3.4.0 재설계 묶음 가 · 시안 docs/design/ipam-redesign ① Main.dc.html).
// 예전에는 모든 페이지 위에 KPI 카드 9장이 붙어 있었다 — 이제 그 값은 이 화면에서만, 숫자를 누르면 IP 주소 탭이 그 필터로 열린다.
// 계산은 ipamHomeText.js(순수), 판정은 대장 응답 · IpamCore 의 recon 집계를 그대로 읽는다(새 판정 없음).
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { fmtDt } from './ipamShared.jsx';
import { CHANGE_TYPE, changeDetail } from './ipamChangeText.js';
import { dbCountText, dbMetaText } from './ipamDbInfoText.js';
import { HEAT_LABELS, checkBadge, checkCards, heatBin, meterTone, pctText, topSubnets, utilSummary } from './ipamHomeText.js';

/** 막대 하나(사용률) — 80% 주황 · 90% 빨강. */
export function Meter({ pct }) {
  const tone = meterTone(pct);
  return (
    <span className={`ipam-meter ${tone}`} aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, Number(pct) || 0))}%` }} />
    </span>
  );
}

/** 최근 IP 변화 몇 건 — 관리자 API(403 이면 이 묶음을 그리지 않는다 · 15초 폴링 없이 열 때 한 번). */
function RecentChanges({ access, onGo }) {
  const [st, setSt] = useState({ rows: null, err: '' });
  useEffect(() => {
    if (access === 'no') return undefined;
    let alive = true;
    fetchJson('/admin/ipam/changes', { limit: 6 })
      .then((r) => { if (alive) setSt({ rows: r?.entries || [], err: '' }); })
      .catch((e) => { if (alive) setSt({ rows: null, err: e?.status === 403 ? 'denied' : (e?.message || '조회 실패') }); });
    return () => { alive = false; };
  }, [access]);
  if (access === 'no' || st.err === 'denied') return null;
  return (
    <section className="card ipam-home-card" aria-label="IP 변화">
      <div className="ipam-home-head"><h2>IP 변화</h2><span className="muted">스캔이 본 변화 · 최근 6건</span>
        <button type="button" className="ipam-link" onClick={() => onGo('changes')}>전부 보기</button></div>
      {st.err ? <div className="muted" style={{ fontSize: 12 }}>IP 변화를 읽지 못했습니다(없다는 뜻이 아닙니다): {st.err}</div>
        : st.rows == null ? <div className="muted" style={{ fontSize: 12 }}>읽는 중…</div>
          : st.rows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>아직 기록된 변화가 없습니다 — 스캔이 끝나면 쌓입니다.</div>
            : (
              <div className="ipam-ev-list">
                {st.rows.map((e, i) => {
                  const t = CHANGE_TYPE[e.type] || { label: e.type, tone: 'gray' };
                  return (
                    <div key={`${e.ts}-${e.ip}-${i}`} className="ipam-ev">
                      <span className="muted mono">{fmtDt(e.ts)}</span>
                      <span><span className={`badge ${t.tone}`} style={{ fontSize: 10 }}>{t.label}</span></span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><span className="mono">{e.ip || '—'}</span> {changeDetail(e)}</span>
                    </div>
                  );
                })}
              </div>
            )}
    </section>
  );
}

/**
 * @param {object} p
 * @param {object|null} p.data /tools/ipam 응답(없으면 읽는 중 · 실패)
 * @param {string} p.error
 * @param {object} p.recon IpamCore 집계
 * @param {Array|null} p.subnets 서브넷 목록(못 읽었으면 null)
 * @param {string} p.subnetsErr
 * @param {object|null} p.db 공유 DB 정보
 * @param {string} p.access 관리자 설정 접근 'yes' | 'no' | 'unknown'
 * @param {(k:string)=>void} p.onGo 페이지로
 * @param {(f:{recon?:string,row?:string})=>void} p.onFilter IP 주소 탭을 그 필터로
 * @param {(base:string)=>void} p.onPickSubnet 대역 탭을 그 대역으로
 * @param {(vcenterId:string)=>void} p.onPickVcenter 범위를 그 vCenter 로
 */
export function IpamHome({ data, error, recon, subnets, subnetsErr, db, access, onGo, onFilter, onPickSubnet, onPickVcenter }) {
  const u = utilSummary(subnetsErr ? null : subnets);
  const top = topSubnets(subnets, 10);
  const cards = checkCards(data, data ? recon : null);
  const vcs = (data?.byVcenter || []).filter((v) => !v.scanned);
  const scanOnly = (data?.byVcenter || []).find((v) => v.scanned);
  const totalVc = vcs.reduce((a, v) => a + (Number(v.count) || 0), 0);
  return (
    <div className="ipam-home">
      {!data && (
        <div className="card muted" style={{ padding: 12, fontSize: 13 }}>
          {error ? `IP 관리대장을 읽지 못했습니다 — 현황 숫자를 계산할 수 없습니다: ${error}` : 'IP 관리대장을 불러오는 중… — 위 탭의 스캔 · 설정 화면은 기다리지 않고 바로 쓸 수 있습니다.'}
        </div>
      )}

      <div className="ipam-home-row">
        <section className="card ipam-home-card" aria-label="주소 공간 사용률">
          <div className="ipam-home-head"><h2>주소 공간 사용률</h2></div>
          <div className="ipam-hero">
            <span className="ipam-hero-v">{u ? pctText(u.pct) : '—'}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {u ? <>대역 {u.nets.toLocaleString()}개 · 주소 {u.cap.toLocaleString()}개 가운데<br /><b style={{ color: 'var(--text)' }}>{u.used.toLocaleString()}</b>개가 대장에 있습니다</>
                : subnetsErr ? `대역 목록을 읽지 못했습니다: ${subnetsErr}` : '대역 목록을 읽는 중…'}
            </span>
          </div>
          {u && u.cap > 0 && (
            <>
              <div className="ipam-split" role="img" aria-label={`사용 중 ${u.used}개, 빈 주소 ${u.free}개`}>
                <span className="used" style={{ flexGrow: u.used }}>{u.pct >= 8 ? pctText(u.pct) : ''}</span>
                <span className="free" style={{ flexGrow: u.free }}>{100 - u.pct >= 8 ? pctText(100 - u.pct) : ''}</span>
              </div>
              <div className="ipam-split-lg">
                <span><i className="used" />사용 중 <b>{u.used.toLocaleString()}</b></span>
                <span><i className="free" />빈 주소 <b>{u.free.toLocaleString()}</b></span>
                <span>80% 이상 대역 <b>{u.over80.toLocaleString()}</b></span>
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>예약 · DHCP 구간은 아직 따로 세지 않습니다 — 대역 정책으로 잡아 둔 주소도 대장에 없으면 빈 주소로 셉니다.</div>
            </>
          )}
          {data && (
            <div className="muted" style={{ fontSize: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              <span>대장 주소 <b style={{ color: 'var(--text)' }}>{(data.total ?? 0).toLocaleString()}</b></span>
              <span>공인 / 사설 <b style={{ color: 'var(--text)' }}>{(data.publicIps ?? 0).toLocaleString()} / {(data.privateIps ?? 0).toLocaleString()}</b></span>
              <span>관리상태 지정 <b style={{ color: 'var(--text)' }}>{(recon?.managed ?? 0).toLocaleString()}</b></span>
              {db && <span title={dbMetaText(db)}>공유 DB <b style={{ color: 'var(--text)' }}>{dbCountText(db)}</b></span>}
            </div>
          )}
        </section>

        <section className="card ipam-home-card" aria-label="지금 확인할 것">
          <div className="ipam-home-head"><h2>지금 확인할 것</h2><span className="muted">숫자를 누르면 IP 주소 탭이 그 조건으로 열립니다</span></div>
          <div className="ipam-checks">
            {cards.map((c) => {
              const b = checkBadge(c);
              return (
                <button key={c.k} type="button" className="ipam-check" disabled={c.n == null} onClick={() => onFilter(c.go)}>
                  <span className="lb">{c.label}</span>
                  <span className="v">{c.n == null ? '—' : c.n.toLocaleString()}</span>
                  {b && <span><span className={`badge ${b.tone}`} style={{ fontSize: 10 }}>{b.label}</span></span>}
                  <span className="sub">{c.sub}</span>
                </button>
              );
            })}
          </div>
          {data && (
            <div className="ipam-chk-row">
              <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>점검 항목</span>
              <button type="button" className="ipam-chip" onClick={() => onFilter({ recon: 'noname' })}>호스트명 없음(스캔 IP) <b>{(recon?.noname ?? 0).toLocaleString()}</b></button>
              {(recon?.vnic ?? 0) > 0 && <button type="button" className="ipam-chip" onClick={() => onFilter({ recon: 'vnic' })}>미등록 가상 NIC <b>{recon.vnic.toLocaleString()}</b></button>}
              <button type="button" className="ipam-chip" onClick={() => onFilter({ recon: 'unmanaged' })}>관리상태 미지정 <b>{(recon?.unmanaged ?? 0).toLocaleString()}</b></button>
              <button type="button" className="ipam-chip" onClick={() => onFilter({ row: 'public' })}>공인 IP <b>{(data.publicIps ?? 0).toLocaleString()}</b></button>
              <button type="button" className="ipam-chip" onClick={() => onGo('insights')}>추천 기능 30선 전부</button>
            </div>
          )}
        </section>
      </div>

      <div className="ipam-home-row">
        <section className="card ipam-home-card" aria-label="사용률 높은 대역">
          <div className="ipam-home-head"><h2>사용률 높은 대역</h2><span className="muted">상위 {top.length}</span>
            <button type="button" className="ipam-link" onClick={() => onGo('sheet')}>대역 탭</button></div>
          {top.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>{subnetsErr ? '대역 목록을 읽지 못했습니다.' : '대역이 없습니다.'}</div> : (
            <div className="ipam-top">
              {top.map((t) => (
                <button key={t.base} type="button" className="ipam-top-row" title={`${t.subnet} · 대장 ${t.used}/254 · 빈 ${t.free}`} onClick={() => onPickSubnet(t.base)}>
                  <span className="mono" style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subnet}</span>
                  <Meter pct={t.pct} />
                  <span className="mono r" style={{ fontWeight: 600 }}>{pctText(t.pct)}</span>
                  <span className="mono r muted">빈 {t.free}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card ipam-home-card" aria-label="대역 사용률 지도">
          <div className="ipam-home-head"><h2>대역 사용률 지도</h2><span className="muted">칸 하나가 /24 대역 하나 · 밝을수록 많이 찼습니다</span></div>
          {Array.isArray(subnets) && subnets.length > 0 ? (
            <>
              <div className="ipam-heat">
                {subnets.map((s) => {
                  const pct = (Math.min(254, Number(s.used) || 0) / 254) * 100;
                  const tip = `${s.subnet} · ${pctText(pct)} · 대장 ${s.used}`;
                  return <button key={s.base} type="button" className={`ipam-heat-c h${heatBin(pct)}`} title={tip} aria-label={tip} onClick={() => onPickSubnet(s.base)} />;
                })}
              </div>
              <div className="ipam-heat-lg">
                <span className="muted">사용률</span>
                {HEAT_LABELS.map((l, i) => <span key={l}><i className={`h${i}`} />{l}</span>)}
              </div>
            </>
          ) : <div className="muted" style={{ fontSize: 12 }}>{subnetsErr ? '대역 목록을 읽지 못했습니다.' : '대역이 없습니다.'}</div>}
        </section>
      </div>

      <div className="ipam-home-row">
        <RecentChanges access={access} onGo={onGo} />
        <section className="card ipam-home-card" aria-label="vCenter별">
          <div className="ipam-home-head"><h2>vCenter별</h2><span className="muted">이름을 누르면 범위를 그 vCenter 로 · 대역 탭으로</span></div>
          {vcs.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>{data ? 'vCenter 가 없습니다.' : '—'}</div> : (
            <div className="table-wrap">
              <STable minWidth={360} wrap={false}>
                <thead><tr><th>vCenter</th><th style={{ textAlign: 'right' }}>대장 주소</th><th>비중</th></tr></thead>
                <tbody>
                  {vcs.map((v) => {
                    const pct = totalVc ? ((Number(v.count) || 0) / totalVc) * 100 : 0;
                    return (
                      <tr key={v.vcenterId}>
                        <td data-sort={v.vcenterName}><button type="button" className="cell-link" onClick={() => onPickVcenter(v.vcenterId)}>{v.vcenterName}</button></td>
                        <td className="mono" style={{ textAlign: 'right' }} data-sort={v.count}>{(Number(v.count) || 0).toLocaleString()}</td>
                        <td data-sort={pct}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="ipam-meter ok" style={{ flex: '1 1 80px' }}><i style={{ width: `${pct}%` }} /></span><span className="mono muted" style={{ width: 44, textAlign: 'right' }}>{pctText(pct)}</span></span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          )}
          {scanOnly && <div className="muted" style={{ fontSize: 12 }}>어떤 vCenter 에도 속하지 않고 스캔으로만 확인된 주소 {(Number(scanOnly.count) || 0).toLocaleString()}개는 위 표에 넣지 않았습니다.</div>}
        </section>
      </div>
    </div>
  );
}
