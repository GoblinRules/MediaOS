# MediaOS

A TV home screen for a small Linux media box. It boots straight into one remote-friendly screen with your
Jellyfin and Plex libraries, streaming apps, and the box's own settings.

- **Shell:** Electron, React and TypeScript, driven entirely by a remote, keyboard or HDMI-CEC.
- **Playback:** mpv, with hardware decoding on real hardware.
- **Streaming apps:** Google Chrome app windows under the sway compositor.
- **Box:** a Debian installer image that sets up the session, network settings, Bluetooth, the TV remote
  adapter and signed updates.

## Try it on Windows or Linux (mock mode)

Needs Node 22.12 or newer.

```
npm install
npm run dev
```

Away from the box, the shell runs in mock mode with a built-in demo library, so every screen can be tried
without a media server.

## Checks

```
npm run typecheck
npm run lint
npm test
```

## Building the installer image

`os/build/build-remote.sh` builds the image on a Linux box with Docker. Set `MEDIAOS_BUILD_HOST`
(user@host) in the environment or in `os/build/local.env`, which git ignores.

## Updates

Each release on this repository is a signed apt repository. Boxes check the latest release for new packages.

No licence is granted for this code yet.
