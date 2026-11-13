# Older changes

### 0.5.2 (2026-11-11)

- (sadam6752-tech) Sound: a new column _Sound_ in the camera table takes the sound of the camera into mp4 clips
  (as AAC, also from the pre-recording and with a copied picture); GIFs and snapshots stay silent
- (sadam6752-tech) Device Manager: a camera that is off showed as online. The adapter now checks every camera on the
  network at the start and every minute (state `reachable`), and the card shows that

### 0.5.1 (2026-11-11)

- (sadam6752-tech) The Device Manager also as tab _Devices_ in the instance settings, after _Cameras_

### 0.5.0 (2026-11-11)

- (sadam6752-tech) New tab _Send_ with notification profiles (instance, recipient, attachment, text, template); the
  trigger and timelapse tables choose profiles in one column _Message_ instead of _Notify_ and _Send to_. The
  first start turns the settings of 0.4.x into profiles, once; scripts with `telegram: true` keep working
- (sadam6752-tech) Device Manager: one card per camera with online status, recording now, time of the last clip and
  snapshot, the last snapshot as picture, and the actions "Record now" and "Snapshot" (admin 7 or newer)

### 0.4.5 (2026-11-11)

- (sadam6752-tech) Trigger table easier to read: columns in a new order (state, when, cooldown, condition,
  camera, action, duration, format, notify, send to) with widths that fit, shorter headers _When_ and _Only if_

### 0.4.4 (2026-10-18)

- (sadam6752-tech) Recipients by name: notification targets get a name, triggers and timelapses a column "Send to",
  so for example the two buttons of a door station notify two different people on any messenger

### 0.4.3 (2026-10-18)

- (sadam6752-tech) A variable named like a wait function is renamed (false positive W5051 of the repository checker)

### 0.4.2 (2026-10-18)

- (sadam6752-tech) Built-in notification format for the MAX adapter (clips as video, pictures as image, to a user,
  a group chat or all users); built from the documentation of ioBroker.max, not yet tried with a real MAX bot

### 0.4.1 (2026-10-18)

- (sadam6752-tech) Timelapse: the states `timelapseFrames` (pictures waiting) and `timelapseNextVideo` (time of the
  next video) show the progress

### 0.4.0 (2026-10-18)

- (sadam6752-tech) Timelapse: a picture every few minutes, once a day a video; missed videos are made at the next
  start; pictures from the pre-recording while it runs
- (sadam6752-tech) Copy of every clip, snapshot and timelapse to an SFTP server (NAS), with fingerprint check,
  connection test, maximum age on the server
- (sadam6752-tech) Tables of the settings that arrive as objects (after an update of an older instance) are read

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
