# AirsoftMap

Live team tracking and a shared tactical intel map for airsoft games, built to
be self-hosted on your own site. Open it in a phone browser, join a game code,
and everyone on that code sees each other move in real time.

It also works where GPS does not: indoors, in tunnels, and underground.

<p align="center">
  <img src="docs/screenshot.png" width="32%" alt="Marker palette over a live squad" />
  <img src="docs/fix-position.png" width="32%" alt="Fixing position without GPS" />
  <img src="docs/settings.png" width="32%" alt="Positioning and site plan settings" />
</p>

## What it does

- **Live positions.** Every player's blip shows callsign, team colour and
  heading, with a ring showing how accurate the position actually is. Blips go
  grey when a fix goes stale, so you can tell "he's over there" from "he was
  over there five minutes ago".
- **Shared intel markers.** 18 marker types (spawn, rally, objective, ammo,
  medic, overwatch, cover, contact, enemy, hazard, no-go, direction, safe zone,
  chrono, parking, station...) dropped at the crosshair or by holding a finger
  on the map. Everyone sees them instantly and they persist between games.
- **Drawing.** Lines and arrows for pushes and directions, filled zones for
  objectives, and a dashed boundary for the edge of your land. Each shows its
  length or perimeter as you draw.
- **One-finger crosshair.** On a phone, one finger drags the crosshair and two
  fingers move the map, so you can put a marker exactly on a gate or a treeline
  without your thumb covering the spot. Everything that drops something —
  markers, pings, position fixes — lands under the crosshair.
- **Roster.** Range and compass bearing to every player, last-fix age, battery
  and reported status. Tap a name to jump to them.
- **Status reports.** IN PLAY / HIT / NEED HELP / RESPAWNING, one tap.
- **Map pings.** Ping a spot and everyone's map flashes there.
- **Team-only games.** Optionally lock the game so each team sees only its own
  players and its own intel. Safety and site information stays visible to
  everyone, and marshals see the lot.
- **Offline maps.** Cache the imagery for your site before you lose signal.
- **Demo mode.** A simulated squad and sample intel, so you can show people what
  it does with no GPS and no other players.

## Running it

```bash
npm install
npm start            # http://localhost:8080
```

Environment variables: `PORT` (default 8080), `HOST` (default 0.0.0.0),
`DATA_DIR` (default `./data`, where markers, drawings and site plans live).

### Getting it on phones

Browsers only give a web page GPS **and** a service worker over HTTPS (or on
`localhost`). Pick whichever fits:

| Setup | Good for |
| --- | --- |
| A VPS or home server behind Caddy/nginx with a real certificate | Public sites, players on mobile data |
| `cloudflared tunnel --url http://localhost:8080` | A quick HTTPS URL with no port forwarding |
| A Raspberry Pi or laptop on site with a battery WiFi router | Sites with no mobile signal at all |

Then send everyone `https://your-host/?room=YOURGAME` — the link pre-fills the
game code. On Android and iOS, "Add to Home Screen" installs it as an app.

## Sites with no signal

Everything below is about the two separate problems a site like a quarry, a
warehouse or a tunnel complex gives you. They are worth keeping apart, because
they have different answers.

### Problem 1: the phones cannot reach each other

Nothing here needs the internet — only that every phone can reach *one server*.
Put that server on site:

- A Raspberry Pi (or any laptop) running `npm start`, plugged into a
  battery-powered WiFi router. Players join the router's WiFi and open the
  server's address. No SIM, no coverage, no cloud.
- WiFi carries a long way down a tunnel — the tunnel acts as a waveguide — but
  will not go through rock or thick walls. Chain a couple of cheap access points
  along the route if you need to cover corners.
- A phone hotspot works for a small group in one area.

The app is built for a link that comes and goes: positions are dropped rather
than queued when the socket is down (a five-minute-old position is a lie, not
data), the connection retries by itself, and the moment it comes back your
current position is pushed again. Markers, drawings and site plans you make
while disconnected are queued and sent when the link returns.

For genuinely huge sites with no line of sight, the honest answer is that WiFi
is not enough and you want a LoRa mesh (Meshtastic and similar) for position
beacons. AirsoftMap does not do that today.

### Problem 2: the phones cannot see satellites

Underground there is no GPS at all, and near buildings there is something worse
than none: a fix that looks confident and is 80 metres out. So the app treats
position as something with a *source* and an *error*, not as a fact.

**Set the mode in Settings → POSITIONING:**

- **AUTO** — GPS while it is any good, dead reckoning from the last known point
  when it is not. For outdoor sites with patchy cover.
- **INDOOR** — ignore GPS completely. For buildings, tunnels and underground.
- **MANUAL** — nothing moves your blip but you.

**A site plan instead of satellite imagery.** Upload a survey drawing, a floor
plan, a hand sketch, or a photo of a whiteboard map (Settings → SITE PLAN),
then scale, rotate and drag it into place. Everyone sees the same placement.
Tick "Hide satellite basemap" and the drawing *is* the map. Scale it by lining
two points on the drawing up with two points you can identify on the ground —
a building corner, a gate, a shaft head.

**Stations: the thing that actually makes this work.** Walk the site once and
drop a STATION marker at every junction, doorway and landmark. Then, in the
game, a player taps FIX and taps the station they are standing at. Their
position snaps there, exactly, with a few metres of error.

Three ways to check in, in order of how fast they are with gloves on:

1. **NFC tag** — stick a cheap NFC sticker at each station and write the URL
   `https://your-host/?room=GAME&fix=CODE` to it. Tap the phone to the tag.
   Works in the dark, one-handed. Android Chrome only.
2. **QR code** — open `/print.html?room=GAME` for a printable sheet of tags,
   one QR per station. Laminate them and cable-tie them up. Scanning one with
   the phone camera drops the player straight onto that station.
3. **Tapping the list** — FIX shows every station sorted by how close it is to
   where the app thinks you are. No hardware at all.

**Dead reckoning between stations.** With motion sensors enabled, the app
counts steps from the accelerometer and points them with the compass. Two
details matter, and they are the two things that usually make step-counting
useless:

- *Step length is not a constant.* A creep and a sprint are not the same
  distance. Each step is sized from how hard it hit the floor — Weinberg's
  estimator, where length scales with the fourth root of the acceleration swing
  — so a hard fast step counts for more than a slow careful one.
- *The constant in that estimator is different for every person.* So it is
  calibrated per player, automatically: walk from one station to another, check
  in at both, and the app knows the true distance and the steps taken between
  them, and corrects your stride. Two check-ins is all it takes, and it keeps
  refining as the game goes on.

Even so, dead reckoning drifts, and the compass is unreliable near steel
(the app warns you when the compass is swinging). So the error is drawn, not
hidden: a dashed circle around your blip that grows by roughly a fifth of the
distance walked since your last real fix, and a `DR ±37m` readout in the HUD
and on the roster. Check in at a station and it collapses back to a few metres.
If the compass gives nothing at all, the blip stays put and only the circle
grows, because "we know he moved but not where" is the truth.

**Snap to drawn routes.** In a tunnel you are *in the tunnel*. Draw the
passages as lines on the site plan and turn on "Snap to drawn routes": a
dead-reckoned position within 25 m of a drawn route is pulled onto it, which
removes most of the sideways drift and leaves only the along-the-tunnel error.

**What to expect.** With stations every 50-80 m and route snapping, a squad's
positions stay good enough to answer "which corridor is he in" all game. Without
stations, expect to be 10-20% of the distance walked out within a few minutes.
That is the physics of the method, not a bug — which is why the app shows you
the error rather than a confident dot.

### Running a game underground: the short version

1. Upload the site plan, place it, and tick "Hide satellite basemap".
2. Drop STATION markers at the junctions. Print `/print.html?room=GAME`,
   laminate, and put a tag at each one.
3. Draw the passages as lines. Turn on "Snap to drawn routes".
4. Cache the map tiles (or none needed if the plan is the basemap — it is
   cached with the app).
5. Players set INDOOR, enable motion sensors, and check in at the entrance.

## Running a game above ground

1. Everyone opens the link, picks a callsign and a team colour, and hits DEPLOY.
2. Before the game, drop your spawns, safe zone, chrono point and the boundary
   of the land. They stay put for future games on the same code.
3. During the game, hold a finger on the map to drop a marker where you are
   pointing, or drag the crosshair and use MARK.
4. Marshals: pick the MARSHAL role — with team lock on, marshals see everyone.

## Testing

```bash
npm test             # both suites
npm run test:smoke   # two browsers join a game and check they see each other
npm run test:indoor  # station check-ins, dead reckoning, team lock, site plans
```

The indoor suite drives the step detector with synthetic accelerometer events
and asserts the blip moves a plausible distance in the right direction, that
uncertainty grows, and that a check-in resets it.

Requires Chromium; set `CHROMIUM_PATH` if Playwright's own download is not used.

## How it works

- `server.js` — Express static server plus a WebSocket relay. Game state lives
  in memory; markers, drawings and site plans are written to `data/rooms.json`
  so they survive a restart. No database, no accounts, no tracking.
- `public/js/app.js` — the map, the HUD, and the position engine: everything
  that can say where a player is (satellite fix, station check-in, dead
  reckoned step, hand-placed) funnels through one `setFix` with an honest
  accuracy attached.
- `public/js/pdr.js` — step detection, per-player stride calibration, heading,
  and the drift model.
- `public/js/plan.js` — site plan overlay, scaling, rotation and placement.
- `public/js/net.js` — WebSocket client with reconnect and position replay.
- `public/sw.js` — service worker: caches the app shell, site plans and map
  tiles.

Positions are only ever sent to players sharing your game code, and only while
the page is open.

Imagery &copy; Esri, OpenTopoMap and OpenStreetMap contributors. QR encoding by
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
