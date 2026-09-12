// V3 스토리지(v2.490) — KPI 5 · 어레이 표(/tools/storage) · SAN 스위치 셀(/tools/sanswitch) · 임계 초과 데이터스토어(/datastores + /tools/capacity-forecast).
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, PctCell, Bar, Badge, PollState, Empty } from '../ui.jsx';
import { datastoreTypeCounts, datastoresOver, storageRows, sanCells, sanTotals, fmtInt, fmtPct, fmtBytesTB, textColor, rowMatches, ageText } from '../data.js';

export default function Storage({ global: g, scope, polls, perms }) {
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
  const dsOver = datastoresOver(dsAll.filter((d) => rowMatches(d, scope.q)), 85, fc.data?.items, 7);
  const arrOk = arrays.filter((a) => a.ok === true).length, arrBad = arrays.filter((a) => a.ok === false).length;

  return (
    <>
      <div className="v3-kpis">
        <Kpi label="데이터스토어" value={polls.ds.data ? fmtInt(dsAll.length) : '—'} accent="#1a2130" meta={polls.ds.data ? `VMFS ${types.VMFS} · vSAN ${types.vSAN} · NFS ${types.NFS}${types.기타 ? ` · 기타 ${types.기타}` : ''}` : '수집 대기'} />
        <Kpi label="스토리지 어레이" value={polls.stor.data ? fmtInt(arrays.length) : '—'} accent="#0e7490" meta={polls.stor.data ? (arrays.length ? `수집 정상 ${arrOk} · 실패 ${arrBad} · 미수집 ${arrays.length - arrOk - arrBad}` : '등록된 장비 없음') : perms.storage ? '수집 대기' : "권한 필요('tools')"} />
        <Kpi label="전사 사용률" value={fmtPct(g?.storageUsagePct)} accent={textColor(g?.storageUsagePct)} meta={g ? `${g.storageUsedTB} / ${g.storageTotalTB} TB (vCenter 데이터스토어 합)` : '수집 대기'} />
        <Kpi label="임계 초과" value={polls.ds.data ? fmtInt(over90) : '—'} accent="#dc2626" meta={polls.ds.data ? `데이터스토어 ≥ 90% ${over90} · ≥ 95% ${over95}` : '수집 대기'} />
        <Kpi label="SAN 스위치" value={san.data ? fmtInt(st.devices) : '—'} accent="#d97706" meta={san.data ? (st.measured ? `포트 ${fmtInt(st.online)}/${fmtInt(st.total)} 온라인 · 오프라인 ${st.offline} · 결함 ${st.faulty}` : st.devices ? '포트 스냅샷 없음' : '등록된 장비 없음') : canSan ? '수집 대기' : "권한 필요('tools')"} />
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
                        <td className="num v3-dim" data-sort={a.collectedAt ? Date.parse(a.collectedAt) : ''}>{a.collectedAt ? ageText(a.collectedAt, now) : '—'}</td>
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
                        <div className="v3-cell-val">{c.total != null ? `${c.online}/${c.total}` : '—'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="v3-note" style={{ marginTop: 10 }}>오프라인 {st.offline} · 결함 {st.faulty} · 스냅샷 없음 {st.devices - st.measured}. 색: 문제 포트 0 초록 · 1 노랑 · 2 이상 빨강.</div>
                </>
              )}
            </PollState>
          </Panel>
          <Panel title="임계 초과 데이터스토어" sub="사용률 ≥ 85% · 소진 예상은 선형 추정(/tools/capacity-forecast)">
            <PollState poll={polls.ds}>
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
    </>
  );
}
