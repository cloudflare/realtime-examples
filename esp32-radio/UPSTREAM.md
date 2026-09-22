# Source and attribution

Adapted from
[Pocket Radio](https://github.com/zllovesuki/esp32-radio/tree/cadd553c823ef541641bcbe9784ef1dea63502e3),
revision `cadd553c823ef541641bcbe9784ef1dea63502e3`.

The Worker also adopts the
[publisher lifecycle simplification](https://github.com/zllovesuki/esp32-radio/commit/83c06177411720c110b1f90079f2827f8a478d9f),
revision `83c06177411720c110b1f90079f2827f8a478d9f`. The example keeps
request-level SFU errors unresolved during cleanup and controller revocation,
matches item-level absence to requested resources, and bounds diagnostic codes.
See the [integration notes](ERRATA.md#worker-session-cleanup-and-leases).

First-party application files use the [MIT license](LICENSE).
Third-party code, fonts, fixtures, and downloaded dependencies retain their
original licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md) and the notices beside the vendored components.

The example preserves the firmware, browser, Worker, protocols, vendor patches,
and setup helpers, with example deployment defaults and documentation for
embedded SFU integration. Historical experiments remain upstream. Credentials,
music, flash backups, firmware images, toolchain downloads, and generated
artifacts are excluded; test fixtures retain their source notices.
