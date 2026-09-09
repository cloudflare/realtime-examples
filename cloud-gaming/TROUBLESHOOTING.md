# Troubleshooting

## Start is unavailable

- After deployment, confirm that Cloudflare Access protects the application
  hostname.
- Confirm that the Worker has the correct Access audience and team domain.
- In local development, use a loopback hostname such as `localhost`.

## The game stays in Starting

- Start returns after recording the run. Container acquisition can continue
  asynchronously for up to ten minutes. After its health port is ready, the
  publisher has two minutes to register media and input DataChannels.
- Check the Worker and Container logs for the run correlation identifier.
- Find the last completed `publisher startup phase`.
- Confirm that the Container image built for `linux/amd64`.
- Confirm that the account has Containers available and the selected instance
  type can start.
- Check whether Xvfb, PulseAudio, Crispy Doom, or the Rust publisher exited.
- Confirm that the publisher health listener is accepting requests on port
  `8080`.
- Confirm that the publisher can reach the Container virtual signaling host and
  establish UDP WebRTC connectivity.

Container process readiness and media readiness are separate. The status
becomes **Running** only after the publisher registers media and input
DataChannels.

## The viewer is offline

Authenticate through Access, then select **Start**.

## The viewer cannot connect

- Confirm that the game status is **Running**.
- Confirm that the Realtime SFU secrets are installed on the Worker.
- Check the browser console and Worker logs using the displayed request ID.
- Confirm that the viewer cap has not been reached.
- Retry to create a fresh viewer PeerConnection and Realtime SFU session.

## Video is present but audio is silent

- Select **Enable sound** after a browser interaction.
- Confirm that Crispy Doom is writing to the private PulseAudio sink.
- Check that the publisher registered and is sending the Opus track.
- Inspect the browser PeerConnection state and inbound audio statistics.

## Audio is present but video does not advance

- Check that Xvfb is running with the expected dimensions and pixel format.
- Check the native publisher for capture or H.264 encoder errors.
- Confirm that the browser received a video track rather than only a successful
  signaling response.
- Retry the viewer connection to request a fresh keyframe.

## Take control is unavailable

- Confirm that the game is **Running** and the browser has an active viewer
  connection.
- Another tab may hold control. Wait for release or viewer expiry rather than
  attempting to replace it silently.
- Touch-only browsers can view but do not expose keyboard and pointer control.

## Keyboard or mouse input has no effect

- Wait until both DataChannels are open and the publisher acknowledgment has
  arrived.
- Click the game surface to focus it and capture the pointer.
- Confirm that the viewer heartbeat is still succeeding.
- Use **Send Esc** to open the Freedoom menu. Physical `Escape` is reserved
  for releasing browser pointer lock.
- Press `Escape` to release pointer lock, then click the game again.
- Release and reclaim control to reapply `canReply` to the existing channels.

The reliable channel carries keys, buttons, wheel, and reset. Pointer motion
uses an unordered channel with `maxRetransmits: 0`, so individual movement
updates may be dropped.

## Control stopped after switching tabs

The browser sends a reset when it loses the active game surface. Return to the
controlling tab and click the game again. If the viewer expired, reconnect and
select **Take control**.

## The Container stopped while idle

The blueprint intentionally stops an inactive Container. Viewer and controller
heartbeats renew activity; status polling and publisher heartbeats alone do
not.

Use **Start** to create a new run.

## Stop did not finish

- Stop schedules cleanup and returns immediately. Wait for the status poll to
  show the completed transition.
- Check whether cleanup is pending for Realtime SFU tracks or DataChannels.
- Confirm that the native publisher handled `SIGTERM`.
- If graceful stop cannot complete, the Container lifecycle may use its bounded
  forced-stop fallback.
- After confirmed Container shutdown and bounded explicit attempts, terminal
  cleanup relies on Realtime SFU inactivity expiry rather than blocking the
  slot indefinitely.
