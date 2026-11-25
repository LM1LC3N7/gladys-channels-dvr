# Third-party notices

No third-party code is ported nor copied in this integration. It talks to
Channels DVR Server and to the Channels apps through their HTTP APIs, written
from the official documentation of Fancy Bits:

- Server API: <https://getchannels.com/docs/server-api/introduction/> (jobs:
  `GET /api/v1/jobs`), read on 2026-11-25;
- Client API: <https://getchannels.com/docs/apps/automation/channels-api/>
  (`GET /api/status` and the commands), read on 2026-11-25.

The disk space (`GET /dvr`, `disk.free` / `disk.total` / `disk.used`) is not
in those pages: its shape comes from a how-to of the Channels community
forum (a Home Assistant `rest` sensor), no code taken.

Channels and Channels DVR are trademarks of Fancy Bits, LLC. This integration
is unofficial and not affiliated with Fancy Bits.

The only runtime dependency, `@gladysassistant/integration-sdk`, is
Apache-2.0 and installed by npm.
