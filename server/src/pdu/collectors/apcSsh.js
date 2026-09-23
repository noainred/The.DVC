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

import { withSsh } from '../../proxy/sshExec.js';
import { emptySnapshot, MAX_PDU_UNITS, MAX_SENSORS, MAX_BANKS, MAX_PHASES } from '../types.js';
import { cmd, parseReading, parseAbout, toCelsius, toWatts } from '../parse.js';

/**
 * 한 대 수집.
 * @param {object} device { id,name,host,username,password,sshPort,datacenterId }
 * @param {{ signal?:AbortSignal, onTrace?:(m:string)=>void }} opts
 * @returns {Promise<object>} 정규화 스냅샷(types.js emptySnapshot 형태)
 */
export async function collect(device, { signal = undefined, onTrace = null } = {}) {
  const snap = emptySnapshot(device);
  const creds = {
    host: device.host,
    port: Number(device.sshPort) || 22,
    username: device.username,
    password: device.password,
    signal,                               // 마감시간이 오면 세션을 실제로 끊는다
    trace: onTrace || undefined,
  };

  await withSsh(creds, async ({ exec }) => {
    // 값 한 건 읽기. E1xx(해당 없음)는 오류로 올리지 않고 null 을 돌려준다.
    const read = async (command) => {
      try {
        const r = await exec(command);
        return parseReading(`${r.stdout || ''}\n${r.stderr || ''}`);
      } catch (e) {
        // 세션 자체가 끊긴 경우만 위로 던진다(마감/네트워크). 명령 오류는 null.
        if (signal?.aborted) throw e;
        return { value: null, unit: '', code: '', ok: false };
      }
    };

    // --- 장비 식별(실패해도 수집은 계속) ---
    try {
      const ab = await exec(cmd.about());
      Object.assign(snap, parseAbout(ab.stdout || ''));
    } catch { snap.notes.push('about 조회 실패 — 모델/시리얼 미확인'); }

    // --- PDU 본체(데이지체인) 자동 탐지 ---
    for (let i = 1; i <= MAX_PDU_UNITS; i++) {
      const power = await read(cmd.dev(i, 'power'));
      if (!power.ok) {
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

      // 뱅크별 부하(A) — 사용자 요구 '뱅크별 소요 전력'. 있는 만큼만.
      for (let b = 1; b <= MAX_BANKS; b++) {
        const cur = await read(cmd.bank(b, 'current'));
        if (!cur.ok) break;
        unit.banks.push({ index: b, currentA: cur.value });
      }
      // 상(phase)별 전류/전압 — 3상 장비에서 유의미.
      for (let p = 1; p <= MAX_PHASES; p++) {
        const cur = await read(cmd.phase(p, 'current'));
        if (!cur.ok) break;
        const volt = await read(cmd.phase(p, 'voltage'));
        unit.phases.push({ index: p, currentA: cur.value, voltageV: volt.value });
      }
      snap.units.push(unit);
    }
    if (!snap.units.length) snap.notes.push('전력 값을 읽지 못했습니다(devReading) — 계정 권한/모델을 확인하세요.');

    // --- 환경 센서 자동 탐지 (온도/습도) ---
    for (let i = 1; i <= MAX_SENSORS; i++) {
      const t = await read(cmd.temp(i));
      const h = await read(cmd.hum(i));
      // 온도·습도 **둘 다** 없으면 그 인덱스에는 센서가 없다 → 탐지 종료.
      if (!t.ok && !h.ok) break;
      let name = '';
      try {
        const n = await exec(cmd.sensorName(i));
        // sensorName 은 값이 문자열이라 parseReading(숫자 전제)을 쓰지 않는다.
        const lines = String(n.stdout || '').split(/\r?\n/);
        const ci = lines.findIndex((l) => /^\s*E\d{3}\s*:/.test(l));
        if (ci >= 0 && /E000/.test(lines[ci])) name = (lines.slice(ci + 1).find((l) => l.trim() && !/^apc>/i.test(l)) || '').trim();
      } catch { /* 이름은 선택 정보 */ }
      snap.sensors.push({
        index: i,
        name,
        tempC: toCelsius(t.value, t.unit),
        humidityPct: h.value,
      });
    }
    if (!snap.sensors.length) snap.notes.push('환경 센서가 없습니다(AP9335T/TH 미장착) — 온도·습도는 수집되지 않습니다.');
  }, { signal });

  snap.ok = snap.units.length > 0 || snap.sensors.length > 0;
  snap.collectedAt = Date.now();
  return snap;
}
