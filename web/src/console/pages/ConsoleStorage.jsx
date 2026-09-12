// 스토리지(v2.487) — 데이터스토어(/datastores) · 어레이(/tools/storage) · SAN(/tools/sanswitch) · 소진 예측(/tools/capacity-forecast).
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, KpiCard, PctCell, Bar, LevelBadge, PollState, Empty } from '../ui.jsx';
import { datastoreTypeCounts, datastoresOver, storageRows, sanCells, sanTotals, fmtInt, fmtPct, fmtBytesTB, colorOf, rowMatches, ageText } from '../consoleData.js';

export default function ConsoleStorage({ global: g, scope, polls, perms }) {
  const canSan = toolAllowed('san-switch'), canFc = toolAllowed('forecast');
  const san = usePolling(canSan ? '/tools/sanswitch' : null, {}, 60_000);
  const fc = usePolling(canFc ? '/tools/capacity-forecast' : null, {}, 120_000);
  const now = Date.now();
  const dsAll = scope.scoped(polls.ds.data?.items || []);
  const types = datastoreTypeCounts(dsAll);
  const over90 = dsAll.filter((d) => d.usagePct >= 90).length, over95 = dsAll.filter((d) => d.usagePct >= 95).length;
  const arrays = storageRows(polls.stor.data?.devices, polls.stor.data?.types).filter((r) => rowMatches(r, scope.q));
  const cells = sanCells(san.data?.devices);
  const st = sanTotals(cells);
  const dsOver = datastoresOver(dsAll.filter((d) => rowMatches(d, scope.q)), 85, fc.data?.items, 8);
  const arrOk = arrays.filter((a) => a.ok === true).length, arrBad = arrays.filter((a) => a.ok === false).length;

  return (
    <>
      <div className="dvc-kpis">
        <KpiCard label="데이터스토어" value={polls.ds.data ? fmtInt(dsAll.length) : '—'} accent="#0f172a" meta={polls.ds.data ? `VMFS ${types.VMFS} · vSAN ${types.vSAN} · NFS ${types.NFS}${types.기타 ? ` · 기타 ${types.기타}` : ''}` : '수집 대기'} />
        <KpiCard label="스토리지 어레이" value={polls.stor.data ? fmtInt(arrays.length) : '—'} accent="#0891b2" meta={polls.stor.data ? (arrays.length ? `수집 정상 ${arrOk} · 실패 ${arrBad} · 미수집 ${arrays.length - arrOk - arrBad}` : '등록된 장비 없음') : perms.storage ? '수집 대기' : "권한 필요('tools')"} />
        <KpiCard label="전사 사용률" value={fmtPct(g?.storageUsagePct)} accent={colorOf(g?.storageUsagePct)} meta={g ? `${g.storageUsedTB} / ${g.storageTotalTB} TB (vCenter 데이터스토어 합)` : '수집 대기'} />
        <KpiCard label="임계 초과 DS" value={polls.ds.data ? fmtInt(over90) : '—'} accent="#ef4444" meta={polls.ds.data ? `≥ 90% ${over90} · ≥ 95% ${over95} (서버 알람 기준과 동일)` : '수집 대기'} />
        <KpiCard label="SAN 스위치" value={san.data ? fmtInt(st.devices) : '—'} accent="#f59e0b" meta={san.data ? (st.measured ? `포트 ${fmtInt(st.online)}/${fmtInt(st.total)} 온라인 · 오프라인 ${st.offline} · 결함 ${st.faulty}` : st.devices ? '포트 스냅샷 없음' : '등록된 장비 없음') : canSan ? '수집 대기' : "권한 필요('tools')"} />
      </div>

      <div className="dvc-grid2">
        <Panel title={`스토리지 어레이 ${arrays.length}`} sub="StorageMon · 사용률 내림차순 · 값 없음 = 미수집(—)" bodyPad={false}>
          <PollState poll={polls.stor} skipped={perms.storage ? null : "특수 기능('tools') 권한이 없어 /tools/storage 를 조회하지 않습니다."}>
            {arrays.length === 0 ? (
              <Empty><b>등록된 스토리지 장비가 없습니다.</b><br />특수 기능 › 스토리지 모니터링에서 장비(Isilon·PowerStore·Unity·XtremIO·VMAX·VPLEX)를 등록하면 여기에 용량·노드·수집 상태가 표시됩니다.</Empty>
            ) : (
              <div className="dvc-tablewrap">
                <STable className="dvc-table">
                  <thead><tr><th>어레이</th><th>법인</th><th>타입</th><th className="num">용량</th><th>사용률</th><th className="num">노드</th><th className="num">수집</th><th>상태</th></tr></thead>
                  <tbody>
                    {arrays.map((a) => (
                      <tr key={a.id}>
                        <td><div className="dvc-mono" style={{ fontSize: 12, fontWeight: 600 }}>{a.name}</div>{a.version && <div className="dvc-cellsub">{a.version}</div>}</td>
                        <td className="dvc-dim">{a.dc || '—'}</td>
                        <td className="dvc-dim ellipsis" style={{ maxWidth: 160 }}>{a.typeLabel}</td>
                        <td className="num" data-sort={a.totalBytes ?? ''}>{fmtBytesTB(a.totalBytes)}</td>
                        <td data-sort={a.pct ?? ''}><PctCell pct={a.pct} /></td>
                        <td className="num dvc-dim" data-sort={a.nodes ?? ''}>{a.nodes ?? '—'}</td>
                        <td className="num dvc-dim" data-sort={a.collectedAt ? Date.parse(a.collectedAt) : ''}>{a.collectedAt ? ageText(a.collectedAt, now) : '—'}</td>
                        <td><LevelBadge level={a.ok === true ? 0 : a.ok === false ? 2 : null} label={a.ok === true ? '정상' : a.ok === false ? '수집 실패' : '미수집'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </PollState>
        </Panel>
        <div className="dvc-col">
          <Panel title="SAN 스위치 포트" sub={san.data ? `${st.devices}대 · 셀 = 스위치 · 온라인/전체` : ''}>
            <PollState poll={san} skipped={canSan ? null : "특수 기능('tools') 권한이 없어 /tools/sanswitch 를 조회하지 않습니다."}>
              {cells.length === 0 ? <Empty><b>등록된 SAN 스위치가 없습니다.</b><br />특수 기능 › SAN 스위치 모니터링에서 Brocade 스위치를 등록하면 포트 상태가 표시됩니다.</Empty> : (
                <>
                  <div className="dvc-cells">
                    {cells.map((c) => (
                      <div key={c.id} className={`dvc-cell ${c.level == null ? 'lvn' : `lv${c.level}`}`} title={`${c.name}${c.dc ? ` · ${c.dc}` : ''} · ${c.total != null ? `온라인 ${c.online}/${c.total} · 오프라인 ${c.offline ?? 0} · 결함 ${c.faulty ?? 0}` : (c.error || '스냅샷 없음')}`}>
                        <div className="dvc-cell-name">{c.name}</div>
                        <div className="dvc-cell-val">{c.total != null ? `${c.online}/${c.total}` : '—'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="dvc-note" style={{ marginTop: 10 }}>오프라인 {st.offline} · 결함 {st.faulty} · 스냅샷 없음 {st.devices - st.measured}. 색: 문제 포트 0 초록 · 1 노랑 · 2 이상 빨강.</div>
                </>
              )}
            </PollState>
          </Panel>
          <Panel title="임계 초과 데이터스토어" sub="사용률 ≥ 85% · 소진 예상은 /tools/capacity-forecast(선형 추정)">
            <PollState poll={polls.ds}>
              {dsOver.length === 0 ? <Empty>사용률 85% 이상인 데이터스토어가 없습니다.</Empty> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {dsOver.map((d) => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }} title={`${d.name} · ${d.vcenterId} · ${fmtInt(d.usedGB)} / ${fmtInt(d.capacityGB)} GB`}>
                      <span className="dvc-mono" style={{ fontSize: 11, width: 150, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                      <Bar pct={d.usagePct} />
                      <span className="dvc-num" style={{ fontSize: 11, color: colorOf(d.usagePct), width: 34, textAlign: 'right' }}>{fmtPct(d.usagePct)}</span>
                      <span className="dvc-num dvc-faint" style={{ fontSize: 10, width: 48, textAlign: 'right' }} title={d.daysToFull != null ? `소진 예상 ${d.daysToFull}일${d.synthesized ? ' (mock 합성 증가율)' : ''}` : (canFc ? '증가 추세 자료 부족' : '예측 권한 없음')}>{d.daysToFull != null ? `${d.daysToFull}d${d.synthesized ? '*' : ''}` : '—'}</span>
                    </div>
                  ))}
                  {fc.data?.mock && <div className="dvc-note">* mock 데이터 소스에서는 증가율이 합성값입니다.</div>}
                </div>
              )}
            </PollState>
          </Panel>
        </div>
      </div>
    </>
  );
}
