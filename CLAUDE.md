# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Channels DVR: a Node.js service
(Node 22+, ESM, no build step) in its own sandboxed Docker container, talking to
Gladys through `@gladysassistant/integration-sdk`, its only runtime dependency,
and to Channels over plain http on the local network (no credential).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js               SDK wiring only
src/handlers.js        the SDK handlers -> the app (shared with the tests)
src/app.js             ChannelsApp: rounds, commands, status, Discovery
src/config.js          configuration (addresses, players, interval), pure
src/model.js           devices, features and states, pure
src/store.js           /data: the time of the last attempt per target
src/i18n.js            statuses and messages (en, fr)
src/channels/http.js   the only network access (one request, bounded)
src/channels/client.js the calls (jobs, disk, status, commands)
src/channels/parse.js  the answers, read strictly
test/                  node --test, fake Gladys, fake Channels, fake and real clocks
```

## Rules

- **External ids are forever**: `server:dvr`, `player:<address slug>` and the
  feature keys of `src/constants.js`. Never rename one.
- **Unknown stays unknown**: an answer not as documented publishes nothing,
  never a 0.
- **Clocks**: the monotonic clock paces rounds, budgets and guards; the wall
  clock only dates `/data`. The server's `Date` header decides what records.
- **Commands**: decided on a status read just before, answered within 3.5 s,
  a success only when the app shows the requested state, else an error "sent,
  without confirmation"; "nothing sent" only when no connection was made.
- **Periodic readings never faster than the interval**, even after a restart
  (a command reads its player just before, out of turn).
- **Versions** belong to the Release workflow, except 0.1.0 set by hand.
- **Changelog** under `## [Unreleased]`; user texts bilingual (en, fr).
- **Style**: Prettier, ESLint; comments explain why, in English; tests never
  touch the network beyond loopback.
