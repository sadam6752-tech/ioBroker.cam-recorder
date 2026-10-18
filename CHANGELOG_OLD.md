# Older changes

### 0.3.0 (2026-10-18)

- (sadam6752-tech) A further event while a clip is being cut from the pre-recording extends the clip (up to the new
  setting _Maximum clip length_, default 30 s) instead of being ignored
- (sadam6752-tech) Snapshots come from the pre-recording while it runs: instant, without a second stream, and showing
  the moment of the event; `live: true` in `sendTo` asks the camera
- (sadam6752-tech) Examples in README, code and tests are English only, guarded by a test
- (sadam6752-tech) js-controller 7.0.7 or newer is required
- (sadam6752-tech) Trigger conditions: a trigger fires only while another state has a value (e.g. nobody at home);
  a skipped event starts no cooldown
- (sadam6752-tech) Further notification targets besides Telegram: email, Pushover, Discord, Matrix, Signal, WhatsApp,
  Gotify, ntfy, and any other adapter through a JSON template; the trigger column "Telegram" is now "Notify"

### 0.2.0 (2026-10-17)

- (sadam6752-tech) Pre-recording: clips can contain the seconds before the event (off by default, set per camera,
  stream copy without re-encoding, restarted automatically when the camera fails)
- (sadam6752-tech) Fixed: re-encoded clips were shorter than set (a 5 s clip of a DoorBird held about 3 s), because the
  length counted from the connection and not from the first picture after the next key frame
- (sadam6752-tech) The log line of a clip names the length of the written file
- (sadam6752-tech) A warning names the reason when a clip starts at the event although pre-recording is set

### 0.1.0 (2026-10-17)

- (sadam6752-tech) Initial release: MP4/GIF clips and JPEG snapshots from RTSP cameras with a bundled ffmpeg,
  triggers, Telegram, encrypted camera passwords,
  `{date}` in the Telegram caption, a log line for every saved file and every Telegram message
