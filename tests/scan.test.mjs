import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  parseNetshNetworks,
  parseNmcliWifi,
  parseGateway,
  parseConnectedSsid,
  parseProfileKey,
  auditPassphrase,
  discoverNetworks,
  checkPort,
  scanPorts,
  runKaiWorkflow,
} from '../src/scan.mjs';

const NETSH_SAMPLE = `Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : TECNO Hotspot
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 00:11:22:33:44:55
         Signal             : 82%
         Radio type         : 802.11n
         Channel            : 6

SSID 2 : MTN_4G
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 66:77:88:99:aa:bb
         Signal             : 61%
         Channel            : 11

SSID 3 :
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 40%
         Channel            : 1
`;

test('parses netsh networks incl. hidden SSIDs', () => {
  const nets = parseNetshNetworks(NETSH_SAMPLE);
  assert.equal(nets.length, 3);
  assert.equal(nets[0].ssid, 'TECNO Hotspot');
  assert.equal(nets[0].authentication, 'WPA2-Personal');
  assert.equal(nets[0].signal, '82%');
  assert.equal(nets[0].channel, '6');
  assert.equal(nets[0].bssids[0], '00:11:22:33:44:55');
  assert.equal(nets[1].ssid, 'MTN_4G');
  assert.equal(nets[2].hidden, true);
});

test('parses nmcli output with escaped colons', () => {
  const nets = parseNmcliWifi('My\\:Net:88:WPA2:6\nCafe:40:--:1\n');
  assert.equal(nets.length, 2);
  assert.equal(nets[0].ssid, 'My:Net');
  assert.equal(nets[0].signal, '88%');
  assert.equal(nets[1].authentication, '--');
});

test('parses gateways from windows and unix output', () => {
  const win = 'Wireless LAN adapter Wi-Fi:\n\n   Default Gateway . . . . . . . . . : fe80::1%12\n                                       192.168.43.1\n';
  assert.equal(parseGateway(win), '192.168.43.1');
  assert.equal(parseGateway('default via 10.0.0.1 dev wlan0 proto dhcp\n'), '10.0.0.1');
  assert.equal(parseGateway('nothing here'), null);
});

test('parses connected ssid and profile key', () => {
  assert.equal(parseConnectedSsid('    Name : Wi-Fi\n    SSID : TECNO Hotspot\n    BSSID : 00:11\n'), 'TECNO Hotspot');
  assert.equal(parseProfileKey('    Key Content            : hunter2hunter2\n'), 'hunter2hunter2');
});

test('passphrase audit flags weak secrets and never exposes them', () => {
  const weak = auditPassphrase('password');
  assert.equal(weak.verdict, 'weak');
  assert.ok(weak.masked.startsWith('pa'));
  assert.ok(!weak.masked.includes('ssword'));
  assert.ok(weak.advice.length > 0);

  const strong = auditPassphrase('Tr0ub4dor&3-Correct-Horse!');
  assert.ok(['strong', 'very strong'].includes(strong.verdict));
  assert.ok(strong.bits > 80);

  const empty = auditPassphrase('');
  assert.equal(empty.verdict, 'unknown');
  assert.equal(empty.masked, '');
});

test('discoverNetworks uses netsh on windows and degrades with a message', () => {
  const calls = [];
  const result = discoverNetworks({
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { ok: true, stdout: NETSH_SAMPLE, stderr: '' };
    },
  });
  assert.equal(calls[0], 'netsh wlan show networks mode=bssid');
  assert.equal(result.networks.length, 3);
  assert.equal(result.error, null);

  const broken = discoverNetworks({ platform: 'win32', exec: () => ({ ok: false, stdout: '', stderr: 'nope' }) });
  assert.equal(broken.networks.length, 0);
  assert.match(broken.error, /WiFi/);
});

/** Filesystem-isolated workflow run with scripted answers. */
async function runWorkflow(answers, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-scan-'));
  const printed = [];
  const asked = [];
  const queue = [...answers];
  const exec = (cmd, args) => {
    const line = [cmd, ...(args || [])].join(' ');
    if (line.startsWith('netsh wlan show networks')) return { ok: true, stdout: NETSH_SAMPLE, stderr: '' };
    if (line.startsWith('netsh wlan show interfaces')) return { ok: true, stdout: '    SSID : TECNO Hotspot\n', stderr: '' };
    if (line.startsWith('ipconfig')) return { ok: true, stdout: 'Default Gateway . . . : 127.0.0.1\n', stderr: '' };
    if (line.startsWith('netsh wlan show profile')) return { ok: true, stdout: '    Key Content            : myhotspot' + 'pass123\n', stderr: '' };
    if (line.startsWith('where nmap') || line.startsWith('which nmap')) return { ok: false, stdout: '', stderr: 'not found' };
    return { ok: false, stdout: '', stderr: 'unknown command' };
  };
  const result = await runKaiWorkflow({
    ask: async (q) => {
      asked.push(q);
      return queue.shift() ?? 'n';
    },
    say: (s) => printed.push(String(s)),
    onStatus: () => {},
    exec,
    platform: 'win32',
    root,
  });
  return { result, printed: printed.join('\n'), asked, root };
}

test('KAI refuses when ownership is not confirmed and logs it', async () => {
  const { result, printed, asked, root } = await runWorkflow(['1', 'n']);
  assert.equal(result.authorised, false);
  assert.equal(result.reason, 'ownership-not-confirmed');
  assert.equal(result.picked.ssid, 'TECNO Hotspot');
  assert.match(asked[1], /VERIFY OWNERSHIP/);
  assert.match(printed, /Theory only/);
  assert.equal(asked.length, 2, 'must ask selection then confirmation');
  const log = fs.readFileSync(path.join(root, '.freecode', 'audit-log.jsonl'), 'utf8');
  assert.match(log, /scan.refused/);
  assert.doesNotMatch(log, /pass123/);
});

test('KAI accepts a number, confirms ownership, and only tests that device', async () => {
  const { result, printed, asked, root } = await runWorkflow(['1', 'y']);
  assert.equal(result.authorised, true);
  assert.equal(printed.includes('MTN_4G'), true, 'list shown');
  assert.match(asked[0], /Which one is YOUR OWN device/);
  assert.match(asked[1], /VERIFY OWNERSHIP/);
  assert.equal(result.gateway, '127.0.0.1');
  assert.equal(result.findings.passphrase.length > 0, true);
  const log = fs.readFileSync(path.join(root, '.freecode', 'audit-log.jsonl'), 'utf8');
  assert.match(log, /scan.authorised/);
  assert.match(log, /scan.completed/);
  assert.doesNotMatch(log, /pass123/, 'passphrase must never be logged');
});

test('KAI accepts an SSID name instead of a number', async () => {
  const { result } = await runWorkflow(['MTN_4G', 'n']);
  assert.equal(result.picked.ssid, 'MTN_4G');
  assert.equal(result.authorised, false);
});

test('KAI stops on cancel and on bad selections', async () => {
  const cancelled = await runWorkflow(['q']);
  assert.equal(cancelled.result.reason, 'cancelled');

  const bad = await runWorkflow(['99', 'nope', 'zzz']);
  assert.equal(bad.result.reason, 'bad-selection');
  assert.match(bad.printed, /Stopping/);
});

test('checkPort detects an open listener and a closed one', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const openPort = server.address().port;
  assert.equal(await checkPort('127.0.0.1', openPort, 800), true);
  server.close();
  const closed = await checkPort('127.0.0.1', 1, 300);
  assert.equal(closed, false);

  const ports = await scanPorts('127.0.0.1', [{ port: 1, service: 'x', risk: 'low' }], { timeout: 300 });
  assert.equal(ports.length, 0);
});
