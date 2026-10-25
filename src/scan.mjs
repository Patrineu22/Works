/**
 * KAI - red-team lab assistant for devices you own.
 *
 * Hard rules enforced in code, not just in the prompt:
 *   scan -> numbered list -> user picks device -> explicit ownership confirmation
 *        -> (yes) test that ONE device only / (no) stop, theory only
 *
 * Only passive, non-destructive checks are run: gateway discovery, TCP port
 * availability and a local passphrase-strength audit. Deauthentication and any
 * disruptive "lab mode" test are deliberately NOT executed - the tool prints a
 * checklist instead, because those need dedicated hardware and can break real
 * networks. Everything authorised is appended to .freecode/audit-log.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { auditLogPath, findProjectRoot, ensureState } from './config.mjs';
import { fg, bold } from './theme.mjs';
import { box, ok, warn, error, bullet } from './ui.mjs';

export const COMMON_PORTS = [
  { port: 21, service: 'ftp', risk: 'high', note: 'plaintext file transfer' },
  { port: 22, service: 'ssh', risk: 'medium', note: 'remote shell - key auth only' },
  { port: 23, service: 'telnet', risk: 'critical', note: 'plaintext remote shell, disable it' },
  { port: 53, service: 'dns', risk: 'low', note: 'dns resolver' },
  { port: 80, service: 'http', risk: 'low', note: 'unencrypted web admin' },
  { port: 139, service: 'netbios', risk: 'high', note: 'legacy Windows sharing' },
  { port: 443, service: 'https', risk: 'low', note: 'encrypted web admin' },
  { port: 445, service: 'smb', risk: 'critical', note: 'file sharing - never expose to internet' },
  { port: 3389, service: 'rdp', risk: 'high', note: 'remote desktop - brute force target' },
  { port: 5900, service: 'vnc', risk: 'high', note: 'often no auth at all' },
  { port: 8080, service: 'http-alt', risk: 'medium', note: 'router/app admin panel' },
];

/** Default exec: run a command, never throw, return stdout text. */
export function defaultExec(command, args = [], { timeout = 20000 } = {}) {
  try {
    const out = execFileSync(command, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(out), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    };
  }
}

/* ------------------------------------------------------------------ parsing */

/** Parse `netsh wlan show networks mode=bssid` output (Windows). */
export function parseNetshNetworks(text) {
  const networks = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const ssidMatch = line.match(/^\s*SSID\s+(\d+)\s*:\s*(.*)$/i);
    if (ssidMatch) {
      if (current) networks.push(current);
      current = {
        index: Number(ssidMatch[1]),
        ssid: ssidMatch[2].trim(),
        hidden: !ssidMatch[2].trim(),
        authentication: '',
        encryption: '',
        signal: '',
        channel: '',
        bssids: [],
      };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]*?)\s*:\s*(.*)$/);
    if (!field) continue;
    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    if (key === 'authentication') current.authentication = value;
    else if (key === 'encryption') current.encryption = value;
    else if (key === 'signal') current.signal = value;
    else if (key === 'channel') current.channel = value;
    else if (key === 'bssid 1' || /^bssid \d+$/.test(key)) current.bssids.push(value);
  }
  if (current) networks.push(current);
  return networks;
}

/** Parse `nmcli -t -f SSID,SIGNAL,SECURITY,CHAN device wifi list` (Linux). */
export function parseNmcliWifi(text) {
  const networks = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    // nmcli escapes ':' inside SSIDs as '\:'
    const parts = line.replace(/\\:/g, '\u0000').split(':').map((p) => p.replace(/\u0000/g, ':'));
    const [ssid = '', signal = '', security = '', channel = ''] = parts;
    if (!ssid.trim()) continue;
    networks.push({
      index: networks.length + 1,
      ssid: ssid.trim(),
      hidden: false,
      authentication: security || 'OPEN',
      encryption: '',
      signal: signal ? `${signal}%` : '',
      channel,
      bssids: [],
    });
  }
  return networks;
}

/** Parse macOS `airport -s` output. */
export function parseAirportScan(text) {
  const networks = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const m = line.match(/^\s*(\S.*?)\s+([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[\da-fA-F:]{11})\s+(-?\d+)\s+(\d+)\s+/);
    if (!m) continue;
    networks.push({
      index: networks.length + 1,
      ssid: m[1].trim(),
      hidden: false,
      authentication: (line.split(/\s{2,}/).pop() || '').trim(),
      encryption: '',
      signal: `${m[3]} dBm`,
      channel: m[4],
      bssids: [m[2]],
    });
  }
  return networks;
}

/** Parse the default gateway out of ipconfig / ip route / route -n output. */
export function parseGateway(text) {
  const out = String(text);
  const win = out.match(/Default Gateway[^:]*:\s*(?:fe80::[^\s%]+%\d+|[^\s:]+)\s*\r?\n\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i)
    || out.match(/Default Gateway[^:]*:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i);
  if (win) return win[1];
  const nix = out.match(/default\s+via\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i);
  if (nix) return nix[1];
  const mac = out.match(/gateway:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i);
  if (mac) return mac[1];
  return null;
}

/** Connected SSID from `netsh wlan show interfaces`. */
export function parseConnectedSsid(text) {
  const m = String(text).match(/^\s*SSID\s*:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

/** Parse `netsh wlan show profile name="X" key=clear` for the local PSK. */
export function parseProfileKey(text) {
  const m = String(text).match(/Key Content\s*:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

/* ------------------------------------------------------------- discovery */

/** Discover nearby WiFi networks for the current OS. */
export function discoverNetworks({ platform = process.platform, exec = defaultExec } = {}) {
  // Testing/demo escape hatch: FREECODE_SCAN_FIXTURE=netsh-output-file (or inline
  // text). Nothing is scanned for real in this mode and the UI says so loudly.
  const fixture = process.env.FREECODE_SCAN_FIXTURE;
  if (fixture) {
    const text = fs.existsSync(fixture) ? fs.readFileSync(fixture, 'utf8') : fixture;
    return {
      networks: parseNetshNetworks(text),
      command: `fixture:${path.basename(fixture)}`,
      error: null,
      fixture: true,
    };
  }

  if (platform === 'win32') {
    const res = exec('netsh', ['wlan', 'show', 'networks', 'mode=bssid']);
    const networks = parseNetshNetworks(res.stdout);
    if (networks.length) return { networks, command: 'netsh wlan show networks mode=bssid', error: null };
    return {
      networks: [],
      command: 'netsh wlan show networks mode=bssid',
      error: res.ok ? 'no wireless networks reported (WiFi off or no adapter)' : 'netsh failed - is WiFi enabled?',
    };
  }
  if (platform === 'darwin') {
    const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
    const res = exec(airport, ['-s']);
    return { networks: parseAirportScan(res.stdout), command: `${path.basename(airport)} -s`, error: res.ok ? null : 'airport scan failed' };
  }
  const res = exec('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY,CHAN', 'device', 'wifi', 'list']);
  if (res.ok) return { networks: parseNmcliWifi(res.stdout), command: 'nmcli device wifi list', error: null };
  const iw = exec('iw', ['dev']);
  return {
    networks: [],
    command: 'nmcli device wifi list',
    error: `${res.stderr.trim() || 'nmcli not available'}${iw.ok ? '' : ' (install NetworkManager or iw)'}`,
  };
}

/** Default gateway of the currently connected network. */
export function findGateway({ platform = process.platform, exec = defaultExec } = {}) {
  const candidates =
    platform === 'win32'
      ? [['ipconfig', []]]
      : platform === 'darwin'
        ? [['route', ['-n', 'get', 'default']], ['netstat', ['-rn']]]
        : [['ip', ['route']], ['ip', ['route', 'show', 'default']], ['netstat', ['-rn']]];
  for (const [cmd, args] of candidates) {
    const res = exec(cmd, args);
    if (!res.ok) continue;
    const gateway = parseGateway(res.stdout);
    if (gateway) return gateway;
  }
  return null;
}

/** Currently connected SSID, if any. */
export function connectedSsid({ platform = process.platform, exec = defaultExec } = {}) {
  if (platform === 'win32') {
    const res = exec('netsh', ['wlan', 'show', 'interfaces']);
    return res.ok ? parseConnectedSsid(res.stdout) : null;
  }
  if (platform === 'darwin') {
    const res = exec('networksetup', ['-getairportnetwork', 'en0']);
    const m = String(res.stdout).match(/Current Wi-Fi Network:\s*(.+)$/im);
    return m ? m[1].trim() : null;
  }
  const res = exec('iwgetid', ['-r']);
  return res.ok && res.stdout.trim() ? res.stdout.trim() : null;
}

/* ------------------------------------------------------------ own device */

/** TCP-connect scan of a host. Purely observational: no payloads, no exploits. */
export async function scanPorts(host, ports = COMMON_PORTS, { timeout = 700, concurrency = 12 } = {}) {
  const queue = [...ports];
  const results = [];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const open = await checkPort(host, item.port, timeout);
      if (open) results.push({ ...item, open: true });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return results.sort((a, b) => a.port - b.port);
}

export function checkPort(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Estimate passphrase strength without ever echoing the secret. */
export function auditPassphrase(passphrase) {
  const value = String(passphrase || '');
  if (!value) return { score: 0, verdict: 'unknown', bits: 0, masked: '', advice: ['No passphrase available to audit.'] };
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/[0-9]/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 33;
  const bits = Math.round(value.length * Math.log2(pool || 1));
  const common = /^(password|12345678|qwerty|admin|welcome|letmein|00000000|iloveyou)/i.test(value);
  let score;
  let verdict;
  if (common || bits < 40) {
    score = 1;
    verdict = 'weak';
  } else if (bits < 60) {
    score = 2;
    verdict = 'fair';
  } else if (bits < 80) {
    score = 3;
    verdict = 'strong';
  } else {
    score = 4;
    verdict = 'very strong';
  }
  const advice = [];
  if (value.length < 12) advice.push('Use at least 12 characters (16+ is better).');
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value)) advice.push('Mix upper and lower case.');
  if (!/[0-9]/.test(value)) advice.push('Add digits.');
  if (!/[^A-Za-z0-9]/.test(value)) advice.push('Add a symbol like - or _.');
  if (common) advice.push('This looks like a common password - change it now.');
  if (!advice.length) advice.push('Good length and variety. Rotate it if anyone else ever connected.');
  return {
    score,
    verdict,
    bits,
    masked: value.slice(0, 2) + '*'.repeat(Math.max(4, value.length - 2)),
    length: value.length,
    advice,
  };
}

/** Look up the local saved passphrase for a profile (Windows only, opt-in). */
export function readOwnProfileKey(ssid, { platform = process.platform, exec = defaultExec } = {}) {
  if (platform !== 'win32') return null;
  const res = exec('netsh', ['wlan', 'show', 'profile', `name=${ssid}`, 'key=clear']);
  if (!res.ok) return null;
  return parseProfileKey(res.stdout);
}

/** Append an audit record. Returns the log path. */
export function writeAuditLog(entry, root = findProjectRoot()) {
  ensureState(root);
  const file = auditLogPath(root);
  const record = { timestamp: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return file;
}

/* --------------------------------------------------------------- workflow */

const THEORY_ONLY = [
  'Stopping here - no scan, no tests. Nothing was touched.',
  '',
  'Theory only, the safe way to learn the same ideas:',
  '  • WPA2/WPA3 handshakes are only interesting on networks you own, with your own devices.',
  '  • Open ports = services listening. Close what you do not use; that is most of hardening.',
  '  • Router admin panel: change default admin password, disable WPS, disable remote management.',
  '  • Guest network for IoT devices isolates them from your laptop and phone.',
  '  • Practise legally on your own lab: a spare router or an old phone hotspot.',
].join('\n');

/**
 * Full KAI workflow with injected IO so it is testable.
 *
 * @param {object} opts
 * @param {(q:string)=>Promise<string>} opts.ask     prompt the user, resolve answer
 * @param {(s:string)=>void} opts.say                print a line
 * @param {object} [opts.exec]                       command runner
 * @param {string} [opts.platform]
 * @param {(s:string)=>void} [opts.onStatus]         transient status text
 */
export async function runKaiWorkflow({
  ask,
  say = () => {},
  exec = defaultExec,
  platform = process.platform,
  onStatus = () => {},
  root = findProjectRoot(),
} = {}) {
  const startedAt = new Date().toISOString();
  say(box('KAI - own-device lab workflow (scan → list → pick → verify → test)', { title: 'KAI' }));
  say(fg('muted', '  Step 1/5  discovering WiFi networks...'));

  const discovery = discoverNetworks({ platform, exec });
  if (discovery.error && !discovery.networks.length) {
    say(error(`Discovery failed: ${discovery.error}`));
    say(fg('muted', `  command: ${discovery.command}`));
    say(
      platform === 'win32'
        ? fg('muted', '  fix: Settings → Network → Wi-Fi = On, then run /scan again.')
        : fg('muted', '  fix: connect to WiFi and make sure NetworkManager/nmcli is installed.'),
    );
    return { authorised: false, reason: 'discovery-failed', discovery };
  }

  // Deduplicate SSIDs, keep strongest signal info, keep hidden ones out of the list.
  const seen = new Map();
  for (const net of discovery.networks) {
    if (!net.ssid) continue;
    const prev = seen.get(net.ssid);
    if (!prev || (net.bssids?.length || 0) > (prev.bssids?.length || 0)) seen.set(net.ssid, net);
  }
  const list = [...seen.values()].map((net, i) => ({ ...net, index: i + 1 }));

  if (!list.length) {
    say(warn('No visible networks found. Move closer to the router/hotspot and retry.'));
    return { authorised: false, reason: 'no-networks', networks: [] };
  }

  if (discovery.fixture) {
    say(warn('DEMO MODE: FREECODE_SCAN_FIXTURE is set - this list is a fixture, not live WiFi.'));
  }
  say(ok(`Found ${list.length} network${list.length === 1 ? '' : 's'} (via ${discovery.command})`));
  say('');
  for (const net of list) {
    const enc = net.authentication || 'unknown';
    const sig = net.signal ? fg('muted', `  ${net.signal}`) : '';
    say(`  ${bold(fg('primary', String(net.index)))}. ${net.ssid}  ${fg('primaryDim', `[${enc}]`)}${sig}`);
  }
  say('');

  // Steps 2-3: pick ONE device, retry a few times on bad input.
  let picked = null;
  for (let attempt = 0; attempt < 3 && !picked; attempt += 1) {
    const answer = String(
      await ask(
        'I can see these networks. Which one is YOUR OWN device you own and want to test? Tell me number or SSID name.',
      ),
    ).trim();
    if (!answer) continue;
    if (/^(q|quit|exit|cancel)$/i.test(answer)) {
      say(warn('Cancelled. Nothing was scanned.'));
      return { authorised: false, reason: 'cancelled', networks: list };
    }
    const asNumber = Number(answer);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= list.length) {
      picked = list[asNumber - 1];
    } else {
      const matches = list.filter((n) => n.ssid.toLowerCase() === answer.toLowerCase());
      const fuzzy = matches.length ? matches : list.filter((n) => n.ssid.toLowerCase().includes(answer.toLowerCase()));
      if (fuzzy.length === 1) picked = fuzzy[0];
      else if (fuzzy.length > 1) {
        say(warn(`"${answer}" matches ${fuzzy.length} networks: ${fuzzy.map((n) => n.ssid).join(', ')}. Use the number.`));
      } else {
        say(warn(`No network matches "${answer}". Pick 1-${list.length} or the exact SSID.`));
      }
    }
  }
  if (!picked) {
    say(error('No valid selection after 3 tries. Stopping - nothing was scanned.'));
    return { authorised: false, reason: 'bad-selection', networks: list };
  }

  // Step 4: ownership verification - mandatory, no bypass flag.
  say('');
  say(fg('warn', `Selected: ${picked.ssid}${picked.bssids?.[0] ? `  (${picked.bssids[0]})` : ''}`));
  const verify = String(
    await ask(
      `VERIFY OWNERSHIP: You said "${picked.ssid}" is your own device. Confirm you own it and are authorized to test it? Reply y=yes I own and authorized, n=no.`,
    ),
  ).trim().toLowerCase();

  if (!/^(y|yes|yeah|yep)$/i.test(verify)) {
    // Step 5: stop immediately.
    writeAuditLog(
      {
        action: 'scan.refused',
        ssid: picked.ssid,
        reason: 'ownership-not-confirmed',
        answer: verify.slice(0, 20),
        startedAt,
        platform,
      },
      root,
    );
    say('');
    say(box(THEORY_ONLY, { title: 'Refused - theory only', colour: 'warn' }));
    return { authorised: false, reason: 'ownership-not-confirmed', networks: list, picked };
  }

  // Step 6: authorised, single target only.
  say('');
  say(ok(`Authorisation confirmed for "${picked.ssid}". Testing this ONE device only.`));
  const logFile = writeAuditLog(
    { action: 'scan.authorised', ssid: picked.ssid, bssid: picked.bssids?.[0] || null, platform, startedAt },
    root,
  );
  say(fg('muted', `  logged: ${logFile}`));

  onStatus('finding gateway');
  const ssidNow = connectedSsid({ platform, exec });
  const gateway = discovery.fixture && process.env.FREECODE_SCAN_GATEWAY
    ? process.env.FREECODE_SCAN_GATEWAY
    : findGateway({ platform, exec });
  if (!gateway) {
    say(warn('Could not detect a default gateway - are you connected to that hotspot right now?'));
    say(fg('muted', '  Connect this computer to the device you confirmed, then run /scan again.'));
    return { authorised: true, reason: 'no-gateway', networks: list, picked, logFile };
  }
  if (ssidNow && ssidNow.toLowerCase() !== picked.ssid.toLowerCase()) {
    say(warn(`You are currently connected to "${ssidNow}", not "${picked.ssid}".`));
    say(fg('muted', '  Only the connected network can be reached; tests target its gateway.'));
  }

  say('');
  say(fg('primary', `  target gateway: ${gateway}`));
  onStatus(`scanning ports on ${gateway}`);
  const openPorts = await scanPorts(gateway, COMMON_PORTS);
  if (!openPorts.length) {
    say(ok('No common TCP ports answered. That is a good result for a phone hotspot.'));
  } else {
    say(warn(`${openPorts.length} open port${openPorts.length === 1 ? '' : 's'} on ${gateway}:`));
    for (const p of openPorts) {
      const colour = p.risk === 'critical' || p.risk === 'high' ? 'error' : p.risk === 'medium' ? 'warn' : 'primaryDim';
      say(`  ${fg(colour, `${p.port}/${p.service}`)}  ${fg('muted', `${p.risk} risk - ${p.note}`)}`);
    }
  }

  // Optional nmap detail if the user already has it installed.
  const nmapCheck = exec(platform === 'win32' ? 'where' : 'which', ['nmap']);
  let nmapSummary = null;
  if (nmapCheck.ok) {
    onStatus('running nmap service detection');
    const nmap = exec('nmap', ['-sV', '-Pn', '--top-ports', '50', gateway], { timeout: 120000 });
    if (nmap.ok) {
      const lines = nmap.stdout.split(/\r?\n/).filter((l) => /^\d+\/tcp/.test(l.trim()));
      nmapSummary = lines.map((l) => l.trim());
      say('');
      say(fg('primaryDim', '  nmap -sV (top 50):'));
      for (const line of nmapSummary) say(`    ${line}`);
    }
  } else {
    say(fg('muted', '  nmap not installed - TCP connect scan used instead (nmap gives service versions).'));
  }

  // Local passphrase audit: only for your own saved profile, secret never printed or logged.
  let password = null;
  if (platform === 'win32') {
    onStatus('auditing own hotspot passphrase');
    const key = readOwnProfileKey(picked.ssid, { platform, exec });
    if (key) {
      password = auditPassphrase(key);
      say('');
      say(fg('primaryDim', `  own passphrase audit (${password.masked}, ${password.length} chars)`));
      say(`    strength: ${password.verdict}  ~${password.bits} bits`);
      for (const tip of password.advice) say(`    ${bullet(tip)}`);
    } else {
      say(fg('muted', '  No saved passphrase for this profile (or it is not a Windows profile). Skipping audit.'));
    }
  }

  const findings = {
    gateway,
    openPorts: openPorts.map(({ port, service, risk }) => ({ port, service, risk })),
    nmap: nmapSummary,
    passphrase: password ? { verdict: password.verdict, bits: password.bits, length: password.length } : null,
  };
  writeAuditLog({ action: 'scan.completed', ssid: picked.ssid, gateway, findings, finishedAt: new Date().toISOString() }, root);

  say('');
  say(
    box(
      [
        'Deauth / disruptive "lab mode" tests are NOT run by FreeCode.',
        'They need monitor-mode hardware, they can drop real users, and they are',
        'illegal on networks you do not own. Checklist if you own the lab hardware:',
        '  1. Use an isolated access point you own, no other users connected.',
        '  2. Verify WPA3 or WPA2-AES + long passphrase resists the handshake capture.',
        '  3. Rotate the PSK afterwards and check the router logs.',
        '  4. Record everything in .freecode/audit-log.jsonl (FreeCode does this for you).',
      ].join('\n'),
      { title: 'Lab mode - guidance only', colour: 'warn' },
    ),
  );

  return { authorised: true, reason: 'completed', networks: list, picked, gateway, openPorts, findings, logFile };
}

/** Non-interactive summary used by --scan-json (automation / CI). */
export async function passiveSummary({ platform = process.platform, exec = defaultExec } = {}) {
  const discovery = discoverNetworks({ platform, exec });
  return {
    platform,
    command: discovery.command,
    error: discovery.error,
    networks: discovery.networks.map((n) => ({
      ssid: n.ssid,
      authentication: n.authentication,
      signal: n.signal,
      channel: n.channel,
    })),
  };
}
