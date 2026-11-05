# BR Comms

Self-hosted, browser-based intercom for live productions. Crew join from their phone's browser and get a list of everyone in the room, with **Talk** / **Listen** toggles per person and per group, plus **Push-to-Talk**, **Latch** and **Reply** buttons. Nothing to install: one Docker container, one site password.

- **Rooms** expire after 24h, or can be permanent. Invite crew with a link or QR code; joining that way skips the site password.
- **Join fields:** when you create a room you choose whether people enter a **name**, a **role** (from a list you define), or **both**.
- **Rejoining:** a disconnected person stays in the list, shown as offline. Reopening the link on the same device rejoins automatically. On a new device, they tap their name under "Rejoin as".
- **Groups:** "Everyone" is built in. Each role becomes a group automatically, and admins can create custom groups.
- **Talking:** **PTT** (hold) or **Latch** (toggle) talks to whoever you've toggled on. **Hold any row** to talk to just that person or group. **Reply** (hold) talks back to whoever spoke to you last.
- **Per-person view:** the row of whoever is talking to you lights up. Each row has its own volume (0–200%) and a connection-quality indicator.
- **Admins:** the room creator, plus anyone who enters the room's admin PIN. Admins can rename people or change their roles, lock or edit anyone's routing, kick people, add or remove admins, extend expiry or make a room permanent, issue a new invite link, and end the room.
- **Program feed:** a laptop or desktop can join as a listen-only, full-quality (stereo, no echo cancellation) audio source. It is **off by default**, and each person turns it on with its Listen toggle.
- **Installable PWA:** use "Add to Home Screen" for a full-screen app.
- **Desktop:** hold **Space** for PTT.

## Quick start

```yaml
# docker-compose.yml
services:
  br-comms:
    image: ghcr.io/bentonraymer/br-comms:latest
    restart: unless-stopped
    environment:
      SITE_PASSWORD: change-me
      ANNOUNCED_ADDRESS: comms.example.com   # public IP or hostname of this server
    ports:
      - "3000:3000"          # web UI + websocket (behind your reverse proxy)
      - "40000:40000/udp"    # audio
      - "40000:40000/tcp"    # audio fallback
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

Then open `https://comms.example.com`, enter the site password, and create a room.

## Networking: read this

There are two kinds of traffic:

| Traffic | Port | Path |
|---|---|---|
| Web app, API, signaling (WebSocket) | `3000/tcp` | **Through your reverse proxy** (HTTPS) |
| Audio (WebRTC) | `40000/udp` + `40000/tcp` | **Directly to the server, not through the proxy** |

1. **HTTPS is required.** Browsers only allow the microphone on `https://` (or `localhost`). Your proxy must terminate TLS and support WebSockets.
2. **Open and forward the media port** (`40000` UDP and TCP by default) from the internet to the host. If you change `RTC_PORT`, change the port mappings too.
3. **Set `ANNOUNCED_ADDRESS`** to the public IP or hostname that phones use to reach port 40000. A hostname is resolved to an IP at startup (falling back to public DNS if the host's resolver can't find it), so restart the container if your dynamic-DNS IP changes. The record must point at the server itself: if you use Cloudflare, keep it **DNS only** (grey cloud), or just use the server's IP.

### Caddy

```caddy
comms.example.com {
    reverse_proxy localhost:3000
}
```

Caddy proxies WebSockets automatically.

### Nginx Proxy Manager

Add a proxy host for `comms.example.com` → `http://<host>:3000`, turn on **Websockets Support**, and request an SSL certificate.

### Traefik (labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.comms.rule=Host(`comms.example.com`)
  - traefik.http.routers.comms.tls.certresolver=letsencrypt
  - traefik.http.services.comms.loadbalancer.server.port=3000
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SITE_PASSWORD` | **required** | The single password for the site (create rooms, see the room list). |
| `ANNOUNCED_ADDRESS` | auto-detected LAN IP | Public IP or hostname for audio. Set this in Docker. |
| `RTC_PORT` | `40000` | UDP + TCP port for all audio. |
| `PORT` | `3000` | HTTP port. |
| `ROOM_TTL_HOURS` | `24` | Lifetime of non-permanent rooms. |
| `DATA_DIR` | `/data` | SQLite database location (rooms, slots, groups, routing). |
| `SESSION_SECRET` | auto | Cookie signing secret. Generated and stored in the database if unset. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | — | Optional: serve HTTPS directly (e.g. LAN use without a proxy). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

## How routing works

Audio flows from **A** to **B** only when all of these are true:

- **A is talking:**
  - A is holding PTT or has Latch on, and B is in A's Talk toggles (directly or through a group); or
  - A is holding B's row, holding a group that contains B, or holding Reply with B as the last talker.
- **B is listening to A.** Listen is on by default for people and off by default for program feeds. A per-person Listen setting overrides a group setting.

The server pauses every forwarded stream that doesn't meet these rules, so muted audio never reaches the phone at all. Each person sets their own toggles, and admins can edit or **lock** anyone's routing ("⋯" on a row → *Edit their routing* / *Lock routing*). New members start with Talk → Everyone enabled.

## Phone tips and limitations

- **Keep the app in the foreground.** iOS and Android may suspend audio when the screen locks or you switch apps. The app requests a screen wake lock, so leave the screen on. Installing it to the home screen helps.
- **Bluetooth headsets work.** While the mic is active, phones switch Bluetooth into "headset" mode, which is lower fidelity but full duplex. Bluetooth adds roughly 100–200 ms of latency.
- If you hear nothing on a device, open **Menu → Compatibility audio** and reload. This uses plain audio elements, so per-person volume is ignored on iPhone.
- **Room size:** designed for up to about 30 people per room. Typical rooms are 3–15.

## Development

```bash
npm install
SITE_PASSWORD=test npm run dev     # server on :3000, Vite on :5173 (proxies /api and /ws)
npm test                           # routing engine unit tests
npm run typecheck
npm run build && SITE_PASSWORD=test npm start
```

Layout:

```
server/src/   Fastify HTTP + WebSocket signaling (hub.ts), mediasoup SFU (media.ts), SQLite store
shared/       protocol types + the pure routing engine (routing.ts)
web/src/      React client: client/intercom.ts (WebRTC + signaling), client/mixer.ts (Web Audio), pages/, components/
```

## Publishing the image to GHCR

The workflow in `.github/workflows/publish.yml` typechecks, tests, and builds multi-arch images (`linux/amd64`, `linux/arm64`). It pushes:

- `ghcr.io/<owner>/br-comms:latest` on pushes to `main`;
- `:X.Y.Z` and `:X.Y` tags when you push a `vX.Y.Z` git tag.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

GHCR packages are private by default. To let others pull without logging in, open **GitHub → Packages → br-comms → Package settings** and make the package public.
