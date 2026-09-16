/**
 * views/tools/UnityConfigPanels.jsx — Unity(SSH/uemcli) **장비 구성 정보** 패널(v2.525).
 *
 * 사용자 요청(2026-09-16): "용량 정보 확인 및 장비 구성정보 등 최대한 많은 정보를 수집해줘".
 * 수집은 `server/src/storage/collectors/unitySsh.js`, 여기서는 그 결과를 그린다.
 *
 * ── 지켜야 하는 정직성 규칙 ────────────────────────────────────────────────────
 * 1. **`unknown`(상태를 읽지 못함)을 정상으로도 이상으로도 세지 않는다** — 수집기가 그 기준이고
 *    (`healthOf`), 화면은 '상태 미확인 N' 을 **따로** 적는다(v2.523 스토리지 노드 규약과 같다).
 * 2. **상한으로 잘린 개수를 밝힌다**(`omitted`) — 조용히 줄이면 '전부를 받았다' 는 거짓이 된다.
 * 3. **값이 없는 것과 0 을 구분한다** — `null` 은 `—` 로, 0 은 0 으로 적는다.
 * 4. **못 읽은 명령을 숨기지 않는다**(`missingCmds`) — '이 장비에 없는 명령' 인지 사용자가 알아야
 *    구성 정보가 비어 있는 이유를 안다.
 * 5. **무엇으로 읽었는지 밝힌다**(`usedCmds`) — 명령 후보 체인이라 버전마다 쓰인 명령이 다르다.
 */
import React, { useState } from 'react';
import { STable } from '../../components/STable.jsx';

const n = (v) => (v == null ? '—' : String(v));

/** 상태 개수 요약 — 정상/이상/미확인을 뭉개지 않는다. */
function HealthCount({ g }) {
  if (!g) return null;
  return (
    <>
      <b>{g.count}</b>
      {g.unhealthy > 0 && <span style={{ color: 'var(--red)', marginLeft: 4 }}>⚠{g.unhealthy}</span>}
      {g.unknown > 0 && <span style={{ color: 'var(--text-faint)', marginLeft: 4 }} title="상태를 읽지 못한 항목 — 정상이라는 뜻이 아닙니다">?{g.unknown}</span>}
      {g.omitted > 0 && <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>목록 {g.omitted}개 생략</span>}
    </>
  );
}

const HW_LABEL = { dpe: 'DPE(본체)', dae: 'DAE(확장함)', psu: '전원공급장치', fan: '팬', bbu: '배터리(BBU)', ioModule: 'I/O 모듈' };
const PORT_LABEL = { eth: '이더넷 포트', fc: 'FC 포트', sas: 'SAS 포트' };

export default function UnityConfigPanels({ ex = {}, fmtBytes = (b) => String(b) }) {
  const [open, setOpen] = useState(false);
  const hw = ex.hardware || null;
  const ports = ex.ports || null;
  const prov = ex.provisioning || null;
  const disks = ex.disks || null;
  const lic = ex.licenses || null;
  const used = ex.usedCmds || null;
  const missing = ex.missingCmds || null;
  const has = hw || ports || prov || disks || lic || ex.software?.length;
  if (!has && !missing && !ex.deepSkipped) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div className="section-title" style={{ fontSize: 13 }}>
        장비 구성 정보
        <button className="tab" style={{ flex: 'none', padding: '2px 9px', fontSize: 11, marginLeft: 8 }} onClick={() => setOpen((v) => !v)}>
          {open ? '접기' : '펼치기'}
        </button>
      </div>

      {/* 요약 한 줄 — 펼치지 않아도 무엇이 수집됐는지 보인다 */}
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
        {disks && <span>드라이브 <b style={{ color: 'var(--text)' }}>{disks.count}</b>{disks.unhealthy ? <span style={{ color: 'var(--red)' }}> ⚠{disks.unhealthy}</span> : null}{disks.unknown ? <span> ?{disks.unknown}</span> : null}{disks.rawBytes ? ` · 원시 ${fmtBytes(disks.rawBytes)}` : ''} · </span>}
        {hw?.dae && <span>DAE {hw.dae.count} · </span>}
        {ports?.fc && <span>FC {ports.fc.count} · </span>}
        {ports?.eth && <span>ETH {ports.eth.count} · </span>}
        {prov?.luns && <span>LUN {prov.luns.count} · </span>}
        {prov?.filesystems && <span>파일시스템 {prov.filesystems.count} · </span>}
        {prov?.nasServers && <span>NAS 서버 {prov.nasServers.count} · </span>}
        {lic && <span>라이선스 {lic.count}</span>}
      </div>

      {ex.deepSkipped && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          ℹ 구성 상세 수집이 꺼져 있습니다(<code>UNITY_SSH_DEEP=0</code>) — 용량·상태만 수집합니다.
        </div>
      )}
      {ex.poolsUnreadable > 0 && (
        <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>
          ⚠ 용량 필드를 읽지 못한 풀 {ex.poolsUnreadable}개는 합계에서 제외했습니다 — 전체 용량이 실제보다 작을 수 있습니다.
        </div>
      )}

      {open && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
          {ex.software?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>설치된 소프트웨어</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>ID</th><th>버전</th><th>날짜</th></tr></thead>
                  <tbody>{ex.software.map((x, i) => <tr key={i}><td>{x.id || '—'}</td><td>{x.version || '—'}</td><td className="muted">{x.date || '—'}</td></tr>)}</tbody>
                </STable>
              </div>
            </div>
          )}

          {disks?.byType?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>드라이브 타입별</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>타입</th><th>개수</th><th>용량 합계</th></tr></thead>
                  <tbody>{disks.byType.map((t, i) => (
                    <tr key={i}><td>{t.type}</td><td data-sort={String(t.count)}>{t.count}</td><td data-sort={String(t.bytes)}>{t.bytes ? fmtBytes(t.bytes) : '—'}</td></tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {hw && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>하드웨어</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>구성품</th><th>개수 · 상태</th><th>목록</th></tr></thead>
                  <tbody>{Object.entries(hw).map(([k, g]) => (
                    <tr key={k}>
                      <td>{HW_LABEL[k] || k}</td>
                      <td data-sort={String(g.count)}><HealthCount g={g} /></td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>
                        {(g.list || []).map((x) => `${x.name}${x.model ? `(${x.model})` : ''}${x.health && x.health !== 'ok' ? ` — ${x.health}` : ''}`).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {ports && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>포트</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>종류</th><th>개수 · 상태</th><th>목록</th></tr></thead>
                  <tbody>{Object.entries(ports).map(([k, g]) => (
                    <tr key={k}>
                      <td>{PORT_LABEL[k] || k}</td>
                      <td data-sort={String(g.count)}><HealthCount g={g} /></td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>
                        {(g.list || []).map((x) => `${x.name}${x.speed ? ` ${x.speed}` : ''}${x.wwn ? ` ${x.wwn}` : ''}`).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {prov && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>프로비저닝</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>항목</th><th>개수</th><th>용량</th><th>비고</th></tr></thead>
                  <tbody>
                    {prov.luns && <tr><td>LUN</td><td data-sort={String(prov.luns.count)}>{prov.luns.count}</td><td>{prov.luns.totalBytes ? fmtBytes(prov.luns.totalBytes) : '—'}</td><td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{(prov.luns.top || []).slice(0, 5).map((x) => `${x.name} ${x.bytes ? fmtBytes(x.bytes) : '—'}`).join(', ')}</td></tr>}
                    {prov.filesystems && <tr><td>파일시스템</td><td data-sort={String(prov.filesystems.count)}>{prov.filesystems.count}</td><td>{prov.filesystems.totalBytes ? fmtBytes(prov.filesystems.totalBytes) : '—'}</td><td className="muted" style={{ fontSize: 11.5 }}>사용 {prov.filesystems.usedBytes ? fmtBytes(prov.filesystems.usedBytes) : '—'}</td></tr>}
                    {prov.vmwareDatastores && <tr><td>VMware 데이터스토어</td><td>{n(prov.vmwareDatastores.vmfs)} VMFS · {n(prov.vmwareDatastores.nfs)} NFS</td><td>—</td><td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{(prov.vmwareDatastores.list || []).slice(0, 6).map((x) => `${x.kind} ${x.name}`).join(', ')}</td></tr>}
                    {prov.nasServers && <tr><td>NAS 서버</td><td data-sort={String(prov.nasServers.count)}><HealthCount g={prov.nasServers} /></td><td>—</td><td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{(prov.nasServers.list || []).map((x) => x.name).join(', ')}</td></tr>}
                    {prov.hosts && <tr><td>등록 호스트</td><td data-sort={String(prov.hosts.count)}>{prov.hosts.count}</td><td>—</td><td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{(prov.hosts.list || []).slice(0, 8).map((x) => x.name).join(', ')}</td></tr>}
                    {prov.snapshots && <tr><td>스냅샷</td><td data-sort={String(prov.snapshots.count)}>{prov.snapshots.count}</td><td>—</td><td className="muted" style={{ fontSize: 11.5 }}>개수만 수집합니다</td></tr>}
                  </tbody>
                </STable>
              </div>
            </div>
          )}

          {lic?.list?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                라이선스 {lic.count}{lic.omitted > 0 ? ` (표에는 ${lic.list.length}건, ${lic.omitted}건 생략)` : ''}
              </div>
              <div className="table-wrap" style={{ maxHeight: '26vh' }}>
                <STable>
                  <thead><tr><th>기능</th><th>설치</th><th>만료</th></tr></thead>
                  <tbody>{lic.list.map((x, i) => (
                    <tr key={i}>
                      <td>{x.name}</td>
                      {/* 설치 여부를 읽지 못하면 '미설치' 가 아니라 '?' 다 */}
                      <td>{x.installed === true ? '예' : x.installed === false ? '아니오' : '?'}</td>
                      <td className="muted">{x.expires || '—'}</td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {ex.alertsList?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>활성 경보 {ex.alertsList.length}건(표시 상한 20)</div>
              <div className="table-wrap" style={{ maxHeight: '24vh' }}>
                <STable>
                  <thead><tr><th>심각도</th><th>시각</th><th>내용</th></tr></thead>
                  <tbody>{ex.alertsList.map((a, i) => (
                    <tr key={i}><td>{a.severity || '—'}</td><td className="muted">{a.at || '—'}</td><td style={{ whiteSpace: 'normal' }}>{a.message || '—'}</td></tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {/* 근거 — 어떤 후보 명령이 쓰였나(버전마다 다르다) */}
          {used && Object.keys(used).length > 0 && (
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>수집에 쓰인 명령 {Object.keys(used).length}개</summary>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
                {Object.entries(used).map(([k, c]) => `${k}: ${c}`).join('\n')}
              </pre>
            </details>
          )}

          {/* 못 읽은 명령 — 숨기면 구성 정보가 비어 있는 이유를 알 수 없다 */}
          {missing && Object.keys(missing).length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--amber)' }}>
                이 장비에서 실행되지 않은 명령 {Object.keys(missing).length}개 — 그 항목은 수집되지 않았습니다
              </summary>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 0', color: 'var(--text-dim)' }}>
                {Object.entries(missing).map(([k, m]) => `${k}: ${m}`).join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
