/**
 * V4 ⑦ 스토리지(v2.490 → v2.508) — 시안 EngStorage.dc.html.
 * KPI · 어레이(/tools/storage) · SAN 포트(/tools/sanswitch) · 임계 초과 DS
 *  + v2.508 추가: 고아 VMDK 후보(v2.505) · 게스트 디스크 회수 · DS 증감 상위.
 *
 * ⚠ 고아 VMDK 는 **폴링하지 않는다** — 실행마다 그 데이터스토어의 VM 을 다시 읽는 vCenter SOAP
 *   왕복이 발생한다(v2.505). 사용자가 데이터스토어를 고르고 '스캔' 을 눌렀을 때만 1회 조회한다.
 */
import React, { useState } from 'react';
import { usePolling, toolAllowed, can, fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, PctCell, Bar, Badge, PollState, Empty } from '../ui.jsx';
import { datastoreTypeCounts, datastoresOver, storageRows, sanCells, sanTotals, fmtInt, fmtPct, fmtBytesTB, textColor, rowMatches, ageText, tsMs } from '../data.js';

export default function Storage({ global: g, scope, polls, perms, spec, phase, phaseText, health }) {
  // 수집이 끝나기 전 KPI 메타 문구(v2.509) — 예전에는 전부 '수집 대기' 라 **기다리면 되는 상황과
  // 조치가 필요한 상황이 같은 말**이었다. 셸이 /health 로 판정한 phase 를 쓴다.
  // ⚠ NSX 는 vCenter 수집과 **다른 수집기**(/nsx)라 이 문구를 쓰지 않는다 — vCenter 대수로
  //   NSX 상태를 말하면 확인하지 않은 것을 말하는 셈이다.
  const waitText = phaseText?.short || '수집 대기';
  const canSan = toolAllowed('san-switch'), canFc = toolAllowed('forecast');
  const canTools = can('tools');
  const canOrphan = canTools && toolAllowed('orphanvmdk');
  const canGuest = canTools && toolAllowed('guest-disk');
  const canTrack = canTools && toolAllowed('vm-track');
  // 고아 VMDK — 대상 목록만 가볍게 받아 두고, 스캔은 버튼으로 1회만 돈다.
  const odl = usePolling(canOrphan ? '/tools/orphan-vmdk/datastores' : null, {}, 300_000);
  const gd = usePolling(canGuest ? '/tools/guest-disk' : null, {}, 300_000);
  const dsTop = usePolling(canTrack ? '/tools/vm-track/ds-top' : null, { days: spec?.days ?? 30 }, 300_000);
  const [scanDs, setScanDs] = useState('');
  const [scan, setScan] = useState(null);       // { items, warning, ... }
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState('');
  const runScan = async () => {
    if (!scanDs || scanning) return;            // 재진입 가드 — 연타가 vCenter 부하를 곱하지 않게
    setScanning(true); setScanErr(''); setScan(null);
    try { setScan(await fetchJson('/tools/orphan-vmdk', { datastoreId: scanDs })); }
    catch (e) { setScanErr(e.message || String(e)); }
    finally { setScanning(false); }
  };
  const san = usePolling(canSan ? '/tools/sanswitch' : null, {}, 60_000);
  const fc = usePolling(canFc ? '/tools/capacity-forecast' : null, {}, 120_000);
  const now = Date.now();
  const dsAll = scope.scoped(polls.ds.data?.items || []);
  const types = datastoreTypeCounts(dsAll);
  const over90 = dsAll.filter((d) => d.usagePct >= 90).length, over95 = dsAll.filter((d) => d.usagePct >= 95).length;
  const arrays = storageRows(polls.stor.data?.devices, polls.stor.data?.types).filter((r) => rowMatches(r, scope.q));
  const cells = sanCells(san.data?.devices);
  const st = sanTotals(cells);
  const dsOver = datastoresOver(dsAll.filter((d) => rowMatches(d, scope.q)), 85, fc.data?.items, 7);
  const arrOk = arrays.filter((a) => a.ok === true).length, arrBad = arrays.filter((a) => a.ok === false).length;

  return (
    <>
      <div className="v3-kpis">
        <Kpi label="데이터스토어" value={polls.ds.data ? fmtInt(dsAll.length) : '—'} accent="#1a2130" meta={polls.ds.data ? `VMFS ${types.VMFS} · vSAN ${types.vSAN} · NFS ${types.NFS}${types.기타 ? ` · 기타 ${types.기타}` : ''}` : waitText} />
        <Kpi label="스토리지 어레이" value={polls.stor.data ? fmtInt(arrays.length) : '—'} accent="#0e7490" meta={polls.stor.data ? (arrays.length ? `수집 정상 ${arrOk} · 실패 ${arrBad} · 미수집 ${arrays.length - arrOk - arrBad}` : '등록된 장비 없음') : perms.storage ? waitText : "권한 필요('tools')"} />
        <Kpi label="전사 사용률" value={fmtPct(g?.storageUsagePct)} accent={textColor(g?.storageUsagePct)} meta={g ? `${g.storageUsedTB} / ${g.storageTotalTB} TB (vCenter 데이터스토어 합)` : waitText} />
        <Kpi label="임계 초과" value={polls.ds.data ? fmtInt(over90) : '—'} accent="#dc2626" meta={polls.ds.data ? `데이터스토어 ≥ 90% ${over90} · ≥ 95% ${over95}` : waitText} />
        <Kpi label="SAN 스위치" value={san.data ? fmtInt(st.devices) : '—'} accent="#d97706" meta={san.data ? (st.measured ? `포트 ${fmtInt(st.online)}/${fmtInt(st.total)} 온라인 · 오프라인 ${st.offline} · 결함 ${st.faulty}${st.failed ? ` · 수집 실패 ${st.failed}대` : ''}` : st.failed ? `수집 실패 ${st.failed}대` : st.devices ? '포트 스냅샷 없음' : '등록된 장비 없음') : canSan ? waitText : "권한 필요('tools')"} />
      </div>

      <div className="v3-grid2">
        <Panel title={`스토리지 어레이 ${arrays.length}`} sub="StorageMon · 사용률 내림차순 · 값 없음 = 미수집(—)" bodyPad={false}>
          <PollState poll={polls.stor} skipped={perms.storage ? null : "특수 기능('tools') 권한이 없어 /tools/storage 를 조회하지 않습니다."}>
            {arrays.length === 0 ? (
              <Empty><b>등록된 스토리지 장비가 없습니다.</b><br />특수 기능 › 스토리지 모니터링에서 장비를 등록하면 용량·노드·수집 상태가 표시됩니다.</Empty>
            ) : (
              <div className="v3-tablewrap">
                <STable className="v3-table">
                  <thead><tr><th>어레이</th><th>사이트</th><th>모델</th><th className="num">용량</th><th>사용률</th><th className="num">노드</th><th className="num">수집</th><th>상태</th></tr></thead>
                  <tbody>
                    {arrays.map((a) => (
                      <tr key={a.id}>
                        <td><div className="v3-mono" style={{ fontSize: 12, fontWeight: 600 }}>{a.name}</div>{a.version && <div className="v3-cellsub">{a.version}</div>}</td>
                        <td className="v3-dim">{a.dc || '—'}</td>
                        <td className="v3-dim ellipsis" style={{ maxWidth: 160 }}>{a.typeLabel}</td>
                        <td className="num" data-sort={a.totalBytes ?? ''}>{fmtBytesTB(a.totalBytes)}</td>
                        <td data-sort={a.pct ?? ''}><PctCell pct={a.pct} /></td>
                        <td className="num v3-dim" data-sort={a.nodes ?? ''}>{a.nodes ?? '—'}</td>
                        <td className="num v3-dim" data-sort={Number.isFinite(tsMs(a.collectedAt)) ? tsMs(a.collectedAt) : ''}>{a.collectedAt ? ageText(a.collectedAt, now) : '—'}</td>
                        <td><Badge level={a.ok === true ? 0 : a.ok === false ? 2 : null} label={a.ok === true ? '정상' : a.ok === false ? '수집 실패' : '미수집'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </PollState>
        </Panel>
        <div className="v3-col">
          <Panel title="SAN 스위치 포트" sub={san.data ? `${st.devices}대 · 셀 = 스위치 · 온라인/전체` : ''}>
            <PollState poll={san} skipped={canSan ? null : "특수 기능('tools') 권한이 없어 /tools/sanswitch 를 조회하지 않습니다."}>
              {cells.length === 0 ? <Empty><b>등록된 SAN 스위치가 없습니다.</b><br />특수 기능 › SAN 스위치 모니터링에서 스위치를 등록하면 포트 상태가 표시됩니다.</Empty> : (
                <>
                  <div className="v3-cells">
                    {cells.map((c) => (
                      <div key={c.id} className={`v3-cell ${c.level == null ? 'lvn' : `lv${c.level}`}`} title={`${c.name}${c.dc ? ` · ${c.dc}` : ''} · ${c.total != null ? `온라인 ${c.online}/${c.total} · 오프라인 ${c.offline ?? 0} · 결함 ${c.faulty ?? 0}` : (c.error || '스냅샷 없음')}`}>
                        <div className="v3-cell-name">{c.name}</div>
                        <div className="v3-cell-val">{c.failed ? '수집 실패' : c.total != null ? `${c.online}/${c.total}` : '—'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="v3-note" style={{ marginTop: 10 }}>오프라인 {st.offline} · 결함 {st.faulty} · 수집 실패 {st.failed} · 스냅샷 없음 {st.none}. 색: 문제 포트 0 초록 · 1 노랑 · 2 이상 빨강.</div>
                </>
              )}
            </PollState>
          </Panel>
          <Panel title="임계 초과 데이터스토어" sub="사용률 ≥ 85% · 소진 예상은 선형 추정(/tools/capacity-forecast)">
            <PollState poll={polls.ds} phase={phase} health={health}>
              {dsOver.length === 0 ? <Empty>사용률 85% 이상인 데이터스토어가 없습니다.</Empty> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {dsOver.map((d) => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }} title={`${d.name} · ${d.vcenterId} · ${fmtInt(d.usedGB)} / ${fmtInt(d.capacityGB)} GB`}>
                      <span className="v3-mono" style={{ fontSize: 11, width: 150, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                      <Bar pct={d.usagePct} />
                      <span className="v3-num" style={{ fontSize: 11, color: textColor(d.usagePct), width: 34, textAlign: 'right' }}>{fmtPct(d.usagePct)}</span>
                      <span className="v3-num v3-faint" style={{ fontSize: 10, width: 44, textAlign: 'right' }} title={d.daysToFull != null ? `소진 예상 ${d.daysToFull}일${d.synthesized ? ' (mock 합성 증가율)' : ''}` : (canFc ? '증가 추세 자료 부족' : '예측 권한 없음')}>{d.daysToFull != null ? `${d.daysToFull}d${d.synthesized ? '*' : ''}` : '—'}</span>
                    </div>
                  ))}
                  {fc.data?.mock && <div className="v3-note">* mock 데이터 소스에서는 증가율이 합성값입니다.</div>}
                </div>
              )}
            </PollState>
          </Panel>
        </div>
      </div>

      <div className="v3-grid2">
        <Panel title="고아 VMDK — 확인 필요 후보" sub="이 vCenter 인벤토리 기준 · 데이터스토어를 고르고 스캔" right={<span className="v3-tag">/tools/orphan-vmdk</span>}>
          {!canOrphan ? <Empty>이 패널은 “특수 기능(tools)” 권한과 <code>orphanvmdk</code> 접근이 필요합니다.</Empty> : (
            <>
              <div className="v4-band warn">
                <span>⚠ 여기 나오는 파일은 <b>‘확인 필요 후보’</b>이지 삭제 대상이 아닙니다. 판정은 <b>이 vCenter 인벤토리 기준</b>이라,
                  <b> 공유 데이터스토어(다른 vCenter 가 등록한 VM) · FCD/쿠버네티스 PV · 콘텐츠 라이브러리 · vSphere Replication ·
                  등록 해제한 VM · 진행 중인 복제·마이그레이션·백업</b>은 멀쩡히 쓰이는데도 소유자 없이 보입니다.
                  그래서 이 화면은 <b>삭제 기능을 제공하지 않습니다</b>(API 자체가 없습니다).</span>
              </div>
              <div className="flex gap wrap" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
                <label className="v3-chip" style={{ flex: 1, minWidth: 200 }}><span>데이터스토어</span>
                  <select value={scanDs} onChange={(e) => setScanDs(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    <option value="">선택…</option>
                    {(odl.data?.items || []).filter((d) => scope.inScope(d.vcenterId)).map((d) => (
                      <option key={d.id} value={d.id} disabled={d.scannable === false}>
                        {d.name} ({fmtPct(d.usagePct)}){d.scannable === false ? ' — 스캔 불가' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="v3-exit" disabled={!scanDs || scanning} onClick={runScan}>{scanning ? '스캔 중…' : '스캔'}</button>
              </div>
              {scanErr && <div className="v3-banner">스캔 실패: {scanErr}</div>}
              {!scan && !scanErr && <Empty>아직 스캔하지 않았습니다 — 후보 수는 <b>스캔해야 알 수 있습니다</b>(상시 수집 항목이 아닙니다).
                {(() => { const d = (odl.data?.items || []).find((x) => x.id === scanDs); return d?.scannable === false ? <> 선택한 데이터스토어는 스캔할 수 없습니다: {d.notScannableReason}</> : null; })()}
              </Empty>}
              {scan && ((scan.items || []).length === 0
                ? <Empty>소유 VM 이 없는 파일을 찾지 못했습니다{scan.excluded ? ` (제외 ${fmtInt(scan.excluded)}건)` : ''}.</Empty>
                : (
                  <div className="v3-tablewrap">
                    {/* v2.575 BUG-19: 상한은 STable 이 **정렬 뒤** 적용한다(먼저 자르면 '앞 200개를 정렬한 것'). */}
                    <STable className="v3-table" limit={200}>
                      <thead><tr><th>경로</th><th className="num">크기</th><th>판정</th><th className="num">최종 변경</th></tr></thead>
                      <tbody>
                        {(scan.items || []).map((it) => (
                          <tr key={it.path}>
                            <td><div className="v3-cellname ellipsis" title={it.path}>{it.path}</div></td>
                            <td className="num" data-sort={it.sizeBytes ?? ''}>{it.size || '—'}</td>
                            <td><span className="v3-badge lvn">{it.confidence || it.reason || '판정 보류'}</span></td>
                            <td className="num v3-dim" style={{ fontSize: 11 }}>{it.modified || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                    {/* v2.575: 조용한 상한 금지 — 뺀 개수를 밝힌다. */}
                    {(scan.items || []).length > 200 && <div className="v3-note">전체 {fmtInt((scan.items || []).length)}건 중 <b>200건만</b> 표시합니다(열을 눌러 정렬하면 전체를 정렬한 상위 200건입니다).</div>}
                  </div>
                ))}
            </>
          )}
        </Panel>

        <Panel title="게스트 디스크 회수" sub="VMware Tools 가 보고한 게스트 파티션 여유" right={<span className="v3-tag">/tools/guest-disk</span>}>
          <PollState poll={canGuest ? gd : null} skipped={!canGuest ? '이 패널은 “특수 기능(tools)” 권한과 guest-disk 접근이 필요합니다.' : undefined}>
            {(gd.data?.rows || []).length === 0 ? (
              <Empty>
                수집된 게스트 디스크 표본이 <b>{fmtInt(gd.data?.vmCount)}</b>건입니다.
                {gd.data?.settings?.enabled === false
                  ? <> 게스트 디스크 수집이 <b>꺼져 있습니다</b> — 설정 › 수집 서버에서 켜면 채워집니다.</>
                  : <> 수집은 켜져 있지만 아직 적재된 표본이 없습니다(주기 {fmtInt(gd.data?.settings?.intervalHours)}시간).</>}
                {' '}표본이 0인 것과 ‘수집이 불가능한 것’은 다릅니다 — 여기서는 <b>표본 0</b>만 말합니다.
              </Empty>
            ) : (
              <>
                <div className="v4-facts">
                  <div className="v4-fact"><div className="v4-fact-label">회수 가능 합계</div><div className="v4-fact-value">{fmtInt(gd.data.totalReclaimGB)} GB</div><div className="v4-fact-meta">VM {fmtInt(gd.data.vmCount)}대 기준</div></div>
                </div>
                <div className="v3-tablewrap" style={{ marginTop: 12 }}>
                  <STable className="v3-table">
                    <thead><tr><th>VM · 파티션</th><th className="num">할당</th><th className="num">사용</th><th className="num">회수가능</th></tr></thead>
                    <tbody>
                      {gd.data.rows.filter((r) => scope.inScope(r.vcenterId)).slice(0, spec?.rows ?? 10).map((r) => (
                        <tr key={`${r.vmId || r.vm}:${r.path || r.mount}`}>
                          <td><div className="v3-cellname">{r.vm || r.name}</div><div className="v3-cellsub">{r.path || r.mount}</div></td>
                          <td className="num" data-sort={r.capacityGB ?? ''}>{fmtInt(r.capacityGB)} GB</td>
                          <td className="num" data-sort={r.usedGB ?? ''}>{fmtInt(r.usedGB)} GB</td>
                          <td className="num" data-sort={r.reclaimGB ?? ''} style={{ fontWeight: 700 }}>{fmtInt(r.reclaimGB)} GB</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              </>
            )}
          </PollState>
        </Panel>
      </div>

      <Panel title="데이터스토어 증감 상위" sub={`최근 ${spec?.days ?? 30}일 · 하루 2회 스냅샷 · 변경분만 저장`} right={<span className="v3-tag">/tools/vm-track/ds-top</span>} bodyPad={false}>
        <PollState poll={canTrack ? dsTop : null} skipped={!canTrack ? '이 패널은 “특수 기능(tools)” 권한과 vm-track 접근이 필요합니다.' : undefined}>
          <div className="v3-tablewrap">
            <STable className="v3-table">
              <thead><tr><th>데이터스토어</th>{spec?.rawCols && <th>vCenter</th>}<th>사용률</th><th className="num">용량</th><th className="num">증감</th></tr></thead>
              <tbody>
                {(dsTop.data?.items || []).filter((d) => scope.inScope(d.vcenterId)).slice(0, spec?.rows ?? 10).map((d) => (
                  <tr key={d.dsId}>
                    <td><div className="v3-cellname">{d.name}</div></td>
                    {spec?.rawCols && <td className="v3-dim" style={{ fontSize: 11 }}>{d.vcenterId}</td>}
                    <td data-sort={d.usagePct ?? ''}><PctCell pct={d.usagePct} /></td>
                    <td className="num" data-sort={d.capGB ?? ''}>{fmtBytesTB(d.capGB * 1024 * 1024 * 1024)}</td>
                    <td className="num" data-sort={d.deltaGB ?? ''} style={{ color: (d.deltaGB || 0) > 0 ? '#b45309' : '#526075' }}>{d.deltaGB == null ? '—' : `${d.deltaGB > 0 ? '+' : ''}${fmtInt(d.deltaGB)} GB`}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          {(dsTop.data?.changedCount === 0) && (
            <div className="v3-note" style={{ padding: '10px 18px 14px' }}>
              변화가 기록된 데이터스토어가 <b>0건</b>입니다 — 추적은 <b>1GB 이상 변한 것만</b> 적재하므로 변화가 작으면 증감이 <b>—</b> 로 남습니다.
              구버전 행(ds 값 0)을 증감 기준으로 쓰지 않습니다(과거 ‘+2만 TB’ 오표시가 실제로 났습니다).
            </div>
          )}
        </PollState>
      </Panel>
    </>
  );
}
