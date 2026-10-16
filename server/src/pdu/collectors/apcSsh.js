/**
 * pdu/collectors/apcSsh.js — APC Rack PDU 2G(rpdu2g) SSH 수집기.
 *
 * 왜 SSH 인가(정직한 근거): 이 저장소에는 SNMP 클라이언트가 없고(에어갭 오프라인 번들에 새
 * 의존성을 넣어야 함), 반대로 SSH 수집기 패턴은 이미 5종(isilonSsh·unitySsh·powerstoreSsh·
 * vplexSsh·xtremioSsh)이 검증돼 있다. rpdu2g CLI 출력은 `E000` + '값 단위' 한 줄이라 파싱이
 * 단순하고, 실장비에서 동작을 확인했다. PDU 가 수백 대로 늘면 SNMP 재검토가 맞다.
 *
 * ★ 자동 탐지: 센서/PDU 수량을 설정으로 받지 않고 **장비에 물어본다**.
 *   인덱스를 1부터 올려가며 조회하다 `E1xx`(Parameter Error)가 나오면 멈춘다.
 *   근거(실측): 센서 1개 장비에서 `tempReading 2:C` → `E102 Parameter Error`.
 *   그래서 '센서 1개인 PDU'와 '4대 데이지체인'을 같은 코드로 다룬다.
 *
 * 타임아웃: 장비당 마감시간을 **세션을 실제로 끊어서** 지킨다(v2.417 규약) — Promise.race 로
 * 결과만 포기하면 SSH 세션이 남은 명령을 계속 돌려 동시성 상한이 실효를 잃는다.
 */

import { withSsh, execTimeoutMs } from '../../proxy/sshExec.js';
import { reqTimeoutMs } from '../../util/envTimeout.js';
import { emptySnapshot, MAX_PDU_UNITS, MAX_SENSORS, MAX_BANKS, MAX_PHASES } from '../types.js';
import { cmd, parseReading, parseAbout, toCelsius, toWatts } from '../parse.js';

/*
 * ── 세션 예산(v2.742 감사 DEV-05 — v2.741 DEV-02 fosSsh·isilonSsh 의 형제 누락, v2.528 Unity 와 같은 유형) ───────────────
 * 이 수집은 명령을 최대 약 59회 순차로 보낸다(about 1 + 유닛 4×4 + 뱅크 12 + 상 6 + 센서 8×3). 각 명령은 시한 인자가 없으면
 * exec 기본 시한(`SSH_EXEC_TIMEOUT_MS`, 기본 60초)을 쓰므로 **응답 없는 명령 두 개(120초)면 폴러의 장비 시한(90초)을 넘는다**.
 * 넘는 순간 `withDeadline` 이 세션을 끊고 이 함수는 부분 결과 없이 던져, 폴러의 catch 가 **이미 읽은 전력·센서까지**
 * 빈 실패 스냅샷으로 덮었다. 그래서 명령마다 남은 예산 안에서만 기다리고(`min(명령 시한, 남은 예산)`), 남은 시간이
 * `PDU_MIN_SLICE_MS` 아래면 그 뒤 탐지를 **시작하지 않고** 사유를 남긴다(여기까지 읽은 값은 그대로 쓴다).
 *  · 예산은 장비 시한보다 **반드시 작아야 한다**(같거나 크면 이 가드가 발동하기 전에 폴러가 먼저 던진다) —
 *    그래서 장비 시한을 이 파일이 소유하고(`PDU_DEVICE_TIMEOUT_MS` — 폴러가 import 한다) `min(예산, 장비 시한 − 여유)` 로 묶는다.
 *  · `test/audit2742k.test.js` 가 기본값 산수(예산 < 장비 시한)를 깨끗한 환경의 자식 프로세스로 고정한다.
 */
/** 빈 값·0·숫자 아님 → null(기본값) — v2.590 이전 폴러 식 `Math.max(10_000, Number(env) || 90_000)` 과 같은 결과. */
const envMsOrNull = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
/** 폴러의 장비당 시한(기본 90초, 하한 10초) — 단일 소스(`pdu/poller.js` 가 이 값을 쓴다). */
export const PDU_DEVICE_TIMEOUT_MS = Math.max(10_000, envMsOrNull(process.env.PDU_DEVICE_TIMEOUT_MS) ?? 90_000);
/** 장비 시한과 예산 사이 여유 — 마지막 명령의 채널 열기 왕복·세션 종료가 이 안에 들어간다(시한이 짧으면 비율로 줄인다). */
export const PDU_DEADLINE_MARGIN_MS = Math.min(15_000, Math.floor(PDU_DEVICE_TIMEOUT_MS / 6));
/** 남은 예산이 이보다 적으면 새 명령을 시작하지 않는다(cliSsh·fosSsh·isilonSsh 와 같은 규칙 — 명령 시한이 짧은 현장에서도 비율을 지킨다). */
export const PDU_MIN_SLICE_MS = Math.min(5_000, Math.max(250, Math.floor(execTimeoutMs() / 4)));
/** 세션 예산(기본 75초 · env `PDU_SESSION_BUDGET_MS`) — 언제나 `장비 시한 − 여유` 이하다. `?? 75_000` 은 문서 생성기(env-doc)가 기본값을 읽게 하려는 것이다(fosSsh 와 같은 꼴). */
export const PDU_SESSION_BUDGET_MS = Math.min(PDU_DEVICE_TIMEOUT_MS - PDU_DEADLINE_MARGIN_MS,
  Math.max(PDU_MIN_SLICE_MS * 2, reqTimeoutMs(process.env.PDU_SESSION_BUDGET_MS ?? 75_000, 75_000, { min: 5_000, max: 1_800_000 })));
/** 예산으로 시작하지 않은 명령의 사유 — Unity(cliSsh)·SAN(fosSsh)·Isilon 과 같은 문구(같은 뜻을 두 갈래로 말하지 않는다). */
export const PDU_BUDGET_SKIP_REASON = '수집 시간 예산 초과로 이번 주기에는 실행하지 않았습니다(다음 주기에 시도).';

/** APC CLI 응답 코드가 '해당 없음(E1xx)' 인가 — 이것만 '이 인덱스부터 없다' 로 읽는다(v2.594·v2.599). */
export function isAbsentCode(code) {
  return /^E1/i.test(String(code || ''));
}

/**
 * 한 대 수집.
 * @param {object} device { id,name,host,username,password,sshPort,datacenterId }
 * @param {{ signal?:AbortSignal, onTrace?:(m:string)=>void, budgetMs?:number }} opts budgetMs — 세션 예산(기본
 *   `PDU_SESSION_BUDGET_MS`). 바깥 시한이 장비 시한보다 짧은 호출부(연결 테스트 60초)는 그보다 작은 값을 넘겨야 같은 보호를 받는다.
 * @returns {Promise<object>} 정규화 스냅샷(types.js emptySnapshot 형태)
 */
export async function collect(device, { signal = undefined, onTrace = null, budgetMs = PDU_SESSION_BUDGET_MS } = {}) {
  const snap = emptySnapshot(device);
  // 예산 시계는 **접속 전**에 시작한다 — 장비 시한도 핸드셰이크를 포함해 세기 때문이다(cliSsh·isilonSsh 와 같다).
  const budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : PDU_SESSION_BUDGET_MS;
  const t0 = Date.now();
  const leftMs = () => budget - (Date.now() - t0);
  const skipped = [];          // 예산으로 시작하지 않은 명령(앞 두 낱말) — 조용히 빼지 않는다
  let budgetNoted = false;     // 예산 사유 문구는 한 번만(같은 말이 노트를 덮지 않게) — 처음 건너뛴 명령을 밝힌다
  const creds = {
    host: device.host,
    port: Number(device.sshPort) || 22,
    username: device.username,
    password: device.password,
    signal,                               // 마감시간이 오면 세션을 실제로 끊는다
    trace: onTrace || undefined,
  };

  await withSsh(creds, async ({ exec: rawExec }) => {
    // v2.742(DEV-05): 명령 시한을 남은 예산으로 줄이고, 남은 시간이 PDU_MIN_SLICE_MS 아래면 시작하지 않고 던진다(code SESSION_BUDGET).
    const exec = (command) => {
      const left = leftMs();
      if (left < PDU_MIN_SLICE_MS) {
        const head = String(command).split(/\s+/).slice(0, 2).join(' ');
        skipped.push(head);
        if (!budgetNoted) {
          budgetNoted = true;
          snap.notes.push(`수집 시간 예산(${Math.round(budget / 1000)}초)이 다 되어 ‘${head}’ 부터 남은 명령을 시작하지 않았습니다(다음 주기에 시도) — 여기까지 읽은 값은 그대로 씁니다.`);
        }
        const e = new Error(PDU_BUDGET_SKIP_REASON); e.code = 'SESSION_BUDGET';
        return Promise.reject(e);
      }
      return rawExec(command, Math.min(execTimeoutMs(), left));
    };
    // 값 한 건 읽기. E1xx(해당 없음)는 오류로 올리지 않고 null 을 돌려준다.
    const read = async (command) => {
      try {
        const r = await exec(command);
        return parseReading(`${r.stdout || ''}\n${r.stderr || ''}`);
      } catch (e) {
        // 세션 자체가 끊긴 경우만 위로 던진다(마감/네트워크). 명령 오류는 null.
        if (signal?.aborted) throw e;
        // 예산으로 시작하지 않은 것은 '명령 실패' 와 조치가 다르다 — 표지를 남긴다(아래 탐지 루프가 사유를 따로 말한다).
        return { value: null, unit: '', code: '', ok: false, ...(e?.code === 'SESSION_BUDGET' ? { budget: true } : {}) };
      }
    };

    // --- 장비 식별(실패해도 수집은 계속) ---
    try {
      const ab = await exec(cmd.about());
      Object.assign(snap, parseAbout(ab.stdout || ''));
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e?.code !== 'SESSION_BUDGET') snap.notes.push('about 조회 실패 — 모델/시리얼 미확인');   // 예산은 위 문구가 말한다
    }

    // --- PDU 본체(데이지체인) 자동 탐지 ---
    for (let i = 1; i <= MAX_PDU_UNITS; i++) {
      const power = await read(cmd.dev(i, 'power'));
      if (!power.ok) {
        // v2.742(DEV-05): 예산으로 시작하지 않았으면 '유닛이 없다' 가 아니라 '확인하지 않았다' 다 — 유닛 목록이 부분임을 밝힌다.
        if (power.budget) {
          snap.unitsIncomplete = true;
          if (i > 1) snap.notes.push(`PDU 유닛 ${i} 부터는 확인하지 않았습니다 — 합계 전력은 유닛 1~${i - 1} 기준(부분 합)입니다.`);
          break;
        }
        // v2.594(감사 DATA2594-05): E1xx 만 '이 인덱스부터 없음' 이다. 그 밖의 실패(명령 실패·형식 미인식)까지 같은
        //   break 로 받으면 뒤 유닛이 **말없이** 빠져 합계 전력이 부분 합이 됐다. 멈추되 그 사실을 남긴다.
        if (!/^E1/i.test(String(power.code || '')) && i > 1) {
          snap.unitsIncomplete = true;
          snap.notes.push(`PDU 유닛 ${i} 전력을 읽지 못해 그 뒤 유닛 탐지를 멈췄습니다 — 합계 전력은 유닛 1~${i - 1} 기준(부분 합)입니다.`);
        }
        break;
      }
      const [energy, appower, pf] = [
        await read(cmd.dev(i, 'energy')),
        await read(cmd.dev(i, 'appower')),
        await read(cmd.dev(i, 'pf')),
      ];
      const unit = {
        index: i,
        powerW: toWatts(power.value, power.unit),
        energyKwh: energy.value,                  // 누적 kWh — 정규화하지 않는다(카운터)
        appPowerW: toWatts(appower.value, appower.unit),
        pf: pf.value,
        banks: [],
        phases: [],
      };

      // v2.597(감사 C2597-01 — 코드 확인): bkReading/phReading 명령에는 **유닛 축이 없다** — 유닛 2 이상에서 같은 명령을
      //   다시 보내면 유닛 1 값이 복제돼 unit=i 행으로 적재됐다(오류 없이 틀린 값). 유닛 지정 문법을 실장비로 확인하기
      //   전에는 유닛 1 에서만 읽고, 뒤 유닛은 '뱅크·상 미수집' 을 밝힌다.
      if (i > 1) {
        if (i === 2) snap.notes.push('데이지체인 유닛 2 이상의 뱅크·상 값은 수집하지 않습니다(명령에 유닛 지정이 없어 유닛 1 값이 복제됩니다).');
        unit.banksNotCollected = true;
        snap.units.push(unit);
        continue;
      }
      // 뱅크별 부하(A) — 사용자 요구 '뱅크별 소요 전력'. 있는 만큼만.
      // v2.599(감사 C2599-04): 유닛 루프(v2.594 DATA2594-05)와 같은 규칙 — E1xx(해당 없음)만 '이 인덱스부터 없음' 이다.
      //   명령 실패·형식 미인식에서 말없이 멈추면 뒤 뱅크·상이 **없는 것처럼** 빠진다. 멈추되 그 사실을 남긴다.
      for (let b = 1; b <= MAX_BANKS; b++) {
        const cur = await read(cmd.bank(b, 'current'));
        if (!cur.ok) {
          if (cur.budget) { unit.banksIncomplete = true; break; }   // 사유는 예산 문구가 말한다
          if (!isAbsentCode(cur.code)) {
            unit.banksIncomplete = true;
            snap.notes.push(`뱅크 ${b} 전류를 읽지 못해(${cur.code || '명령 실패'}) 그 뒤 뱅크 탐지를 멈췄습니다 — 뱅크 목록은 ${b === 1 ? '비어 있지만 뱅크가 없다는 뜻이 아닙니다' : `뱅크 1~${b - 1} 까지입니다`}.`);
          }
          break;
        }
        unit.banks.push({ index: b, currentA: cur.value });
      }
      // 상(phase)별 전류/전압 — 3상 장비에서 유의미.
      for (let p = 1; p <= MAX_PHASES; p++) {
        const cur = await read(cmd.phase(p, 'current'));
        if (!cur.ok) {
          if (cur.budget) { unit.phasesIncomplete = true; break; }
          if (!isAbsentCode(cur.code)) {
            unit.phasesIncomplete = true;
            snap.notes.push(`상 ${p} 전류를 읽지 못해(${cur.code || '명령 실패'}) 그 뒤 상 탐지를 멈췄습니다 — 상 목록은 ${p === 1 ? '비어 있지만 상이 없다는 뜻이 아닙니다' : `상 1~${p - 1} 까지입니다`}.`);
          }
          break;
        }
        const volt = await read(cmd.phase(p, 'voltage'));
        unit.phases.push({ index: p, currentA: cur.value, voltageV: volt.value });
      }
      snap.units.push(unit);
    }
    // 예산으로 시작조차 못 했으면 '계정 권한/모델' 탓이 아니다(조치가 다르다) — 위 예산 문구가 사유를 말한다.
    if (!snap.units.length && !snap.unitsIncomplete) snap.notes.push('전력 값을 읽지 못했습니다(devReading) — 계정 권한/모델을 확인하세요.');

    // --- 환경 센서 자동 탐지 (온도/습도) ---
    for (let i = 1; i <= MAX_SENSORS; i++) {
      const t = await read(cmd.temp(i));
      const h = await read(cmd.hum(i));
      // 온도·습도 **둘 다** 없으면 그 인덱스에는 센서가 없다 → 탐지 종료.
      // v2.599(감사 C2599-04): 단 둘 다 E1xx 일 때만 '없음' 이다. 그 밖의 실패는 멈추되 부분 목록임을 밝힌다.
      if (!t.ok && !h.ok) {
        // v2.742(DEV-05): 예산으로 시작하지 않은 것은 '센서 없음' 이 아니다 — 부분 목록임을 밝힌다(아래 '미장착' 문구가 뜨지 않게).
        if (t.budget || h.budget) { snap.sensorsIncomplete = true; break; }
        if (!(isAbsentCode(t.code) && isAbsentCode(h.code))) {
          snap.sensorsIncomplete = true;
          snap.notes.push(`환경 센서 ${i} 를 읽지 못해(${t.code || h.code || '명령 실패'}) 그 뒤 센서 탐지를 멈췄습니다 — 센서 목록은 ${i === 1 ? '비어 있지만 센서가 없다는 뜻이 아닙니다' : `센서 1~${i - 1} 까지입니다`}.`);
        }
        break;
      }
      let name = '';
      try {
        const n = await exec(cmd.sensorName(i));
        // sensorName 은 값이 문자열이라 parseReading(숫자 전제)을 쓰지 않는다.
        const lines = String(n.stdout || '').split(/\r?\n/);
        const ci = lines.findIndex((l) => /^\s*E\d{3}\s*:/.test(l));
        if (ci >= 0 && /E000/.test(lines[ci])) name = (lines.slice(ci + 1).find((l) => l.trim() && !/^apc>/i.test(l)) || '').trim();
      } catch (e) { if (signal?.aborted) throw e; /* 이름은 선택 정보(예산으로 건너뛴 것도 이름만 빈다) */ }
      snap.sensors.push({
        index: i,
        name,
        tempC: toCelsius(t.value, t.unit),
        humidityPct: h.value,
      });
    }
    // 읽기 실패로 멈춘 경우 '미장착' 이라고 단정하지 않는다(위 노트가 사유를 말한다).
    if (!snap.sensors.length && !snap.sensorsIncomplete) snap.notes.push('환경 센서가 없습니다(AP9335T/TH 미장착) — 온도·습도는 수집되지 않습니다.');
  }, { signal });

  // v2.742(DEV-05): 예산으로 시작하지 않은 명령 — 개수와 예산을 싣는다(Unity·Isilon 의 cliSkipped 와 같은 뜻). 처음 건너뛴 명령은
  //   노트가 말한다. 수치만 싣는 이유: 중앙 PDU 수신(`central/pduEdge.js`)은 최상위 필드를 정제 없이 펼치므로 배열을 늘리지 않는다.
  if (skipped.length) {
    snap.cliSkipped = skipped.length;
    snap.cliBudgetMs = budget;
  }
  snap.ok = snap.units.length > 0 || snap.sensors.length > 0;
  // 하나도 읽지 못했는데 사유가 예산이면 그렇게 말한다(빈 error 로 두면 화면이 원인을 말하지 못한다).
  if (!snap.ok && budgetNoted && !snap.error) snap.error = PDU_BUDGET_SKIP_REASON;
  snap.collectedAt = Date.now();
  return snap;
}
