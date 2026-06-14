# homebridge-nanit-next

Homebridge plugin for Nanit baby cameras with native Apple HomeKit integration.

## Features

- **Live Video Streaming** — View your Nanit camera feed directly in the Apple Home app
- **Three Streaming Modes** — Local (LAN), Cloud (Nanit servers), or Auto (local with cloud fallback)
- **Camera Audio Listen-In** — Listen to room audio through the HomeKit camera view
- **Night Light** — On/off plus brightness slider (0–100)
- **Sound Machine** — On/off plus camera speaker volume slider
- **Sound Track Selection** — Individual switches for the 4 built-in tracks (Birds, Waves, White Noise, Wind)
- **Night Vision** — Force IR on/off (auto mode remains the default in the Nanit app)
- **Sleep Mode** — Toggle the camera's sleep mode
- **Status Light** — Toggle the front status LED
- **Camera Microphone** — Mute/unmute the camera's microphone (affects HomeKit and the Nanit app)
- **Temperature Sensor** — Real-time room temperature
- **Humidity Sensor** — Real-time room humidity
- **HomeKit Secure Video (HKSV)** — Optional motion-triggered cloud recording (experimental)
- **Easy Setup** — Built-in authentication wizard with MFA support in the Homebridge UI

### Two-way talk

Two-way talk is **not supported on Nanit Pro (Gen 2/3) firmware**. The camera's RTSP server only advertises read methods (`PLAY`, `DESCRIBE`, etc.) and rejects audio push. The Nanit iOS app routes talk-back through Nanit's cloud over an HTTPS channel that requires app-only credentials we cannot obtain without intercepting iOS app traffic.

A legacy RTSP-ANNOUNCE talk-back path exists for Gen 1 cameras and can be opted into via `enableTalkback: true`. Leave off otherwise — it will only generate harmless errors in the log on Pro firmware.

## Requirements

- [Homebridge](https://homebridge.io) v1.11+ or v2.0+
- Node.js 20+ or 22+
- [FFmpeg](https://ffmpeg.org/) installed on the system
- A Nanit account with at least one camera

## Installation

### Via Homebridge UI (Recommended)

Search for `homebridge-nanit-next` in the Homebridge UI plugin search and install.

### Via CLI

```bash
npm install -g homebridge-nanit-next
```

## Setup

### 1. Authenticate with Nanit

Open the plugin settings in the Homebridge UI. The built-in setup wizard will guide you through:

1. Enter your Nanit email and password
2. Enter the MFA verification code sent to your phone
3. Done — tokens are saved automatically

Alternatively, you can manually provide a refresh token in the config (see Advanced Configuration).

### 2. Configure Streaming Mode

| Mode | Description |
|------|-------------|
| `auto` (default) | Tries local streaming first, falls back to cloud if the camera is unreachable on LAN |
| `local` | Streams directly from the camera on your local network (lowest latency) |
| `cloud` | Streams via Nanit's cloud servers (works from anywhere) |

For local streaming, you may need to specify your camera's local IP address in the camera configuration.

### 3. Restart Homebridge

After configuration, restart Homebridge. Your Nanit cameras will appear in the Home app with:

- Camera stream (Camera accessory)
- Night Light — Lightbulb (on/off + brightness)
- Sound Machine — Lightbulb (on/off + volume slider)
- Sound: Birds / Waves / White Noise / Wind — Switches (track selection)
- Night Vision — Switch
- Sleep Mode — Switch
- Status Light — Switch
- Camera Microphone — Switch (on = mic active, off = camera mic muted)
- Temperature Sensor
- Humidity Sensor

Each subservice can be individually disabled in the per-camera config.

## Configuration

### Minimal Config

```json
{
  "platforms": [
    {
      "platform": "NanitCamera",
      "name": "Nanit Camera"
    }
  ]
}
```

Authentication is handled via the UI wizard. No credentials need to be in the config file.

### Full Config

```json
{
  "platforms": [
    {
      "platform": "NanitCamera",
      "name": "Nanit Camera",
      "streamMode": "auto",
      "rtmpListenPort": 1935,
      "auth": {
        "refreshToken": "your-refresh-token-here"
      },
      "cameras": [
        {
          "babyUid": "abc123",
          "name": "Nursery Camera",
          "localIp": "192.168.1.100",
          "enableLight": true,
          "enableSound": true,
          "enableSoundTracks": true,
          "enableSensors": true,
          "enableNightVision": true,
          "enableSleepMode": true,
          "enableStatusLight": true,
          "enableMicMute": true
        }
      ],
      "videoConfig": {
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30,
        "maxBitrate": 2000,
        "audio": true,
        "debug": false
      }
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `platform` | string | — | Must be `NanitCamera` |
| `name` | string | `Nanit Camera` | Platform display name |
| `streamMode` | string | `auto` | `auto`, `local`, or `cloud` |
| `rtmpListenPort` | number | auto | Port for local RTMP server |
| `localAddress` | string | auto | Homebridge host LAN IP (only required if auto-detect picks the wrong NIC) |
| `enableHksv` | boolean | `false` | Enable HomeKit Secure Video (experimental) |
| `enableTalkback` | boolean | `false` | Enable legacy RTSP ANNOUNCE talk-back. Pro firmware unsupported — leave off |
| `auth.refreshToken` | string | — | Manual refresh token (alternative to UI wizard) |

#### Per-Camera Options (`cameras[]`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `babyUid` | string | auto | Nanit baby UID |
| `name` | string | auto | Custom display name |
| `localIp` | string | auto | Camera's LAN IP (auto-discovered from cloud if available) |
| `enableLight` | boolean | `true` | Night Light (on/off + brightness) |
| `enableSound` | boolean | `true` | Sound Machine (on/off + volume) |
| `enableSoundTracks` | boolean | `true` | Add 4 individual track switches (Birds/Waves/White Noise/Wind) |
| `enableSensors` | boolean | `true` | Temperature and humidity sensors |
| `enableNightVision` | boolean | `true` | Night vision force on/off switch |
| `enableSleepMode` | boolean | `true` | Sleep mode switch |
| `enableStatusLight` | boolean | `true` | Front status LED switch |
| `enableMicMute` | boolean | `true` | Camera microphone enable/disable switch |

#### Video Options (`videoConfig`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxWidth` | number | `1280` | Maximum video width |
| `maxHeight` | number | `720` | Maximum video height |
| `maxFPS` | number | `30` | Maximum frames per second |
| `maxBitrate` | number | `2000` | Maximum bitrate in kbps |
| `audio` | boolean | `true` | Enable audio streaming |
| `debug` | boolean | `false` | Enable verbose FFmpeg logging |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Link for local testing
npm link

# In your Homebridge config directory:
npm link homebridge-nanit-next
```

## How It Works

This plugin communicates with Nanit cameras using the same protocol as the official Nanit app:

1. **REST API** (`api.nanit.com`) — Authentication, baby/camera discovery, snapshots
2. **WebSocket** (Protobuf over WebSocket) — Real-time sensor data, camera controls, streaming commands
3. **RTMP/RTMPS** — Video streaming (local push or cloud pull)
4. **FFmpeg** — Transcodes the camera stream to SRTP for HomeKit

### Local Streaming

In local mode, the plugin tells the camera (via WebSocket) to push its RTMP stream to a local server running on the Homebridge host. FFmpeg then transcodes this to SRTP for HomeKit. This provides the lowest latency.

### Cloud Streaming

In cloud mode, FFmpeg reads the RTMPS stream directly from Nanit's media servers and transcodes to SRTP for HomeKit.

## Troubleshooting

- **Camera not appearing**: Check the Homebridge logs for authentication errors. Re-run the setup wizard.
- **Stream not loading**: Ensure FFmpeg is installed (`ffmpeg -version`). Try cloud mode if local isn't working.
- **Local streaming issues**: Verify the camera's local IP is correct and reachable from the Homebridge host.
- **MFA not working**: Make sure you enter the code promptly — MFA tokens expire quickly.

## Disclaimer

This plugin uses reverse-engineered Nanit APIs. It is not affiliated with or endorsed by Nanit. Use at your own risk.

## Security Considerations

Because this plugin handles baby monitor cameras, security is particularly important. Please be aware of the following:

- **Local WebSocket TLS**: When connecting to the camera over your local network, TLS certificate verification is disabled (`rejectUnauthorized: false`) because Nanit cameras use self-signed certificates. This means the connection is encrypted but not authenticated — an attacker on your LAN could potentially perform a Man-in-the-Middle attack. Keep your home network secured with a strong Wi-Fi password.
- **Local RTMP server**: In `local` or `auto` streaming mode, the plugin runs an RTMP server that the camera pushes video to. The server validates publisher IPs against known camera addresses. For best security, set the `localIp` for each camera in the configuration.
- **Token storage**: Authentication tokens are stored on disk in the Homebridge storage directory with restricted file permissions (`0600`). Ensure your Homebridge host has appropriate access controls.
- **Reporting vulnerabilities**: See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

MIT
