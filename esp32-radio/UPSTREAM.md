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

The example also adopts the [firmware and Worker dependency update](https://github.com/zllovesuki/esp32-radio/commit/eb5fa16f902accbf3de1438ef82430ed2693d2ef)
and the [ICE candidate parsing fix](https://github.com/zllovesuki/esp32-radio/commit/a99df367ba817cdca4bf105997cdd0f98d7187da).
The vendored str0m 0.25.0 accepts either order of `ufrag` and `generation` in
an SDP answer. The upstream per-song bitrate option is not part of this import.

First-party application files use the [MIT license](LICENSE).
Third-party code, fonts, fixtures, and downloaded dependencies retain their
original licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md) and the notices beside the vendored components.

The example preserves the firmware, browser, Worker, protocols, vendor patches,
and setup helpers, with example deployment defaults and documentation for
embedded SFU integration. Historical experiments remain upstream. Credentials,
music, flash backups, firmware images, toolchain downloads, and generated
artifacts are excluded; test fixtures retain their source notices.
