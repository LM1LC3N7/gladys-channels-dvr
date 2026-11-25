# Channels DVR

Follow your **Channels DVR Server** (recordings in progress and upcoming,
space of the recordings disk) and drive the **Channels apps** of your TVs
(pause, resume, stop, mute, channel) from Gladys, on the local network.

Unofficial integration, not affiliated with Fancy Bits (Channels). It has
**never been tested with a real Channels** setup: it is written from the
official documentation of the Server API and of the Client API, and tested
against simulated servers. Reports are welcome.

## What you need

- Channels DVR Server on your network (port 8089), and/or the Channels app on
  an Apple TV, Fire TV or Android TV device (its API listens on port 57000).
- No account, no password: Channels asks for none on the local network. Both
  APIs are plain http; this integration talks to them on your local network
  only.
- Channels and its DVR service are officially available in the United States,
  Canada and the United Kingdom.

## Configuration

- **Channels DVR Server address**: `192.168.1.3` or `http://192.168.1.3:8089`
  (8089 when no port is typed). https, a path or credentials are refused.
  Leave it empty to follow only players.
- **Channels apps (players)**: the addresses of the devices running the app,
  separated by commas, `57000` by default, a name before an equals sign if
  you want one: `Living room=192.168.1.20, Bedroom=192.168.1.21`. Ten at most.
- **Refresh interval**: 15 s to 5 min (30 s by default).

A player is known by its **address**: the Channels app gives no serial number
nor any other identifier. Reserve its IP in your router; a new address
creates a new device in Gladys (the old one stays, without values).

## Devices

**Channels DVR** (read only):

| Feature                | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Recordings in progress | jobs whose time window holds the time of the server, neither skipped nor failed |
| Upcoming recordings    | jobs starting later, not skipped                                                |
| Recording now          | names of the recordings in progress, `—` when none                              |
| Next recording         | name of the next recording, `—` when none                                       |
| Disk free / Disk used  | GB (10^9 bytes), read every 5 minutes                                           |

The time of the **server** decides what is recording (its `Date` header),
not the clock of Gladys. An answer without that header leaves the counts
unknown. The disk comes from `/dvr`, a route outside the documented Server
API: if it does not answer, the disk stays unknown and the recordings are
read anyway.

**Each player**:

| Feature                   | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Playback                  | playing, paused, idle; write `0` pause, `1` resume, `2` stop                 |
| Now playing               | title and episode, empty when nothing plays                                  |
| Mute                      | `1` muted; writable                                                          |
| Channel                   | the channel watched (`12.1` for a subchannel); writing it tunes that channel |
| Channel name              | `—` when no channel is watched                                               |
| Channel up / Channel down | push buttons                                                                 |
| App answering             | `1` the app answers on its port, `0` not                                     |

On Apple TV the app answers only while it is open and in front; on Android
and Fire TV, also in the background once launched. When the port refuses the
connection (the app closed), the player shows _idle_ and an empty title. When
it does not answer at all within a periodic reading (device asleep,
network), only _App answering_
goes to `0`: the other values stay as they were, unknown.

## Commands

- Each command reads the state of the app first, then decides: pausing a
  paused app or tuning the channel already shown sends nothing; resuming
  when nothing plays is refused (tune a channel first).
- A command is answered within about 3.5 s. It succeeds only when the app
  shows the requested state (in its answer, or in one more reading within
  that time). Otherwise Gladys gets the error "sent, without confirmation":
  follow-up readings 1.5 s and 5 s later publish what the app does, and a
  warning is logged if it never shows it. A command the app refuses (HTTP
  4xx) says so; "nothing sent" is said only when no connection was made.
- Commands to one player go one after the other; two players are driven at
  the same time. A command waiting past its time is dropped, not sent late.
- Mute is a toggle in Channels: it is sent only on a state read just before,
  and a second mute change is refused (for up to 6 s) until the first one is
  seen applied.
- Nothing else is ever sent: no recording started or deleted, no settings.

## Readings

- The periodic readings: each target once per interval, a round at a time. The time of each
  attempt is written in `/data` **before** the reading: a restart, a
  reconnection to Gladys or the configuration saved again does not read a
  target sooner than the interval (a new player is read at once). Out of
  these rounds, a command reads its player just before it (and once more
  when its answer does not show it applied), then 1.5 s and 5 s later if
  still not seen.
- The test button reports the last readings; it reads only the targets
  that are due.
- If `/data` cannot be read, the first readings wait one whole interval and
  the file is read again every 10 s; it is not written over meanwhile.

## Status

The integration is shown connected while the server or at least one player
answers (an app that is closed counts as a normal state: when players
refuse the connection, the status says so and suggests an app closed, or a
wrong address or port). It says what does
not answer and why, and which entries of the configuration were ignored.

## Limits

- Not tested on real hardware (see above).
- A pause or a channel change shorter than the interval may be missed by the
  readings (not by the commands).
- A channel number a Gladys number cannot write exactly (`12.10`) is not
  published as _Channel_ (its name is); tuning `12.1` on it is sent, never
  taken for done.
