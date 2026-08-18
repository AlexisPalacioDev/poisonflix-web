# cast-bridge

Discovers the screens on the LAN and throws a URL at them. Four routes, no
session, no dependencies.

## Why this is not part of the BFF

Because of one measurement.

The same `M-SEARCH` datagram, sent from the same host, to the same LAN:

| Where it runs | Devices that answered |
| --- | --- |
| BFF container (docker bridge network) | **0** |
| `network_mode: host` | the Samsung, immediately |

Discovery is multicast — SSDP to `239.255.255.250:1900`, mDNS to
`224.0.0.251:5353` — and multicast does not cross a docker bridge. A container
on `media-automation` can *talk* to a TV whose IP it already knows; it cannot
*find* one. So the part that needs host networking was split off into the
smallest service that could hold it, and everything else (auth, the SPA, the
media library) stayed where it was.

That split is also the reason the BFF still fronts this: `cast-bridge` has no
idea who is calling it.

## The bind address is the security boundary

On host networking there is no port publishing and no network namespace: a
`0.0.0.0` listener is reachable from every phone, laptop and smart lightbulb on
the Wi-Fi, with Caddy and the Jellyseerr session nowhere in the path. Anyone on
the network could launch anything on the television.

So it binds `CAST_BRIDGE_BIND` (default `172.18.0.1`, the docker bridge
gateway): containers on that bridge reach it, the LAN does not. If that address
does not exist on the host the process **exits with a log line** instead of
falling back to `0.0.0.0` — a restart loop is a bug report, a silent fallback is
a hole nobody notices.

## Routes

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/healthz` | — | `{ ok: true }` |
| GET | `/devices` | — | `{ devices: CastDevice[] }` |
| POST | `/play` | `{ deviceId, appUrl, mediaUrl, title }` | `{ ok, needsPairing?, reason? }` |
| POST | `/stop` | `{ deviceId }` | `{ ok, reason? }` |

`/play` takes **both** URLs and the adapter picks: `capability: 'app'` devices
get `appUrl` (they run our app, or a browser), `capability: 'media'` devices get
`mediaUrl` (they play a video file). The caller never has to know which of the
four protocols the living room speaks today.

A device-level failure answers **HTTP 200 with `ok: false` and a `reason` in
Spanish**, because "the TV does not have the app installed" and "accept the
prompt on screen" are things the person holding the phone can act on. Only
caller mistakes get 4xx.

## Protocols

| Protocol | Port | How it plays | Capability |
| --- | --- | --- | --- |
| `ssap` | 3000 | LG webOS: WebSocket, `ssap://system.launcher/open` with the page URL | `app` |
| `dial` | from the `Application-URL` header | `POST <Application-URL>/PoisonFlix` | `app` if the app is installed |
| `dlna` | from the descriptor | SOAP `SetAVTransportURI` then `Play` | `media` |
| `cast` | 8009 | TLS + protobuf, launch `CC1AD845`, then `LOAD` | `media` |

A device found unusable is **listed anyway, with its reason**. "My TV is not in
the list" and "my TV needs the app installed" look identical from the couch, and
only one of them is fixable by the person reading the screen.

The same television can appear more than once (a DIAL entry and a DLNA entry)
with different ids. They are not merged: they do different things.

### Pairing (LG only)

The first cast to a webOS TV makes it show a confirmation dialog. `/play`
answers `{ ok: false, needsPairing: true }` after a couple of seconds rather
than holding the HTTP request open on a human — but the socket stays open in the
background for a minute and a half, so pressing OK late still yields the
`client-key`, which is written to `CAST_DATA_DIR` (`/data`).

**Whatever is mounted at `/data` must be writable by the container's uid.**
Docker creates a missing bind-mount source as `root:root` and this image runs as
`node`, so a first deploy lands exactly there — and the symptom is only that the
television keeps asking for permission, with nothing else looking wrong. The
service probes the directory at startup and logs `scope: "cast.data"` when it
cannot write, which is the line to grep for. The fix on the host is
`mkdir -p <data>/cast-bridge && chown 1000:1000 <data>/cast-bridge`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CAST_BRIDGE_BIND` | `172.18.0.1` | see above |
| `CAST_BRIDGE_PORT` | `8791` | |
| `CAST_DATA_DIR` | `/data` | where the webOS `client-key` is persisted |
| `CAST_CACHE_TTL_MS` | `8000` | a scan costs seconds; the player screen asks often |
| `CAST_SCAN_TIMEOUT_MS` | `2500` | how long one scan listens |
| `CAST_DESCRIPTOR_TIMEOUT_MS` | `2500` | budget per descriptor / DIAL probe fetch |
| `CAST_DIAL_APP` | `PoisonFlix` | the app's name in the TV's app list |
| `CAST_SSAP_PORT` | `3000` | plain `ws://` only — see below |

webOS also listens on 3001, which is the same protocol wrapped in TLS with a
self-signed certificate. The SSAP adapter speaks **plain `ws://` only** (`node:net`,
no TLS), so pointing `CAST_SSAP_PORT` at 3001 produces a handshake that never
completes. Supporting it would mean a second TLS client for no gain on a LAN hop.

## Tests

```
node --test "infra/cast-bridge/**/*.test.mjs"
```

(The glob, not `node --test infra/cast-bridge/`: Node 22 searches a directory
argument, Node 24 treats a positional path as a single file to run — the same
command fails on `infra/bff` there too.)

Everything protocol-shaped is tested without hardware: descriptor parsing,
capability classification, the DNS wire format, WebSocket framing, and the Cast
protobuf round trip. The HTTP tests run a real server against the real handler
with the scan budgets cut to milliseconds, and assert only what cannot depend on
what happens to be switched on in the living room.
