# TURN to TURN example in Go

> Example status: **Legacy**
>
> This command-line example accepts an API credential as an argument and
> currently logs generated TURN credentials. Use only short-lived test
> credentials in an isolated environment.

This Go example fetches Cloudflare TURN credentials, configures two Pion
PeerConnections with relay-only transport, and establishes a DataChannel between
the peers.

## Building

Run:

```bash
go build
```

## Executing

Run the binary with a Cloudflare TURN API token and account ID:

```bash
./turn-go <cloudflare-api-token> <cloudflare-account-id>
```

Command-line arguments may be visible in shell history and process listings.
