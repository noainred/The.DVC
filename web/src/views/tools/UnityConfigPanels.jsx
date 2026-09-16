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
 * 6. (v2.526) **구성 정보는 긴 주기로만 수집한다**(기본 6시간) — 매 주기 20여 개 명령을 SSH 로
 *    돌리면 장비와 회선을 붙잡는다. 그래서 화면은 **언제 수집한 구성인지**(`configAt`)를 반드시
 *    적는다. 낡은 값을 지금 값인 척하지 않는 것이 이 표시의 목적이다.
 * 7. (v2.526) **빈 슬롯(`empty`)을 고장으로 세지 않는다** — `svc_diag -s spinfo` 의 FRU 트리는
 *    비어 있는 DIMM/디스크 슬롯을 `REMOVED` 로 보고한다(실측: SPA 의 정상 DIMM 12개 × 8GB =
 *    96GB 가 로그인 배너와 일치했다). 빈 슬롯을 고장으로 세면 정상 장비가 전부 '이상' 이 된다.
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
  // v2.526: `svc_diag -s spinfo` 계열 — Unisphere 계정 없이 SSH 만으로 읽히는 FRU 상태·부품·전원.
  const spHw = ex.hw || null;
  const power = ex.power || null;
  const quota = ex.quota || null;
  const has = hw || ports || prov || disks || lic || spHw || power || quota || ex.software?.length;
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
        {lic && <span>라이선스 {lic.count} · </span>}
        {spHw?.fru && <span>FRU <b style={{ color: 'var(--text)' }}>{spHw.fru.ok}</b>/{spHw.fru.total} 정상{spHw.fru.fault ? <span style={{ color: 'var(--red)' }}> ⚠{spHw.fru.fault}</span> : null}{spHw.fru.unknown ? <span> ?{spHw.fru.unknown}</span> : null} · </span>}
        {power?.totalWatts != null && <span>입력 전력 <b style={{ color: 'var(--text)' }}>{power.totalWatts}W</b>{spHw?.dpeTempC != null ? ` · DPE ${spHw.dpeTempC}℃` : ''}</span>}
      </div>

      {/* v2.526: 구성은 긴 주기(기본 6시간)로만 수집한다 — **언제 수집한 값인지** 밝히지 않으면
          낡은 구성을 지금 값으로 오해한다. 주기 숫자는 서버가 준 값(`configEveryMs`)만 쓴다. */}
      {ex.configAt && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          구성 수집 시각 <b style={{ color: 'var(--text)' }}>{new Date(ex.configAt).toLocaleString('ko-KR')}</b>
          {ex.configEveryMs ? ` · 약 ${Math.round(ex.configEveryMs / 60000)}분마다 갱신` : ''}
          {ex.configRound ? ' · 이번 주기에 갱신됨' : ' · 직전 수집분을 재사용(용량·상태는 매 주기 갱신)'}
        </div>
      )}
      {ex.hwNote && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>⚠ {ex.hwNote}</div>}
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

          {disks?.byTier?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                드라이브 티어별
                {/* 풀 밖 드라이브(스페어·미할당)는 전체 용량에 잡히지 않는다 — 그 사실을 적는다. */}
                {disks.unpooled > 0 && <span> · 풀에 속하지 않은 드라이브 <b style={{ color: 'var(--text)' }}>{disks.unpooled}</b>개(전체 용량에 포함되지 않습니다)</span>}
              </div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>티어</th><th>개수</th><th>원시 용량</th></tr></thead>
                  <tbody>{disks.byTier.map((t, i) => (
                    <tr key={i}><td>{t.tier}</td><td data-sort={String(t.count)}>{t.count}</td><td data-sort={String(t.bytes)}>{t.bytes ? fmtBytes(t.bytes) : '—'}</td></tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {disks?.byPool?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>드라이브 풀별</div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>풀</th><th>개수</th><th>원시 용량</th></tr></thead>
                  <tbody>{disks.byPool.map((t, i) => (
                    <tr key={i}><td>{t.pool}</td><td data-sort={String(t.count)}>{t.count}</td><td data-sort={String(t.bytes)}>{t.bytes ? fmtBytes(t.bytes) : '—'}</td></tr>
                  ))}</tbody>
                </STable>
              </div>
            </div>
          )}

          {disks?.list?.length > 0 && (
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                드라이브 슬롯별 {disks.list.length}개{disks.omitted > 0 ? ` (${disks.omitted}개 생략)` : ''}
              </summary>
              <div className="table-wrap" style={{ maxHeight: '30vh', marginTop: 4 }}>
                <STable>
                  <thead><tr><th>위치</th><th>티어</th><th>용량</th><th>풀</th><th>상태</th></tr></thead>
                  <tbody>{disks.list.map((d, i) => (
                    <tr key={i}>
                      <td>{d.enclosure ? `${d.enclosure} / ` : ''}{d.slot || d.id || '—'}</td>
                      <td className="muted">{d.tier || '—'}</td>
                      <td data-sort={String(d.bytes ?? -1)}>{d.bytes ? fmtBytes(d.bytes) : '—'}</td>
                      <td className="muted">{d.pool || '—'}</td>
                      {/* `healthOf`(unitySsh.js:164)는 'ok' · 'unknown' · **장비 원문(소문자)** 중 하나를 준다 —
                          'unhealthy' 라는 값은 없다. 원문을 그대로 보여 판정 근거를 숨기지 않는다. */}
                      <td style={d.health !== 'ok' && d.health !== 'unknown' ? { color: 'var(--red)' } : undefined}>
                        {d.health === 'ok' ? '정상' : d.health === 'unknown' ? '확인 불가' : (d.healthRaw || d.health)}
                      </td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </details>
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

          {/* ── FRU 상태 (svc_diag -s spinfo) ──────────────────────────────────────────
              ⚠ **빈 슬롯(REMOVED)을 고장으로 세지 않는다**(헤더 규칙 7). 실측에서 SPA 의 정상
                 DIMM 12개(×8GB=96GB)가 로그인 배너와 일치했고, 나머지 슬롯은 REMOVED 였다.
                 빈 슬롯을 고장으로 세면 정상 장비가 통째로 '이상' 이 된다. */}
          {spHw?.fru && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                FRU 상태{spHw.systemType ? ` — ${spHw.systemType}` : ''}{spHw.spId ? ` (${spHw.spId})` : ''}
                {spHw.truncated ? <span style={{ color: 'var(--amber)' }}> · 출력이 상한으로 잘렸습니다</span> : null}
              </div>
              <div className="flex gap wrap" style={{ marginBottom: 4 }}>
                <span className="badge green">정상 {spHw.fru.ok}</span>
                <span className={`badge ${spHw.fru.fault ? 'red' : 'gray'}`}>고장 {spHw.fru.fault}</span>
                {/* '빈 슬롯' 과 '확인 불가' 는 고장이 아니다 — 각각 따로 센다 */}
                <span className="badge gray" title="부품이 꽂혀 있지 않은 슬롯 — 고장이 아닙니다">빈 슬롯 {spHw.fru.empty}</span>
                <span className="badge gray" title="상태를 읽지 못한 항목 — 정상이라는 뜻이 아닙니다">확인 불가 {spHw.fru.unknown}</span>
                <span className="badge gray">전체 {spHw.fru.total}</span>
                {spHw.memory?.totalGB != null && <span className="badge gray">메모리 {spHw.memory.totalGB}GB({spHw.memory.modules}개)</span>}
              </div>
              {spHw.fru.faults?.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: '22vh' }}>
                  <STable>
                    <thead><tr><th>부품</th><th>SP</th><th>종류</th><th>장비 원문</th></tr></thead>
                    <tbody>{spHw.fru.faults.map((f, i) => (
                      <tr key={i}><td style={{ color: 'var(--red)' }}>{f.name}</td><td className="muted">{f.sp || '—'}</td><td className="muted">{f.kind || '—'}</td><td className="muted">{f.raw || '—'}</td></tr>
                    ))}</tbody>
                  </STable>
                </div>
              )}
              {spHw.fru.items?.length > 0 && (
                <details>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>FRU 전체 {spHw.fru.items.length}개</summary>
                  <div className="table-wrap" style={{ maxHeight: '30vh', marginTop: 4 }}>
                    <STable>
                      <thead><tr><th>부품</th><th>SP</th><th>상태</th><th>장비 원문</th><th>비고</th></tr></thead>
                      <tbody>{spHw.fru.items.map((x, i) => (
                        <tr key={i}>
                          <td>{x.name}</td>
                          <td className="muted">{x.sp || '—'}</td>
                          <td style={x.state === 'fault' ? { color: 'var(--red)' } : undefined}>
                            {x.state === 'ok' ? '정상' : x.state === 'empty' ? '빈 슬롯' : x.state === 'fault' ? '고장' : '확인 불가'}
                          </td>
                          <td className="muted">{x.raw || '—'}</td>
                          <td className="muted" style={{ whiteSpace: 'normal', fontSize: 11.5 }}>{x.detail || '—'}</td>
                        </tr>
                      ))}</tbody>
                    </STable>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* ── 전원 ──
              `Input Power`(전원 요약)와 FRU 트리의 `ps0: OK 330` 을 **둘 다** 싣는다 —
              같은 값인지 사용자가 대조할 수 있어야 한다(근거를 숨기지 않는다). */}
          {power?.supplies?.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                전원공급장치 {power.supplies.length}개
                {power.totalWatts != null
                  ? ` · 입력 합계 ${power.totalWatts}W(${power.readWatts}개에서 읽음)`
                  : ' · 입력 전력을 읽지 못했습니다'}
              </div>
              <div className="table-wrap">
                <STable>
                  <thead><tr><th>장치</th><th>상태</th><th>입력 전력</th><th>입력 전압</th><th>온도</th><th>모델·펌웨어</th></tr></thead>
                  <tbody>{power.supplies.map((x, i) => (
                    <tr key={i}>
                      <td>{x.title}</td>
                      <td style={x.state === 'fault' ? { color: 'var(--red)' } : undefined}>
                        {x.state === 'ok' ? '정상' : x.state === 'fault' ? `고장(${x.faults.join(', ')})` : '확인 불가'}
                      </td>
                      <td data-sort={String(x.inputWatts ?? -1)}>{x.inputWatts != null ? `${x.inputWatts} W` : '—'}</td>
                      <td data-sort={String(x.inputVolts ?? -1)}>{x.inputVolts != null ? `${x.inputVolts} V` : '—'}</td>
                      <td data-sort={String(x.tempC ?? -1)}>{x.tempC != null ? `${x.tempC} ℃` : '—'}</td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{[x.model, x.firmware, x.type].filter(Boolean).join(' · ') || '—'}</td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
              {power.fromFru?.length > 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                  FRU 트리 보고값: {power.fromFru.map((f) => `${f.sp ? `${f.sp} ` : ''}${f.name} ${f.watts}W`).join(' · ')}
                </div>
              )}
            </div>
          )}

          {/* ── 부품 인벤토리(FRU resume) ── */}
          {spHw?.inventory?.length > 0 && (
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                부품 인벤토리 {spHw.inventory.length}개
                {spHw.inventoryOmitted > 0 ? ` (${spHw.inventoryOmitted}개 생략)` : ''}
                {/* 읽기 실패한 부품은 '없는 것' 이 아니라 '못 읽은 것' 이다 */}
                {spHw.inventoryReadErrors > 0 ? ` · 읽기 실패 ${spHw.inventoryReadErrors}건(부품이 없다는 뜻이 아닙니다)` : ''}
              </summary>
              <div className="table-wrap" style={{ maxHeight: '30vh', marginTop: 4 }}>
                <STable>
                  <thead><tr><th>부품</th><th>부품 번호</th><th>일련번호</th><th>비고</th></tr></thead>
                  <tbody>{spHw.inventory.map((d, i) => (
                    <tr key={i}>
                      <td>{d.device}</td>
                      <td className="muted">{d.fields?.['EMC TLA Part Number'] || d.fields?.['EMC Product Part Number'] || d.fields?.['Module Part Number'] || '—'}</td>
                      <td className="muted">{d.fields?.['EMC TLA Serial Number'] || d.fields?.['EMC Product Serial Number'] || d.fields?.['Module Serial Number'] || '—'}</td>
                      <td className="muted" style={{ whiteSpace: 'normal', fontSize: 11.5 }}>
                        {d.error ? <span style={{ color: 'var(--amber)' }}>{d.error}</span>
                          : [d.fields?.Density, d.fields?.['Device Type'], d.fields?.['TLA Assembly Name']].filter(Boolean).join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </details>
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
                    {prov.luns && <tr><td>LUN</td><td data-sort={String(prov.luns.count)}>{prov.luns.count}</td><td>{prov.luns.totalBytes ? fmtBytes(prov.luns.totalBytes) : '—'}</td><td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{/* 할당량은 일부 LUN 에서만 읽힐 수 있다 — 몇 개에서 읽은 합인지 밝힌다(일부 합을 전체인 척하지 않는다) */}{prov.luns.allocatedBytes != null ? `실제 할당 ${fmtBytes(prov.luns.allocatedBytes)} (${prov.luns.allocatedRead}/${prov.luns.count}개에서 읽음)` : '실제 할당량을 읽지 못했습니다'}</td></tr>}
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

          {prov?.luns?.top?.length > 0 && (
            <details>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                LUN 상세 — 큰 것부터 {prov.luns.top.length}개{prov.luns.count > prov.luns.top.length ? ` (전체 ${prov.luns.count}개 중)` : ''}
              </summary>
              <div className="table-wrap" style={{ maxHeight: '30vh', marginTop: 4 }}>
                <STable>
                  <thead><tr><th>이름</th><th>크기</th><th>실제 할당</th><th>풀</th><th>SP</th><th>비고</th></tr></thead>
                  <tbody>{prov.luns.top.map((x, i) => (
                    <tr key={i}>
                      <td>{x.name}</td>
                      <td data-sort={String(x.bytes ?? -1)}>{x.bytes ? fmtBytes(x.bytes) : '—'}</td>
                      {/* 할당량을 못 읽으면 0 이 아니라 '—' 다(0 은 '아무것도 안 썼다' 는 거짓) */}
                      <td data-sort={String(x.allocatedBytes ?? -1)}>{x.allocatedBytes != null ? fmtBytes(x.allocatedBytes) : '—'}</td>
                      <td className="muted">{x.pool || '—'}</td>
                      <td className="muted">{x.spOwner || '—'}{x.trespassed ? ' ⚠전환됨' : ''}</td>
                      <td className="muted" style={{ fontSize: 11.5 }}>
                        {x.thin ? 'Thin' : ''}{x.health && x.health !== 'ok' ? `${x.thin ? ' · ' : ''}${x.health === 'unknown' ? '상태 확인 불가' : x.health}` : ''}
                      </td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            </details>
          )}

          {/* ── NAS 할당량 ──
              ⚠ 이 장비에서 `uemcli /quota/tree show` 는 **문법 오류**였다(대상 파일시스템 지정 필요).
                 그래서 명령이 실패한 경우는 여기 아무것도 그리지 않고, 사유는 아래 '실행되지 않은
                 명령' 이 갖는다 — **'쿼터 없음' 이라고 말하지 않는다**(확인하지 못한 것이다). */}
          {quota && Object.entries(quota).map(([k, q]) => (
            q.count > 0 ? (
              <div key={k}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>
                  {q.label} {q.count}{q.omitted > 0 ? ` (표에는 ${q.list.length}건, ${q.omitted}건 생략)` : ''}
                </div>
                <div className="table-wrap" style={{ maxHeight: '26vh' }}>
                  <STable>
                    <thead><tr><th>파일시스템</th><th>경로</th><th>사용</th><th>소프트 한도</th><th>하드 한도</th><th>상태</th></tr></thead>
                    <tbody>{q.list.map((x, i) => (
                      <tr key={i}>
                        <td>{x.filesystem || '—'}</td>
                        <td className="muted" style={{ whiteSpace: 'normal' }}>{x.path || '—'}</td>
                        <td data-sort={String(x.usedBytes ?? -1)}>{x.usedBytes != null ? fmtBytes(x.usedBytes) : '—'}</td>
                        <td data-sort={String(x.softBytes ?? -1)}>{x.softBytes != null ? fmtBytes(x.softBytes) : '—'}</td>
                        <td data-sort={String(x.hardBytes ?? -1)}>{x.hardBytes != null ? fmtBytes(x.hardBytes) : '—'}</td>
                        <td className="muted">{x.state || '—'}</td>
                      </tr>
                    ))}</tbody>
                  </STable>
                </div>
              </div>
            ) : (
              <div key={k} className="muted" style={{ fontSize: 11.5 }}>
                {q.label}: 명령은 실행됐고 항목이 0건입니다.
              </div>
            )
          ))}

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
