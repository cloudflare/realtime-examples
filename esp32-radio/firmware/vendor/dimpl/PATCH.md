# dimpl curve features on ESP-IDF

This is the published dimpl 0.9.0 crate from upstream commit
`c17b3b8b971b6eb2ecf7284f5dc0ecb86680ac4d`. The source and tests come from the
[tagged release](https://github.com/algesten/dimpl/tree/0.9.0). The upstream
MIT and Apache licenses are included.

The [manifest patch](curve-features.patch) selects P-256 and P-384 with ECDH,
ECDSA, PEM and standard-library support on ESP-IDF. It omits their optional
precomputed basepoint tables to keep internal RAM available for FreeRTOS task
stacks. The board uses ESP-IDF for its live elliptic-curve operations. The
on-device crypto self-test also exercises the table-free RustCrypto backend.
Host targets use upstream's curve features.

The firmware workspace and standalone str0m tests pin their dependency graphs
in their respective lockfiles. When upgrading, check the ESP32-S3 feature graph
and rerun the on-device crypto self-test.
