# Public test certificate

This self-signed P-256 certificate and SEC1 DER key are public synthetic fixtures
for local transport tests and the opt-in `crypto-self-test` firmware image.
The diagnostic image uses them to test crypto adapters; they are absent from
normal firmware builds. Device sessions use a fresh key generated on the board.
Never use the fixture key as a deployed device's identity.
