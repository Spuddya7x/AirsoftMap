# AirsoftMap

Live team tracking and a shared tactical intel map for airsoft games, built to be
self-hosted on your own site. Open it in a phone browser, join a game code, and
everyone on that code sees each other move in real time.

![marker palette and live squad](docs/screenshot.png)

## What it does

- **Live positions.** Every player's blip shows callsign, team colour and heading.
  Blips go grey when a fix goes stale so you can tell "he's over there" from
  "he was over there five minutes ago".
- **Shared intel markers.** 17 marker types (spawn, rally, objective, ammo, medic,
  overwatch, cover, contact, enemy, hazard, no-go, direction, safe zone, chrono,
  parking...) dropped at a crosshair or by holding a finger on the map. Everyone
  sees them instantly, and they persist between games.
- **Drawing.** Lines and arrows for pushes and directions, filled zones for
  objectives, and a dashed boundary for the edge of your land. Each one shows its
  length or perimeter as you draw.
- **Roster.** Range and compass bearing to every player, last-fix age, battery,
  and their reported status. Tap a name to jump to them.
- **Status reports.** IN PLAY / HIT / NEED HELP / RESPAWNING, one tap, shown on
  the blip and in the roster.
- **Map pings.** Ping a spot and everyone's map flashes there.
- **Offline map tiles.** Cache the imagery for your site before you lose signal.
- **Demo mode.** A simulated squad and sample intel, so you can show people what
  it does indoors with no GPS and no other players.

## Running it

```bash
npm install
npm start            # http://localhost:8080
```

Environment variables: `PORT` (default 8080), `HOST` (default 0.0.0.0),
`DATA_DIR` (default `./data`, where markers and drawings are persisted).

### Getting it on phones

Browsers only give a web page GPS **and** a service worker over HTTPS (or on
`localhost`). Pick whichever fits:

| Setup | Good for |
| --- | --- |
| A VPS or home server behind Caddy/nginx with a real certificate | Public sites, players on mobile data |
| `cloudflared tunnel --url http://localhost:8080` | A quick HTTPS URL with no port forwarding |
| A Raspberry Pi + battery WiFi router on site, self-signed cert | Sites with no mobile signal |

Then send everyone `https://your-host/?room=YOURGAME` — the link pre-fills the
game code. On Android and iOS, "Add to Home Screen" installs it as an app.

## Running a game

1. Everyone opens the link, picks a callsign and a team colour, and hits DEPLOY.
2. Before the game, drop your spawns, safe zone, chrono point and the boundary of
   the land. They stay put for future games on the same code.
3. During the game, HOLD a finger on the map to drop a marker where you're
   pointing, or use MARK to drop one at the crosshair.
4. Marshals: use a separate game code for the marshal net, or the MARSHAL role.

## Testing

```bash
npm test             # two browsers join a game and check they see each other
```

Requires Chromium; set `CHROMIUM_PATH` if Playwright's own download is not used.

## How it works

- `server.js` — Express static server plus a WebSocket relay. Game state lives in
  memory; markers and drawings are written to `data/rooms.json` so they survive a
  restart. No database, no accounts, no tracking.
- `public/js/app.js` — the map, the HUD, geolocation, and everything you touch.
- `public/js/net.js` — WebSocket client with reconnect and position replay.
- `public/sw.js` — service worker: caches the app shell and map tiles.

Positions are only ever sent to players sharing your game code, and only while
the page is open.

Imagery &copy; Esri, OpenTopoMap, and OpenStreetMap contributors.
