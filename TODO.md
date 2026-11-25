# TODO — Channels DVR v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-25): Channels DVR Server (jobs of the
      documented Server API, disk from `/dvr`), up to ten Channels apps
      (Client API status and commands); rounds paced by the monotonic clock,
      attempts in `/data` before each reading; commands serialized per
      player, decided on a status read just before, confirmed by the answer
      or follow-up readings; docs en/fr; cover. Tested with unit tests against
      the SDK's fake Gladys, a fake Channels and loopback HTTP servers (real
      clock sped up). **Never tested with a real Channels.**
- [ ] **Milestone 2 — real Channels** (a tester in the US or Canada): record
      real answers as fixtures, fix what differs. To check first:
  - the commands are sent with `POST` (settled in review r1: the method the
    documentation gives, and the one of the official client `pychannels`;
    its curl examples are a shortcut): only to confirm on a real app;
  - the answer of a command: the documentation says the status model is the
    answer of every request; read as the confirmation when it is one;
  - whether `start_time` / `end_time` of a job include the padding, and
    whether a running job ever reads `failed: true` before its end;
  - `/dvr` on current server versions (`disk.free`, `disk.total`,
    `disk.used`), outside the documented API;
  - what the Apple TV app answers in the background (refused, or nothing).
- [ ] **Milestone 3 — more** (not in v1): Bonjour discovery of the apps
      (`_channels_app._tcp`, mDNS through `scanNetwork`); a `playback` scene
      trigger; the `notify` command as a scene action; play a recording.
- [ ] **Milestone 4 — first release**: Docker image, Release workflow, store
      check, the `gladys-assistant-integration` topic at the first release.

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest,
  `docker_image`).
- **SDK `^0.16.1`** (latest on npm, 2026-11-25); **Gladys `>=5.3.0`**:
  `countries` and the music types (`playback_state` writable, `title`,
  `mute`).
- **`countries: ["US", "CA", "GB"]`**: the official list of the "What
  countries" page of Channels (review r1). Its second list (Australia,
  France...) is guide coverage of "Channels for HDHomeRun", not the DVR
  service: not added.
- **No keywords** in the manifest. Categories `multimedia`, `servers`.
- **No secret, no account**: the APIs of Channels take no credential on the
  local network; nothing secret is stored.
- **http only**: both APIs are plain http on the LAN; https (the remote
  access of Channels) is refused with a clear status.
- **Player id = its address** (`player:<host with dashes>[-port]`): the
  Client API gives no identifier. Two addresses with the same slug: the
  second refused. Documented: reserve the IP.
- **Server id = `server:dvr`**, one per integration: a new address keeps the
  device.
- **Server time** from the `Date` header decides what records; no header:
  counts unknown, never our clock.
- **Refused port = app closed = idle**; no answer = unknown (only "App
  answering" 0).
- **Music types on a TV app**, as `capabilities/music.md` says (a TV reports
  what it plays with the `music` types, its controls in `television`):
  writable `playback_state`, `title`, writable `mute`; channel and channel
  up / down in `television`.
- **Periodic readings never faster than the interval** (a command reads its
  player just before, out of turn): attempt times in `/data`, written
  before the reading; the test button and Discovery never read out of turn.
- **No sensitive action**: nothing physical; recording, deleting and
  settings are never sent (`toggle_record`, `play/recording`, `navigate`,
  `notify` not used).
- **Mute is a toggle**: sent only on a fresh status, guarded until seen
  applied (6 s at most).
- **No reference code ported**: written from the official documentation;
  `THIRD_PARTY_NOTICES.md` says so.
- **Rate**: changed values only; held back past 250 states a minute.

## Next patch

- Review minors: see `_lots/lot25/reviews/channels-dvr-r2.md` (relecture du budget de 3,5 s trop tôt : « sans confirmation » pessimiste).
