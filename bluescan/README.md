# Bluescan: Advanced Bluetooth Reconnaissance & Protocol Auditor

**Deep BLE reconnaissance, GATT attack-surface mapping and protocol-level AVRCP media-control injection — in one async CLI.**

`bluescan` is a single-file Python tool for security engineers auditing Bluetooth
audio devices and BLE firmware: fingerprint targets by profile, map every writable
and notifiable GATT characteristic, then send spec-correct media control frames and
fuzz vendor characteristics while watching how the firmware reacts.

> **Authorised testing only.** Use Bluescan exclusively on devices you own or have
> written permission to test. Active commands (`media`, `simulate-takeover`, `raw`)
> require `--yes` or an interactive ownership confirmation, and every action is
> written to an audit log.

---

## Contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Security audit scenarios](#security-audit-scenarios)
- [Protocol reference](#protocol-reference)
- [How it maps to real devices](#how-it-maps-to-real-devices)
- [Output, logging and audit trail](#output-logging-and-audit-trail)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Legal](#legal)

## Features

- **Profile fingerprinting** — every discovered device is tagged from its advertised
  UUIDs: `AUDIO_TARGET` (AVRCP `0x110E`/`0x110C`/`0x110F`, A2DP `0x110A`/`0x110B`/`0x110D`),
  `PHONE_TARGET` (HFP `0x111E`/`0x111F`, HSP `0x1108`, Generic Audio `0x1203`),
  `INPUT_TARGET` (HID `0x1812`) and `SENSOR` (heart rate, battery). High-value targets
  are sorted to the top of the table with RSSI, name and service UUIDs.
- **GATT profiling** — full service/characteristic enumeration with writable,
  write-without-response and notify/indicate characteristics **highlighted**, plus a
  dedicated flag for AVRCP/MCS/VCS media control points (the command-injection vectors).
- **AVRCP injection** — `play`, `pause`, `stop`, `next`, `prev`, `volume_up`,
  `volume_down`, `mute` sent as spec-correct AV/C PASS THROUGH frames, with per-command
  latency so you can spot firmware that stalls or ignores releases.
- **Takeover simulation** — an automated state-machine stress test:
  `stop` → `prev` ×5 → `play` → hold the link open while notifications stream in.
- **Raw GATT fuzzing** — arbitrary hex to any characteristic, chunked to ATT size,
  repeatable, with `write`/`write-without-response` control for vendor commands and
  buffer/state-machine testing.
- **Robust by construction** — every connection, write and hold is bounded by
  `asyncio.wait_for`, so nothing hangs; `Ctrl+C` cancels a hold cleanly and always
  disconnects. Device-not-found, connection-refused, UUID-mismatch and
  permission-denied each produce a distinct, actionable message.
- **Cross-platform** — BlueZ (Linux), WinRT (Windows) and CoreBluetooth (macOS) via
  `bleak`. JSON output for pipelines, `--dry-run` for payload rehearsal.

## Installation

```bash
# from the repository root
cd bluescan

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
python bluescan.py --help
```

Requirements: **Python 3.9+**, `bleak >= 0.20` and `rich >= 13`. Verified against
bleak 3.0.2 / rich 15.0.0 on Linux; the bleak API used (`discover(return_adv=True)`,
`write_gatt_char`, `start_notify`) is stable across 0.20 → 3.x.

Platform notes:

| OS | What you need |
| --- | --- |
| Linux | BlueZ ≥ 5.50, adapter powered (`bluetoothctl power on`), user in the `bluetooth` group |
| Windows 10/11 | Bluetooth on; allow desktop apps in Settings → Privacy → Bluetooth |
| macOS | Bluetooth enabled; grant your terminal access in Settings → Privacy & Security → Bluetooth |

## Quick start

```bash
# 1. find targets (10 second scan)
python bluescan.py scan --duration 10

# 2. map the GATT attack surface of an audio device
python bluescan.py profile 00:1A:7D:DA:71:13

# 3. send a media command (you must own the device)
python bluescan.py media --mac 00:1A:7D:DA:71:13 --action pause --yes

# 4. rehearse payloads with no radio traffic at all
python bluescan.py media --mac 00:1A:7D:DA:71:13 --action play --dry-run
```

Example scan output:

```
                              Bluetooth reconnaissance - 3 device(s)
┏━━━┳━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━┓
┃ # ┃ Address           ┃ Name       ┃    RSSI ┃ Tag          ┃ Profiles         ┃ Service UUIDs ┃
┡━━━╇━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━┩
│ 1 │ AA:BB:CC:DD:EE:01 │ TECNO Buds │ -48 dBm │ AUDIO_TARGET │ A2DP_SINK, AVRCP │ 110b / 110e   │
│ 2 │ AA:BB:CC:DD:EE:02 │ MTN Phone  │ -61 dBm │ PHONE_TARGET │ HFP_HANDSFREE    │ 111e          │
│ 3 │ AA:BB:CC:DD:EE:03 │ Mi Band    │ -77 dBm │ SENSOR       │ HEART_RATE       │ 180d          │
└───┴───────────────────┴────────────┴─────────┴──────────────┴──────────────────┴───────────────┘
[INFO] 1 AUDIO_TARGET(s) found - next: bluescan.py profile AA:BB:CC:DD:EE:01
```

## Commands

| Command | Purpose |
| --- | --- |
| `scan --duration N` | discover BLE devices, fingerprint and table them (`--name-filter`, `--no-services`, `--json`) |
| `profile <MAC>` | enumerate services/characteristics, flag writable + notify + media control points |
| `media --mac <MAC> --action <A>` | send one media action (`--frame avc\|avc4\|avctp`, `--no-release`, `--repeat`, `--delay`, `--char`) |
| `simulate-takeover --mac <MAC>` | stop → prev ×5 → play → hold (`--hold` seconds, default 30) |
| `raw --mac <MAC> --char <UUID> --hex "AA BB"` | arbitrary injection (`--chunk`, `--repeat`, `--delay`, `--no-response`) |

Global flags (accepted before **or** after the subcommand): `-v/--verbose`, `--json`,
`--no-color`, `--dry-run`, `--yes`, `--audit-log PATH`, `--connect-timeout`,
`--write-timeout`, `--version`.

## Security audit scenarios

### Scenario A — audio-profile integrity and state-machine recovery

Goal: does the firmware keep track of playback state under rapid, adversarial input,
and does it recover after being told to stop and skip backwards repeatedly?

```bash
python bluescan.py scan --duration 10
python bluescan.py profile 00:1A:7D:DA:71:13     # confirm a MEDIA_CTRL point exists
python bluescan.py simulate-takeover --mac 00:1A:7D:DA:71:13 --hold 30 --yes
```

What the sequence does and what to watch:

1. connects and subscribes to every notify/indicate characteristic,
2. sends `stop` (today's playback state is interrupted),
3. sends `prev` five times — track navigation, queue boundaries, repeated state resets,
4. sends `play` — resumption after an abnormal transition,
5. holds the connection for 30 s while notifications are printed live.

Observe and record: does audio resume, does the device (or its companion app) show the
right track, does the link survive, does it disconnect and re-advertise, does the
notification rate spike, does the device remain responsive to further commands? A
device that ignores releases, replays commands twice, or wedges until power-cycling is
a genuine resilience finding — with a timeline in the audit log to back it.

### Scenario B — vendor-specific command fuzzing

Goal: exercise a proprietary characteristic with malformed or unexpected payloads.

```bash
# single crafted frame
python bluescan.py raw --mac 00:1A:7D:DA:71:13 \
  --char 0000ae02-0000-1000-8000-00805f9b34fb \
  --hex "00 48 7C 44 00" --yes

# repeated, ATT-chunked injection to probe buffer handling
python bluescan.py raw --mac 00:1A:7D:DA:71:13 \
  --char 0000fff1-0000-1000-8000-00805f9b34fb \
  --hex "AA BB CC DD EE FF 00 11 22 33 44 55" \
  --chunk 20 --repeat 25 --delay 0.1 --yes
```

Guidance that keeps the audit useful:

- run `profile` first and `raw` only against characteristics you understand,
- start with `--repeat 1`, then increase; watch for disconnects (the tool reports them),
- `--no-response` (write-without-response) is faster but hides delivery failures,
- payloads are capped at 512 bytes per invocation on purpose — long fuzz storms can
  brick firmware, and a bricked unit ends the audit,
- keep `--dry-run` in your notes so the exact frames are reproducible.

### Scenario C — command-injection surface review (report material)

For each characteristic flagged `WRITE`, `WRITE_NR` or `MEDIA_CTRL`, record:
UUID + handle, properties, whether writes require authentication/bonding (pairing
behaviour), and whether the same action is reachable *without* the companion app.
Writable media control without pairing is the classic finding: anyone in radio range
can control playback. Bluescan's `profile` output and the JSON form
(`--json`) are designed to paste straight into a report.

## Protocol reference

AVRCP PASS THROUGH operation ids (AVRCP 1.3+ / AV/C Panel Subunit; identical in
BlueZ, Android `avrc_defs.h`, Zephyr `bt_avrcp_opid_t` and Infineon
`wiced_bt_avrc_defs.h`):

| Action | Operation ID | AV/C frame (Bluescan `--frame avc`) | AVCTP packet (label 2, `--frame avctp`) |
| --- | --- | --- | --- |
| `play` | `0x44` | `00 48 7C 44 00` | `20 11 0E 00 48 7C 44 00` |
| `stop` | `0x45` | `00 48 7C 45 00` | `20 11 0E 00 48 7C 45 00` |
| `pause` | `0x46` | `00 48 7C 46 00` | `20 11 0E 00 48 7C 46 00` |
| `next` (FORWARD) | `0x4B` | `00 48 7C 4B 00` | `20 11 0E 00 48 7C 4B 00` |
| `prev` (BACKWARD) | `0x4C` | `00 48 7C 4C 00` | `20 11 0E 00 48 7C 4C 00` |
| `volume_up` | `0x41` | `00 48 7C 41 00` | `20 11 0E 00 48 7C 41 00` |
| `volume_down` | `0x42` | `00 48 7C 42 00` | `20 11 0E 00 48 7C 42 00` |
| `mute` | `0x43` | `00 48 7C 43 00` | `20 11 0E 00 48 7C 43 00` |

> **Two corrections to widely-copied folklore**
>
> 1. **`pause` is `0x46`, not `0x43`.** `0x43` is **mute**. Sending `0x43` to pause
>    mutes the device instead.
> 2. A spec-correct AV/C frame is **five** bytes: it includes the Panel subunit octet
>    `0x48` (= `subunit_type 0x09 << 3`). The common four-byte `00 7C 44 00` form drops
>    that octet; Bluescan sends the spec form by default and offers
>    `--frame avc4` for vendor points that expect the short form.

Frame anatomy (spec form):

```
byte 0  ctype                    0x00 = CONTROL
byte 1  subunit_type + id        0x09 << 3 | 0 = 0x48 (Panel, id 0)
byte 2  opcode                   0x7C = PASS THROUGH
byte 3  state | operation_id     bit 7 = released (0x80), bits 6-0 = operation id
byte 4  operation data length    0x00 (no operands)
```

Sending a press (`0x44`) then a release (`0xC4`) is what Bluescan does by default;
`--no-release` sends only the press, which is useful for long-press/auto-repeat
behaviour. `--frame avctp` prepends the 3-byte AVCTP header
`<transaction label><0x11><0x0E>` (PID 0x110E = AVRCP).

LE Audio devices may instead expose the **Media Control Service** (`0x1848`) with a
**Media Control Point** (`0x2BA4`), or the **Volume Control Service** (`0x1844`) with a
**Volume Control Point** (`0x2B7E`). Bluescan detects which one is present and encodes
the matching one-byte opcode (e.g. MCS play = `0x01`, VCS volume up = `0x00`) instead of
an AV/C frame.

## How it maps to real devices

| Device exposes | Bluescan does | Notes |
| --- | --- | --- |
| `0xAE02` vendor media point | AV/C PASS THROUGH (default `--frame avc`) | the pass-through UUID used by several BLE audio bridges |
| MCS `0x2BA4` (LE Audio) | MCS Media Control Point opcodes | play/pause/stop/prev/next (+ FF/rewind) |
| VCS `0x2B7E` (LE Audio) | VCS volume up/down | mute is not part of VCS; use AVRCP or `raw` |
| No media characteristic | clear refusal + writable candidates listed | nothing is guessed or blind-written |

**Limits worth knowing before you plan an audit:**

- AVRCP and A2DP are **Classic** profiles running over AVCTP/L2CAP, not GATT. A phone or
  speaker that implements AVRCP only in Classic mode will *not* accept these frames over
  BLE — Bluescan tells you when no control point exists instead of pretending success.
  For Classic, use BlueZ tooling (`bluetoothctl`, `btmon`) or a dedicated AVCTP client.
- `scan` sees **BLE advertisers**. Classic-only devices appear only if they also
  advertise over BLE; use `bluetoothctl scan on` for the Classic inquiry.
- Bluetooth MAC addresses are randomised on many modern devices; a rotating address can
  point at a different device between sessions.

## Output, logging and audit trail

- Colour-coded tags: `[INFO]` operations, `[WARN]` recoverable issues, `[ERROR]`
  failures, `[AUDIT]` every successful control frame with its bytes and latency.
- `-v/--verbose` adds debug lines (subscriptions, disconnects, bleak internals).
- `--json` emits machine-readable results (scan, profile, media, takeover, raw).
- Every active action is appended to `bluescan-audit.log` (JSONL, override with
  `--audit-log`): timestamp, command, target, characteristic, payload bytes and outcome.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `permission denied` (Linux) | `sudo usermod -aG bluetooth $USER` (re-login), or grant capabilities to the Python binary |
| `Bluetooth stack unavailable` | install/start BlueZ (`sudo systemctl start bluetooth`), confirm `ls /sys/class/bluetooth` |
| `device not found` / hangs at connect | device asleep, in range but not advertising, or already connected to another host |
| `UUID mismatch` | run `profile <MAC>`; use `--char` or `raw` with the real UUID |
| `connection refused/failed` | another host holds the link, or the device rejects unpaired GATT sessions — pair first |
| `operation timed out` | firmware busy; retry, power-cycle the peripheral, or raise `--write-timeout` |

## Development

```bash
cd bluescan
pip install -r requirements-dev.txt
python -m pytest -q                 # 59 tests, no hardware required
black --line-length 100 bluescan.py tests/
```

Tests cover: payload bytes against captures (`20 11 0E 00 48 7C 44 00`), operation-id
table, fingerprinting rules, hex/MAC parsing, chunking, error mapping, argparse
contracts, the consent gate, and the full controller flow against an in-memory fake
client plus `--dry-run` end-to-end runs.

Structure (single file, organised in sections): protocol constants → errors →
dataclasses → pure builders/parsers → logging → `BluetoothMaster` (`scan`, `profile`,
`send_avrcp`, `media`, `simulate_takeover`, `raw_inject`) → argparse CLI → `main`.

## Legal

Bluetooth auditing is regulated in most jurisdictions. Use Bluescan only on devices you
own or have explicit written authorisation to test. The authors accept no liability for
misuse or for damage to devices caused by fuzzing.
