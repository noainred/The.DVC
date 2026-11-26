/**
 * 물리서버 상세 드로어의 점검 구역(v3.45 · 시안 docs/design/bm-feature-proposals ① ② ③) — 보증 · 계약 / 펌웨어 기준선 / BIOS 설정 편차.
 * 응답 상태({ d, err })를 받아 **그리기만** 한다(판정은 서버 bmcheck · 글자는 checkText.js). 드로어가 열릴 때 1건 조회(BmDrawer useOnce).
 *  · 못 읽은 것 · 판정하지 않은 것은 이유를 쓰고 표를 그리지 않는다(빈 표 · 0 으로 보이지 않게).
 *  · 기준 지정(전 법인 공통)은 서버가 canBaseline 을 준 계정(조회 ∧ 쓰기 전체 범위 관리자)에게만 단추를 그린다 — 집행은 관리 라우트.
 */
import React from 'react';
import { STable } from '../../../components/STable.jsx';
import { warrantyView, fwView, biosView } from './checkText.js';

const Why = ({ text }) => (text ? <div className="muted bmd-note">{text}</div> : null);
const Head = ({ title, badge, sub }) => (
  <div className="sh">
    <h3>{title}{badge ? <span className={`badge ${badge.color}`} style={{ marginLeft: 8 }}>{badge.label}</span> : null}</h3>
    {sub ? <span className="muted bmd-sh-sub">{sub}</span> : null}
  </div>
);

/**
 * 보증 · 계약 구역(서비스 태그가 있는 모든 행 — ESXi 호스트도 같은 물리 박스다). 읽는 중 · 조회 실패도 이 구역이 말한다(아래 구역은 그동안 그리지 않는다).
 * @param chk   { d, err } — /tools/bm-folders/check(읽는 중이면 d null · err '')
 * @param admin 관리자 판본(계약 번호 줄을 그릴지 — 값은 서버가 관리자 판본에만 싣는다)
 */
export function WarrantySection({ chk, admin = false }) {
  const d = chk?.d || null;
  if (chk?.err) {
    return (
      <section className="vmh-sec" aria-label="보증 · 계약">
        <div className="sh"><h3>보증 · 펌웨어 · BIOS 점검</h3></div>
        <div className="bmd-note" style={{ color: 'var(--red)' }}>{chk.err}</div>
      </section>
    );
  }
  if (!d) {
    return (
      <section className="vmh-sec" aria-label="보증 · 계약">
        <div className="sh"><h3>보증 · 계약</h3><span className="muted">자산 원장(CSV)</span></div>
        <div className="muted bmd-note">읽는 중…</div>
      </section>
    );
  }
  const w = warrantyView(d.warranty, { soonDays: d.soonDays, admin, unreadable: !!d.assetsUnreadable });
  return (
    <section className="vmh-sec" aria-label="보증 · 계약">
      <Head title="보증 · 계약" badge={w.badge} sub="자산 원장(CSV)" />
      {w.kv.length ? (
        <div className="vmh-kv">
          {w.kv.map((x) => (
            <div key={x.label} className={x.full ? 'full' : undefined}>
              <span>{x.label}</span>
              <b style={x.dim ? { color: 'var(--text-dim)' } : undefined}>{x.value}{x.sub ? <span className="bmd-kvnote">{x.sub}</span> : null}</b>
            </div>
          ))}
        </div>
      ) : null}
      <Why text={w.note} />
    </section>
  );
}

/**
 * 펌웨어 기준선 · BIOS 설정 편차 구역(베어메탈만). 응답을 받기 전 · 조회 실패에는 그리지 않는다(위 보증 구역이 말한다).
 * @param r    목록 행(kind)
 * @param onBaseline (row, version) => void — 기준 지정('' = 해제). 없으면 단추를 그리지 않는다
 * @param busy  기준 저장 중 · baseNote 기준 저장 결과({ ok, text })
 */
export function FwBiosSections({ r, chk, onBaseline = null, busy = false, baseNote = null }) {
  const d = chk?.d || null;
  if (r.kind !== 'bm' || !d || chk?.err) return null;
  const fw = fwView(d.fw, { noHw: !!d.noHw, baselineUnreadable: !!d.baselineUnreadable });
  const bios = biosView(d.bios, { noHw: !!d.noHw, path: d.path, model: d.model });
  const canBase = !!d.canBaseline && typeof onBaseline === 'function';
  return (
    <>
      {fw ? (
        <section className="vmh-sec" aria-label="펌웨어 기준선">
          <Head title="펌웨어 기준선" badge={fw.badge} sub={fw.head} />
          {fw.rows.length ? (
            <STable className="table bmd-ct" minWidth={320}>
              {/* 세 열 — 400px 드로어에서도 상태가 가로 스크롤 밖으로 밀리지 않게(기준 · 근거는 버전 칸의 아래 줄 · 기준 지정 단추는 상태 칸 아래) */}
              <thead><tr><th>구성요소</th><th>설치 버전 · 기준</th><th>상태</th></tr></thead>
              <tbody>
                {fw.rows.map((x) => (
                  <tr key={x.key}>
                    <td data-sort={x.label}><span className="bmd-ct-nm" title={x.label}>{x.label}</span><span className="muted bmd-ct-sub">{x.type}</span></td>
                    <td data-sort={x.installed}><span className="mono">{x.installed}</span><span className="muted bmd-ct-sub">{x.baseSub}</span></td>
                    <td data-sort={x.stateText}>
                      <span className={`badge ${x.badge}`}>{x.stateText}</span>
                      {canBase ? (
                        x.basisKind === 'admin'
                          ? <button type="button" className="logout-btn bmd-ct-btn" disabled={busy} onClick={() => onBaseline(x.raw, '')} title="지정을 지우고 같은 법인 · 같은 모델의 다수 버전으로 다시 대조합니다">지정 해제</button>
                          : x.raw.installed && !x.raw.mixed
                            ? <button type="button" className="logout-btn bmd-ct-btn" disabled={busy} onClick={() => onBaseline(x.raw, x.raw.installed)} title={`이 모델(${d.model})의 이 구성요소 기준을 ${x.raw.installed} 로 지정합니다 — 전 법인의 같은 모델에 적용됩니다`}>기준으로 지정</button>
                            : null
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </STable>
          ) : null}
          {baseNote ? <div className={`bmd-note${baseNote.ok ? '' : ' bad'}`} role={baseNote.ok ? 'status' : 'alert'} style={baseNote.ok ? undefined : { color: 'var(--red)' }}>{baseNote.text}</div> : null}
          <Why text={fw.why} />
          <Why text={fw.note} />
        </section>
      ) : null}

      {bios ? (
        <section className="vmh-sec" aria-label="BIOS 설정 편차">
          <Head title="BIOS 설정 편차" badge={bios.badge} sub={bios.head} />
          {bios.rows.length ? (
            <STable className="table bmd-ct" minWidth={320}>
              <thead><tr><th>설정</th><th>이 서버 · 다수 값</th><th>비교</th></tr></thead>
              <tbody>
                {bios.rows.map((x) => (
                  <tr key={x.k}>
                    <td data-sort={x.label}><span className="bmd-ct-nm" title={x.k}>{x.label}</span></td>
                    <td data-sort={x.value}><span>{x.value}</span><span className="muted bmd-ct-sub">{x.majorText}</span></td>
                    <td data-sort={x.stateText}><span className={`badge ${x.badge}`}>{x.stateText}</span></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          ) : null}
          <Why text={bios.why} />
          <Why text={bios.note} />
        </section>
      ) : null}
    </>
  );
}

