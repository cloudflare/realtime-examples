# Realtime SFU and TURN DataChannels in Go

> Example status: **Legacy**
>
> This command-line example accepts API credentials as arguments and currently
> logs generated TURN credentials. Use only short-lived test credentials in an
> isolated environment.

This Go example connects Pion PeerConnections through Cloudflare TURN and
exchanges DataChannels through Cloudflare Realtime SFU.

## Building

Run:

```bash
go build
```

## Executing

The program requires separate TURN and Realtime SFU credentials:

```bash
./sfu-turn-go <turn-api-token> <turn-account-id> <sfu-api-token> <sfu-app-id>
```

Command-line arguments may be visible in shell history and process listings.
