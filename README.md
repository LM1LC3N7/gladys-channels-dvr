# gladys-channels-dvr

[Gladys Assistant](https://gladysassistant.com) external integration for
**Channels DVR**: the recordings (in progress, upcoming) and the disk of a
Channels DVR Server, and the Channels apps of your TVs (pause, resume, stop,
mute, channel), on the local network, no account.

Unofficial, not affiliated with Fancy Bits (Channels). **Never tested with a
real Channels**: written from the official Server API and Client API
documentation, tested against simulated servers.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Built on [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
  0.16; Gladys 5.3.0 or later (country filter, music types).
- Store countries: United States, Canada, United Kingdom (the official list of Channels).

## Development

```bash
npm install
npm test               # node --test, against the SDK's fake Gladys
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
npm run validate:manifest
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the decisions and what comes next.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
