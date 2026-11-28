/**
 * BackupSection — 보고서 3절 '백업 성공 · 실패 현황'(v3.59 · 설계 docs/design/periodic-report §9 — ⑧ 일일 · ⑨ 주간 변형).
 * 합계 · 법인 줄 · 실패 목록은 서버(backupLedger.js backupSummary · backupCorpRow)가 범위로 자른 뒤 낸 값을 그린다 — 화면은 다시 세지 않는다.
 * 새 판정을 만들지 않는다: 판정 칸은 서비스 축의 백업 항목(veeam · bareos · vm-clone) 것이다. 확정된 날이 없는 수는 '—'(0 을 지어내지 않는다).
 */
import React, { useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import { StatusChip } from './parts.jsx';
import {
  BK_PRODUCT_LABEL, BK_ITEM_KEY, BK_STRIP, BK_STRIP_LABEL, numText, kstText, pctText, bkNum, deltaText, coverageText, backupCorpStatus,
} from './periodicReportText.js';

const FAIL_ROWS = 30;
const STATUS_ORDER = ['crit', 'warn', 'unknown', 'ok'];

/** 날짜별 실패 — 14일까지는 막대 카드, 그보다 길면 칸(숫자가 값 · 색은 보조). 확정 전 날은 점선 '적재 전'. */
function DayBars({ days }) {
  const maxF = Math.max(1, ...days.map((d) => d.f || 0));
  if (days.length <= 14) {
    return (
      <div className="prr-days">
        {days.map((d) => (
          <div key={d.day} className={`prr-day${d.k ? '' : ' pre'}`}>
            <div className="prr-card-h"><b>{d.label}</b><span className="prr-grow" /><b className="prr-mono">{d.k ? numText(d.f) : '—'}</b></div>
            <div className="prr-plot" aria-hidden="true">{d.k ? <i style={{ height: `${Math.round(((d.f || 0) / maxF) * 100)}%` }} /> : null}</div>
            <div className="prr-muted">{d.k ? `경고 ${numText(d.w)} · 끝남 ${numText(d.e)}${d.u ? ` · 확인 불가 ${numText(d.u)}` : ''}` : '적재 전 · 확정 전'}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="prr-daycells" role="list" aria-label="날짜별 실패한 VM 수">
      {days.map((d) => (
        <span key={d.day} role="listitem" className={`prr-dc${d.k ? (d.f > 0 ? (d.f / maxF > 0.5 ? ' hot' : ' f') : '') : ' pre'}`}
          title={d.k ? `${d.label} 실패 ${numText(d.f)} · 경고 ${numText(d.w)} · 끝남 ${numText(d.e)}${d.u ? ` · 확인 불가 ${numText(d.u)}` : ''}` : `${d.label} 적재 전 · 확정 전`}>
          <small>{d.label.slice(3, 5)}</small>{d.k ? numText(d.f) : '·'}{d.k && d.u ? <small>?</small> : null}
        </span>
      ))}
    </div>
  );
}

/** 되풀이 실패 줄의 날마다 결과(기호 + 글자 제목 — 색만으로 구분하지 않는다). */
function Strip({ strip, days }) {
  return (
    <span className="prr-strip">
      {strip.map((k, i) => {
        const lab = `${days[i]?.label || ''} ${BK_STRIP_LABEL[k] || BK_STRIP_LABEL.unknown}`;
        return <span key={i} className={`prr-sc ${k}`} title={lab} aria-label={lab}>{BK_STRIP[k] || '?'}</span>;
      })}
    </span>
  );
}

export default function BackupSection({ bk, items, corpName, no }) {
  const [allFails, setAllFails] = useState(false);
  const head = (sub) => <h3 className="prr-h" id="prr-backup">{no}. 백업 성공 · 실패 현황 <span className="prr-muted">{sub}</span></h3>;
  if (!bk) return null;
  if (bk.off || bk.error || !bk.summary) {
    return (
      <>
        {head('VM 단위 · 저장된 결과만 읽습니다')}
        <div className={`prr-banner${bk.error ? ' amber' : ''}`}>{bk.reason || '백업 적재를 읽지 못했습니다.'}</div>
      </>
    );
  }
  const s = bk.summary;
  const t = s.total;
  const cov = s.coverage || { sealed: 0, days: 0 };
  const multi = (s.days || []).length > 1;
  const products = bk.products || [];
  const itemOf = (p) => (items || []).find((x) => x.key === BK_ITEM_KEY[p]) || null;
  const rows = [...(bk.corpRows || [])].sort((a, b) => ((b.kd > 0 ? b.f : -1) - (a.kd > 0 ? a.f : -1)) || (b.unknownDays - a.unknownDays) || String(corpName(a.vc)).localeCompare(String(corpName(b.vc)), 'ko'));
  const failCorps = rows.filter((c) => c.kd > 0 && c.f > 0).length;
  const unknownNames = rows.filter((c) => c.unknownDays > 0).slice(0, 3).map((c) => corpName(c.vc));
  const firstLabel = bk.firstDay != null ? (bk.days || []).find((d) => d.day === bk.firstDay)?.label : null;
  const fails = bk.fails || [];
  const failsTotal = bk.failsTotal ?? fails.length;
  const repeat = bk.repeat || [];
  const hasStrip = repeat.some((x) => Array.isArray(x.strip));
  const toolOf = (p) => itemOf(p)?.tool || null;
  const periodSub = multi
    ? `${s.days[0]?.label} ~ ${s.days[s.days.length - 1]?.label} · 하루에 VM 하나당 한 건(그날 마지막 결과) · ${coverageText(cov)}`
    : `${s.days[0]?.label || ''} 하루 동안 끝난 백업 · VM 단위(하루에 여러 번 돌았으면 그 VM 의 마지막 결과) · 저장된 결과만 읽습니다`;
  return (
    <>
      {head(periodSub)}
      {bk.scoped && <div className="prr-muted">내 범위(법인) 분량만 담았습니다.</div>}
      {cov.sealed < cov.days && (
        <div className="prr-banner">
          {coverageText(cov)} — 나머지 {numText(cov.days - cov.sealed)}일은 적재 전이거나 아직 확정하지 않은 날이라 성공으로도 실패로도 세지 않았습니다
          {firstLabel ? `(적재 시작 ${firstLabel})` : ''}. 지난 날을 소급해 채우지 않습니다.
        </div>
      )}
      <div className="prr-tiles">
        <div className="prr-tile"><span className="prr-lab">끝난 백업</span><b>{bkNum(t, t.e)}</b><span className="prr-muted">{multi ? `확정 ${numText(cov.sealed)}일 합` : `대상 ${bkNum(t, t.t)}(VM · 잡)`}</span></div>
        <div className="prr-tile"><span className="prr-lab">성공</span><b>{bkNum(t, t.ok)}</b><span className="prr-muted">성공률 {pctText(t.rate)}{s.prev?.known ? ` · 앞 기간 ${pctText(s.prev.rate)}` : ''}</span></div>
        <div className="prr-tile"><span className="prr-lab">경고</span><b>{bkNum(t, t.w)}</b><span className="prr-muted">복원 지점은 생김 — 성공률에 포함</span></div>
        <div className="prr-tile"><span className="prr-lab">실패</span><b>{bkNum(t, t.f)}</b><span className="prr-muted">{s.prev?.known ? `앞 기간 ${numText(s.prev.f)} · ${deltaText(t.f, s.prev.f)}` : '앞 기간 적재 없음'}{t.kd > 0 && failCorps ? ` · 법인 ${numText(failCorps)}곳` : ''}</span></div>
        <div className="prr-tile"><span className="prr-lab">실행 없음</span><b>{bkNum(t, t.n)}</b><span className="prr-muted">그날 끝난 실행이 없음 — RPO 로 판정</span></div>
        {multi
          ? <div className="prr-tile"><span className="prr-lab">실패한 VM</span><b>{numText(s.fails)}</b><span className="prr-muted">2일 이상 되풀이 {numText(s.repeatVms)}대</span></div>
          : <div className="prr-tile"><span className="prr-lab">지금 실패 상태</span><b>{numText(s.failNow)}</b><span className="prr-muted">보고서를 만든 시각의 마지막 결과</span></div>}
        <div className="prr-tile"><span className="prr-lab">확인 불가(법인 · 백업 · 날)</span><b>{numText(t.ud)}</b><span className="prr-muted">{s.corpsWithUnknown ? `${unknownNames.join(' · ')}${s.corpsWithUnknown > unknownNames.length ? ` 외 ${numText(s.corpsWithUnknown - unknownNames.length)}곳` : ''} — 성공에도 실패에도 넣지 않음` : '없음'}</span></div>
      </div>

      <div className="prr-axes">
        {products.map((p) => {
          const x = s.products?.[p] || {};
          const it = itemOf(p);
          return (
            <div key={p} className="prr-axis">
              <div className="prr-card-h"><b>{BK_PRODUCT_LABEL[p] || p}</b>{!multi && <span className="prr-muted">대상 {bkNum(x, x.t)}{p === 'clone' ? ' 잡' : ' VM'}</span>}<span className="prr-grow" /><b className="prr-mono">{pctText(x.rate)}</b></div>
              <div className="prr-muted">성공 {bkNum(x, x.ok)} · 경고 {p === 'clone' ? '—(구분 없음)' : bkNum(x, x.w)} · 실패 {bkNum(x, x.f)} · 실행 없음 {bkNum(x, x.n)} · 확인 불가 {numText(x.ud)}</div>
              <div className="prr-note">판정 {it ? <StatusChip s={it.status} /> : '—'} {it ? (it.basis || it.value || (it.unknownReason ? `확인 불가: ${it.unknownReason}` : '')) : '이 주기에 실리지 않는 항목입니다'}</div>
            </div>
          );
        })}
      </div>

      {multi && (
        <>
          <div className="prr-bar"><b className="prr-lab">날짜별 실패</b><span className="prr-muted">숫자 = 그날 실패한 VM 수 · 아래 줄은 경고 · 끝난 백업</span></div>
          <DayBars days={s.days} />
        </>
      )}

      <div className="prr-bar"><b className="prr-lab">법인별</b><span className="prr-muted">실패 많은 순 · 제목을 누르면 정렬 · 판정 칸은 서비스 축의 백업 항목 것</span></div>
      <div className="prr-tablewrap">
        <STable minWidth={multi ? 1180 : 1040}>
          <thead><tr>
            <th>법인</th><th style={{ textAlign: 'right' }}>끝난 백업</th><th style={{ textAlign: 'right' }}>성공</th><th style={{ textAlign: 'right' }}>경고</th><th style={{ textAlign: 'right' }}>실패</th>
            <th style={{ textAlign: 'right' }}>성공률</th><th style={{ textAlign: 'right' }}>앞 기간 실패</th><th style={{ textAlign: 'right' }}>실행 없음</th><th style={{ textAlign: 'right' }}>확인 불가</th>
            {multi && <th style={{ textAlign: 'right' }}>실패한 날</th>}{multi && <th style={{ textAlign: 'right' }}>되풀이 VM</th>}
            <th style={{ textAlign: 'right' }}>지금 실패</th><th>판정</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => {
              const st = backupCorpStatus(items, c.vc, products);
              const k = c.kd > 0;
              return (
                <tr key={c.vc}>
                  <td>{corpName(c.vc)}</td>
                  <td className="prr-num" data-sort={k ? c.e : null}>{bkNum(c, c.e)}</td><td className="prr-num" data-sort={k ? c.ok : null}>{bkNum(c, c.ok)}</td>
                  <td className="prr-num" data-sort={k ? c.w : null}>{bkNum(c, c.w)}</td><td className="prr-num" data-sort={k ? c.f : null}>{bkNum(c, c.f)}</td>
                  <td className="prr-num" data-sort={c.rate}>{pctText(c.rate)}</td><td className="prr-num" data-sort={s.prev?.known ? c.prev?.f : null}>{s.prev?.known ? numText(c.prev?.f) : '—'}</td>
                  <td className="prr-num" data-sort={k ? c.n : null}>{bkNum(c, c.n)}</td><td className="prr-num">{numText(c.unknownDays)}</td>
                  {multi && <td className="prr-num">{numText(c.failDays)}</td>}{multi && <td className="prr-num">{numText(c.repeatVms)}</td>}
                  <td className="prr-num">{numText(c.failNow)}</td>
                  <td data-sort={st ? STATUS_ORDER.indexOf(st) : null}>{st ? <StatusChip s={st} /> : '—'}</td>
                </tr>
              );
            })}
            {rows.length > 0 && (
              <tr data-pin="1" className="prr-sum">
                <td>합계</td><td className="prr-num">{bkNum(t, t.e)}</td><td className="prr-num">{bkNum(t, t.ok)}</td><td className="prr-num">{bkNum(t, t.w)}</td><td className="prr-num">{bkNum(t, t.f)}</td>
                <td className="prr-num">{pctText(t.rate)}</td><td className="prr-num">{s.prev?.known ? numText(s.prev.f) : '—'}</td><td className="prr-num">{bkNum(t, t.n)}</td><td className="prr-num">{numText(t.ud)}</td>
                {multi && <td className="prr-num">—</td>}{multi && <td className="prr-num">{numText(s.repeatVms)}</td>}
                <td className="prr-num">{numText(s.failNow)}</td><td>—</td>
              </tr>
            )}
          </tbody>
        </STable>
      </div>
      {!rows.length && <div className="prr-muted">적재된 법인이 없습니다{cov.sealed ? '' : ' — 아직 확정된 날이 없습니다'}.</div>}

      <div className="prr-bar">
        <b className="prr-lab">실패한 백업 {numText(failsTotal)}{multi ? '대' : '건'}</b>
        <span className="prr-muted">{multi ? '백업 · VM 하나에 한 줄 · 실패한 날이 많은 순' : '연속 실패가 긴 순'} · 사유는 저장된 첫 오류 줄 · 화면은 {FAIL_ROWS}건까지 보이고 ‘전부 보기’ 로 펼칩니다</span>
      </div>
      {fails.length ? (
        <div className="prr-tablewrap">
          <STable minWidth={multi ? 1060 : 980} limit={allFails ? 0 : FAIL_ROWS}>
            <thead><tr>
              <th>법인</th><th>백업</th><th>VM</th>{multi && <th style={{ textAlign: 'right' }}>실패한 날</th>}<th>마지막 실패</th><th style={{ textAlign: 'right' }}>연속 실패</th><th>마지막 성공</th><th>사유(첫 오류 줄)</th><th data-nosort="1">바로가기</th>
            </tr></thead>
            <tbody>{fails.map((x) => {
              const tool = toolOf(x.product);
              return (
                <tr key={`${x.product}|${x.vm}`}>
                  <td>{corpName(x.vc)}</td><td>{BK_PRODUCT_LABEL[x.product] || x.product}</td><td>{x.name || x.vm}</td>
                  {multi && <td className="prr-num" data-sort={x.failDays}>{numText(x.failDays)}</td>}
                  <td className="prr-mono" data-sort={x.endedAt}>{kstText(x.endedAt)}</td>
                  <td className="prr-num" data-sort={x.streak}>{x.streak == null ? '—' : `${numText(x.streak)}회`}</td>
                  <td className="prr-mono" data-sort={x.lastOkAt}>{kstText(x.lastOkAt)}</td>
                  <td className="prr-wrap">{x.reason || '—'}</td>
                  <td>{tool ? <a href={`#/tools/${tool}`}>{BK_PRODUCT_LABEL[x.product] || '열기'}</a> : '—'}</td>
                </tr>
              );
            })}</tbody>
          </STable>
        </div>
      ) : <div className="prr-muted">{t.kd > 0 ? '기간 안에 실패한 백업이 없습니다(확인 불가 법인-날은 빼고 센 것입니다).' : '확정된 날이 없어 실패 목록이 비어 있습니다(실패가 없다는 뜻이 아닙니다).'}</div>}
      {(fails.length > FAIL_ROWS || failsTotal > fails.length) && (
        <div className="prr-bar">
          {fails.length > FAIL_ROWS && <button type="button" className="prr-rowbtn" onClick={() => setAllFails((v) => !v)} aria-expanded={allFails}>{allFails ? `처음 ${FAIL_ROWS}건만 보기` : `전부 보기(${numText(fails.length)}건)`}</button>}
          {failsTotal > fails.length && <span className="prr-muted">보고서에는 상위 {numText(fails.length)}건만 실었습니다(전체 {numText(failsTotal)}) — XLSX 도 같은 {numText(fails.length)}건입니다.</span>}
        </div>
      )}

      {multi && repeat.length > 0 && (
        <>
          <div className="prr-bar"><b className="prr-lab">되풀이되는 실패 {numText(bk.repeatTotal ?? repeat.length)}대</b><span className="prr-muted">기간 안 2일 이상 실패한 VM{hasStrip ? ' · 칸은 날마다 그날 마지막 결과' : ''}</span></div>
          <div className="prr-tablewrap">
            <STable minWidth={hasStrip ? 1040 : 860}>
              <thead><tr><th>VM</th><th>법인</th><th>백업</th><th style={{ textAlign: 'right' }}>실패한 날</th>{hasStrip && <th data-nosort="1">날마다</th>}<th>마지막 성공</th><th>마지막 사유</th></tr></thead>
              <tbody>{repeat.map((x) => (
                <tr key={`${x.product}|${x.vm}`}>
                  <td>{x.name || x.vm}</td><td>{corpName(x.vc)}</td><td>{BK_PRODUCT_LABEL[x.product] || x.product}</td>
                  <td className="prr-num" data-sort={x.failDays}>{numText(x.failDays)} / {numText(s.days.length)}</td>
                  {hasStrip && <td>{Array.isArray(x.strip) ? <Strip strip={x.strip} days={s.days} /> : '—'}</td>}
                  <td className="prr-mono" data-sort={x.lastOkAt}>{kstText(x.lastOkAt)}</td><td className="prr-wrap">{x.reason || '—'}</td>
                </tr>
              ))}</tbody>
            </STable>
          </div>
          {hasStrip && <div className="prr-note">✓ 성공(경고 포함) · × 실패 · – 실행 없음 · ? 확인 불가 · · 적재 전</div>}
          {(bk.repeatTotal ?? 0) > repeat.length && <div className="prr-muted">상위 {numText(repeat.length)}대만 보입니다(전체 {numText(bk.repeatTotal)}대).</div>}
        </>
      )}

      <div className="prr-note">
        읽는 법 — 경고는 복원 지점이 생긴 실행이라 성공률에 넣고, 취소는 실패에 넣습니다(Backup 현황 Summary 와 같은 규칙). ‘실행 없음’ 은 그날 대상인데 끝난 실행이 없는 VM 으로,
        주 1회 잡처럼 정상인 경우가 많아 여기서 판정하지 않고 RPO 가 판정합니다. ‘확인 불가’ 는 그 법인 결과를 읽지 못한 날로 성공에도 실패에도 넣지 않습니다.
        이 절은 새 판정을 만들지 않습니다 — 판정 칸은 서비스 축의 백업 항목 것입니다.{bk.asOf ? ` 마지막 관측 ${kstText(bk.asOf, { withYear: true })}.` : ''}
      </div>
    </>
  );
}
