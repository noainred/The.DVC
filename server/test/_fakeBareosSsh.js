/**
 * test/_fakeBareosSsh.js — Bareos 자동 설정 테스트용 가짜 SSH 서버·가짜 콘솔(bareosAutoSetup.test.js 에서 옮김 — v2.824 엣지 대행 테스트도 쓴다).
 */
/** 가짜 원격 서버 — 받은 명령을 기록하고 파일시스템을 흉내 낸다(명령 모양은 autoSetup.js 가 쓰는 것만). */
export function fakeServer(o = {}) {
  const F = new Map(Object.entries(o.files || {}).map(([p, v]) => [p, typeof v === 'string' ? { content: v, mode: '0640', owner: 'bareos' } : v]));
  const st = { uid: o.uid ?? '0', env: o.env ?? 'D B C U R', testCode: o.testCode ?? 0, testOut: o.testOut ?? 'ok', installFail: o.installFail || null, cmds: [], writes: [], reloads: 0, openssl: o.openssl ?? 'sha1 Fingerprint=56:F5:97:FE:60:52:17:73:D0:73:A2:ED:47:CE:07:28:2C:E6:FE:9C\nsubject=CN = vc-a.corp\nnotAfter=Jan  1 00:00:00 2030 GMT\n' };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd) => {
    st.cmds.push(cmd);
    let m;
    if (cmd === 'id -u') return ok(`${st.uid}\n`);
    if (cmd.startsWith('test -d /etc/bareos/bareos-dir.d && echo D;')) return ok(st.env.split(' ').join('\n'));
    // v2.822.3(S2-1): 부모 디렉터리 정규 경로 검사가 앞에 붙는다 — st.linkedDirs 에 든 디렉터리는 심링크(readlink -f 가 다르다)
    const canonOk = (d) => !(st.linkedDirs || []).includes(d);
    if ((m = /^if ! \[ "\$\(readlink -f -- (\S+)\)" = "\S+" \]; then echo LINK; elif \[ -L (\S+) \]/.exec(cmd))) { if (!canonOk(m[1])) return ok('LINK\n'); const f = F.get(m[2]); return ok(!f ? 'NONE\n' : f.link ? 'LINK\n' : f.dir ? 'OTHER\n' : `FILE\n${f.content}`); }
    if ((m = /^mktemp -d \/tmp\/([a-z-]+)\.X{10}$/.exec(cmd))) return ok(`/tmp/${m[1]}.Ab3dEf7hIj\n`);
    if (/^test -d \S+ && test ! -L \S+ && test -O \S+ && echo ok$/.test(cmd)) return ok('ok\n');
    if (/^test -d \S+ \|\| install -d /.test(cmd)) return ok();
    if ((m = /^\[ "\$\(readlink -f -- (\S+)\)" = "\S+" \] && install -o (\w+) -g bareos -m (\d+) (\S+) (\S+) && rm -f \S+$/.exec(cmd))) {
      if (!canonOk(m[1])) return { code: 1, stdout: '', stderr: '' };
      if (st.installFail && m[5] === st.installFail) return { code: 1, stdout: '', stderr: 'install: No space left on device' };
      const t = F.get(m[4]); if (!t) return { code: 1, stdout: '', stderr: 'no tmp' };
      F.set(m[5], { content: t.content, mode: m[3], owner: m[2] }); F.delete(m[4]); return ok();
    }
    if (cmd.includes('bareos-dir -t')) return { code: st.testCode, stdout: st.testOut, stderr: '' };
    if (cmd.startsWith('printf') && cmd.includes('bconsole')) { st.reloads += 1; return ok('reloaded\n'); }
    if ((m = /^\[ "\$\(readlink -f -- (\S+)\)" = "\S+" \] && rm -f (\S+)$/.exec(cmd))) { if (!canonOk(m[1])) return { code: 1, stdout: '', stderr: '' }; F.delete(m[2]); return ok(); }
    if (/^rm -rf \/tmp\/portal-bareos\.\w+$/.test(cmd)) { for (const k of [...F.keys()]) if (k.startsWith(cmd.slice(7))) F.delete(k); return ok(); }
    if (cmd.startsWith('id -u bareos')) return ok('U\n');
    if (cmd.startsWith('rpm -q bareos-vmware-plugin')) return ok('bareos-vmware-plugin-24.0.1-1.el9.x86_64\n');
    if (cmd.startsWith('timeout 20 openssl s_client')) return ok(st.openssl);
    return { code: 127, stdout: '', stderr: `unknown: ${cmd}` };
  };
  const api = {
    exec,
    readFile: async (p) => { const f = F.get(p); if (!f) throw new Error('ENOENT'); return f.content; },
    writeFile: async (p, c, mode) => { st.writes.push({ p, mode }); F.set(p, { content: String(c), mode: mode.toString(8).padStart(4, '0'), owner: 'root' }); },
  };
  const ssh = async (creds, fn) => { st.creds = { ...creds }; return { ok: true, ...(await fn(api)) }; };
  return { F, st, ssh };
}

/** 가짜 콘솔 — 받은 접속값을 기록. accept(conn) 이 false 면 인증 실패. */
export function fakeConsole(accept = () => true) {
  const seen = [];
  const open = async (conn) => {
    seen.push({ ...conn });
    if (!accept(conn)) throw Object.assign(new Error('Authorization failed.'), { code: 'auth' });
    return { info: { banner: '1000 OK: bareos-dir Version: 24.0.1 (01 Jan 2025)', tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' } }, call: async () => ({ clients: [{ name: 'kr-fd' }] }), close() {} };
  };
  return { open, seen };
}

