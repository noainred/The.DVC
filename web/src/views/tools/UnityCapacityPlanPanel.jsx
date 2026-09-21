/**
 * views/tools/UnityCapacityPlanPanel.jsx — Unity 용량 산정 패널(v2.540).
 *
 * 사용자 요청(2026-09-17): uemcli `/stor/config/pool show -detail` 화면을 보여 주며 "이 화면 참고해서
 * 용량 산정 하는 기능 만들어줘" · "이 화면에 맞게 일단 만들어줘"(스토리지 모니터링 장비 상세).
 * 산정 대상 4가지 — ① 할당 가능량 ② 소진 예상일 ③ 수용 개수 ④ 원시·유효 용량.
 *
 * 판정·계산은 전부 `unityCapacityPlan.js`(순수 모듈, vitest 로 고정)가 한다. 이 파일은 그리기만 한다.
 *
 * ⚠ 지킬 것:
 *  - **값이 없으면 그리지 않는다**(0 을 지어내지 않는다). Unity 가 아니거나 용량을 못 읽었으면 패널 자체가 없다.
 *  - **할당 가능량은 기준을 나란히** 낸다 — 씬 프로비저닝이라 '물리 잔여' 만 보면 과대평가다.
 *    가장 작은 기준에 **실질 한도** 배지를 단다.
 *  - **소진 예상은 증가 중일 때만** 내고 **근거 기간**을 함께 적는다(v2.531 규약).
 *  - **원시 용량은 추정**이라고 말한다 — 계산이 장비 보고와 맞지 않는다(모듈 머리말의 실측).
 *  - 문구에 `**강조**` 를 쓰면 반드시 `BoldText` 로 렌더한다(v2.439/2.440/2.505 실제 사고).
 */
import React, { useState } from 'react';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  planInput, headroom, fitCount, fitCountByPool, poolPressure, poolPressureNote,
  trendPerDay, runway, rawCapacity, verifyIdentity, tb, sizeText, daysText, posNum,
} from './unityCapacityPlan.js';

/** 수용 개수 계산의 단위 프리셋(GB) — 흔한 VM/LUN 크기. 직접 입력도 받는다. */
const UNIT_PRESETS = [100, 200, 500, 1024, 2048];
const GIB = 1024 ** 3;

function Row({ label, value, sub, accent }) {
  return (
    <tr>
      <td style={{ whiteSpace: 'normal' }}>{label}{sub ? <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>{sub}</div> : null}</td>
      <td className="right" style={{ fontWeight: accent ? 700 : 400, color: accent ? 'var(--accent)' : undefined }}>{value}</td>
    </tr>
  );
}

export default function UnityCapacityPlanPanel({ snap, points }) {
  const [unitGb, setUnitGb] = useState(200);
  const [custom, setCustom] = useState('');

  const input = planInput(snap);
  if (!input || !input.totalBytes) return null;          // 용량을 못 읽었으면 그리지 않는다

  const ident = verifyIdentity(input);
  const head = headroom(input);
  const trend = trendPerDay(points);
  const way = runway({ ...input, trend });
  const raw = rawCapacity({ ...input, deviceUsableBytes: input.totalBytes });
  // v2.546 — 풀별 압박도(전체는 여유인데 한 풀만 꽉 찬 경우를 드러낸다).
  const pressure = poolPressure(input.pools);
  const pressNote = poolPressureNote(pressure, snap?.capacity?.pct ?? null);

  const unitBytes = (posNum(custom) || unitGb) * GIB;
  const fit = fitCount(head, unitBytes);
  const byPool = fitCountByPool(head, input.pools, unitBytes);

  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-title" style={{ fontSize: 13 }}>
        용량 산정
        <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> — 지금 얼마를 더 줄 수 있고, 언제 차는지</span>
      </div>

      {!ident.ok && (
        <div className="badge red" style={{ display: 'block', whiteSpace: 'normal', marginBottom: 8, padding: '6px 8px' }}>
          ⚠ {ident.text}
        </div>
      )}

      {/* ① 할당 가능량 — 기준을 나란히, 가장 작은 것이 실질 한도 */}
      {head && (
        <>
          <div className="muted" style={{ fontSize: 11.5, margin: '2px 0 4px' }}>
            <BoldText text="① 더 줄 수 있는 용량 — **기준마다 답이 다릅니다**. 씬 프로비저닝이라 물리 잔여만 보면 과대평가입니다." />
          </div>
          <div className="table-wrap">
            <STable className="v3-table rpt-wrap">
              <thead><tr><th>기준</th><th className="right">더 줄 수 있는 양</th></tr></thead>
              <tbody>
                {head.bases.map((b) => (
                  <Row
                    key={b.key}
                    label={<>{b.label}{b.key === head.limiting.key && <span className="badge amber" style={{ marginLeft: 6, fontSize: 10.5 }}>실질 한도</span>}</>}
                    sub={<BoldText text={b.note} />}
                    value={tb(b.availBytes)}
                    accent={b.key === head.limiting.key}
                  />
                ))}
              </tbody>
            </STable>
          </div>
          {/*
            * ⚠ v2.546 — 예전에는 여기 문구가 `**…**` 를 **BoldText 없이** 그려 별표가 그대로 샜고
            *   (v2.439·2.440·2.505 와 같은 유형), 내용도 '경고 임계를 표시하지 않는다' 였다.
            *   이제 임계는 **풀별로** 보여주므로(아래 표) 여기서는 RAID·드라이브만 말한다.
            */}
          {input.multiPool && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal' }}>
              <BoldText text={`풀이 ${input.poolCount}개라 **RAID·드라이브 구성은 표시하지 않습니다** — 풀마다 값이 달라 대표값을 만들면 거짓이 됩니다. 경고 임계는 아래에서 **풀마다** 판정합니다.`} />
            </div>
          )}
          {input.excludedPoolCount > 0 && (
            <div style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal', color: 'var(--amber)' }}>
              <BoldText text={`⚠ 용량 또는 사용량을 읽지 못한 풀 ${input.excludedPoolCount}개는 **위 계산에서 빠졌습니다** — 실제로는 더 줄 수 있는 양이 다를 수 있습니다.`} />
            </div>
          )}

          {/* ①-b 풀별 압박도 — 전체는 여유인데 특정 풀만 꽉 찬 경우(v2.546, 사용자 제안) */}
          {input.multiPool && pressure.length > 0 && (
            <>
              {pressNote && (
                <div
                  className={pressNote.kind === 'over' ? 'badge red' : 'badge amber'}
                  style={{ display: 'block', whiteSpace: 'normal', margin: '8px 0 6px', padding: '6px 8px', lineHeight: 1.6 }}
                >
                  <BoldText text={pressNote.text} />
                </div>
              )}
              <div className="table-wrap">
                <STable className="v3-table rpt-wrap">
                  <thead><tr><th>풀</th><th className="right">사용률</th><th className="right">경고 임계</th><th className="right">임계까지</th><th>판정</th></tr></thead>
                  <tbody>
                    {pressure.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="right">{r.pct == null ? '—' : `${r.pct}%`}</td>
                        <td className="right">{r.thresholdPct == null ? '—' : `${r.thresholdPct}%`}</td>
                        {/*
                          * ⚠ 음수를 그대로 `-11.7 TB` 로 찍지 말 것(v2.546 스크린샷 판독에서 발견) —
                          *   열 이름이 '임계까지' 라 마이너스 숫자가 무슨 뜻인지 읽히지 않는다.
                          *   넘긴 양은 **'초과 11.7 TB'** 로 말한다(수치는 그대로, 부호를 말로 바꾼다).
                          */}
                        <td className="right" style={{ color: r.availToThresholdBytes < 0 ? 'var(--red)' : undefined }}>
                          {r.availToThresholdBytes == null
                            ? '—'
                            : (r.availToThresholdBytes < 0 ? `초과 ${tb(-r.availToThresholdBytes)}` : tb(r.availToThresholdBytes))}
                        </td>
                        <td>
                          {r.state === 'over' && <span className="badge red" style={{ fontSize: 10.5 }}>임계 초과</span>}
                          {r.state === 'near' && <span className="badge amber" style={{ fontSize: 10.5 }}>임계 근접</span>}
                          {r.state === 'ok' && <span className="badge green" style={{ fontSize: 10.5 }}>여유</span>}
                          {r.state === 'unknown' && <span className="badge" style={{ fontSize: 10.5 }}>판정 불가</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              <div className="muted" style={{ fontSize: 10.5, marginTop: 3, whiteSpace: 'normal' }}>
                <BoldText text="임계 근접 = 임계의 90% 이상. 판정 불가는 임계 또는 사용량을 읽지 못한 것이며 **이상 없음이라는 뜻이 아닙니다**." />
              </div>
            </>
          )}
        </>
      )}

      {/* ② 소진 예상 */}
      <div className="muted" style={{ fontSize: 11.5, margin: '10px 0 4px' }}>② 언제 차나</div>
      {!way || way.perDayBytes == null || !way.toFull ? (
        <div className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>
          {way?.reason || '용량 추이 표본이 없어 증가 속도를 알 수 없습니다.'}
          {way?.basis ? <span> (근거: {way.basis})</span> : null}
        </div>
      ) : (
        <div className="table-wrap">
          <STable className="v3-table rpt-wrap">
            <thead><tr><th>구간</th><th className="right">남은 기간</th><th className="right">예상 도달일</th></tr></thead>
            <tbody>
              {way.toAlert && (
                <tr>
                  <td>경고 임계({way.toAlert.thresholdPct}%)</td>
                  <td className="right">{way.toAlert.passed ? '이미 넘음' : daysText(way.toAlert.days)}</td>
                  <td className="right">{way.toAlert.passed ? '—' : new Date(way.toAlert.at).toLocaleDateString('ko-KR')}</td>
                </tr>
              )}
              <tr>
                <td>전체 소진(100%)</td>
                <td className="right" style={{ fontWeight: 700 }}>{way.toFull.passed ? '이미 가득참' : daysText(way.toFull.days)}</td>
                <td className="right">{way.toFull.passed ? '—' : new Date(way.toFull.at).toLocaleDateString('ko-KR')}</td>
              </tr>
            </tbody>
          </STable>
        </div>
      )}
      {way?.perDayBytes > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal' }}>
          하루 증가 {sizeText(way.perDayBytes)} · 근거: {way.basis}
          {way.weak && <span style={{ color: 'var(--amber)' }}> · ⚠ {way.reason || '표본이 적어 추세가 흔들릴 수 있습니다.'}</span>}
        </div>
      )}

      {/* ③ 수용 개수 */}
      <div className="muted" style={{ fontSize: 11.5, margin: '10px 0 4px' }}>③ 몇 개 더 들어가나</div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        {UNIT_PRESETS.map((g) => (
          <button
            key={g} type="button"
            className={!custom && unitGb === g ? 'login-btn' : 'logout-btn'}
            style={{ flex: 'none', padding: '3px 9px', fontSize: 11.5 }}
            onClick={() => { setUnitGb(g); setCustom(''); }}
          >
            {g >= 1024 ? `${g / 1024} TB` : `${g} GB`}
          </button>
        ))}
        <input
          className="input" type="number" min="1" placeholder="직접 입력(GB)"
          value={custom} onChange={(e) => setCustom(e.target.value)}
          style={{ width: 130, minWidth: 0, padding: '3px 8px', fontSize: 11.5 }}
        />
      </div>
      {fit ? (
        <div style={{ fontSize: 13 }}>
          {/*
            * ⚠ v2.546 — **풀이 여러 개면 합산 여유를 한 덩어리로 세지 않는다.** 풀 경계를 넘을 수
            *   없으므로 `fitCountByPool` 이 풀마다 세어 더한 값을 쓰고, '한 개짜리 최대 크기' 를
            *   함께 낸다. 풀이 1개면 `byPool` 이 한 줄이라 예전 값과 같다(회귀 없음).
            */}
          <b style={{ fontSize: 18, color: 'var(--accent)' }}>{(byPool ? byPool.count : fit.count).toLocaleString('ko-KR')}개</b>
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
            {sizeText(unitBytes)} 단위 · 계산 기준 <b>{fit.basisLabel}</b> {tb(fit.availBytes)}
            {byPool ? null : <> · 남는 공간 {sizeText(fit.leftoverBytes)}</>}
          </span>
          {byPool && input.multiPool && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal', lineHeight: 1.6 }}>
              <BoldText
                text={`풀별 ${byPool.byPool.map((b) => `${b.name} ${b.count.toLocaleString('ko-KR')}개`).join(' · ')}`
                  + ` — **한 개로 만들 수 있는 최대 크기는 ${sizeText(byPool.maxSingleBytes)}**(${byPool.maxSinglePool})입니다.`
                  + ' 공간은 **풀 경계를 넘지 못하므로** 합계를 한 덩어리로 쓸 수 없습니다.'
                  + (byPool.skippedPools > 0 ? ` ⚠ 이 기준으로 계산할 수 없는 풀 ${byPool.skippedPools}개는 빠졌습니다.` : '')}
              />
            </div>
          )}
          {byPool && !byPool.fitsSingle && (
            <div className="badge amber" style={{ display: 'block', whiteSpace: 'normal', marginTop: 6, padding: '6px 8px', lineHeight: 1.6 }}>
              <BoldText
                text={`⚠ 요청한 ${sizeText(unitBytes)} 는 **어느 풀에도 들어가지 않습니다** — 가장 큰 풀 여유가 `
                  + `${sizeText(byPool.maxSingleBytes)}(${byPool.maxSinglePool})입니다.`}
              />
            </div>
          )}
        </div>
      ) : <div className="muted" style={{ fontSize: 12 }}>단위 크기를 입력하세요.</div>}

      {/* ④ 원시·유효 용량 */}
      {raw && (
        <>
          <div className="muted" style={{ fontSize: 11.5, margin: '12px 0 4px' }}>④ 원시 · 유효 용량</div>
          <div className="table-wrap">
            <STable className="v3-table rpt-wrap">
              <thead><tr><th>항목</th><th className="right">값</th></tr></thead>
              <tbody>
                <Row label="드라이브" value={`${raw.drives.count}개`} sub={raw.drives.text} />
                <Row
                  label="원시 용량(추정)"
                  value={`${tb(raw.rawLow)} ~ ${tb(raw.rawHigh)}`}
                  sub={`표기 ‘${raw.drives.text.split(/\s+/)[2] || ''}’ 를 10진 TB 로 볼 때와 TiB 로 볼 때의 범위입니다.`}
                />
                {raw.raid && (
                  <Row
                    label={`RAID ${raw.raid}${raw.stripeLength ? ` (스트라이프 ${raw.stripeLength})` : ''}`}
                    value={raw.parityShare != null ? `패리티 제외 ${(raw.parityShare * 100).toFixed(1)}%` : '—'}
                    sub={raw.parityShare == null ? 'RAID 수준이나 스트라이프 길이를 몰라 패리티 비율을 계산하지 않았습니다.' : null}
                  />
                )}
                <Row label="장비가 보고한 유효 용량" value={tb(raw.deviceUsableBytes)} accent
                  sub={raw.usableShareLow != null ? `원시 추정 대비 ${raw.usableShareLow}~${raw.usableShareHigh}%` : null} />
              </tbody>
            </STable>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4, whiteSpace: 'normal', lineHeight: 1.6 }}>
            <BoldText text={raw.note} />
          </div>
        </>
      )}
    </div>
  );
}
