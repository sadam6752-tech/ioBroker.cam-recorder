![Logo](admin/cam-recorder.png)

# ioBroker.cam-recorder

[![NPM version](https://img.shields.io/npm/v/iobroker.cam-recorder.svg)](https://www.npmjs.com/package/iobroker.cam-recorder)
[![Downloads](https://img.shields.io/npm/dm/iobroker.cam-recorder.svg)](https://www.npmjs.com/package/iobroker.cam-recorder)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.cam-recorder.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.cam-recorder.png?downloads=true)](https://nodei.co/npm/iobroker.cam-recorder/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.cam-recorder/workflows/Test%20and%20Release/badge.svg)

## Camera recorder adapter for ioBroker

Records short video clips (MP4 or GIF) and snapshots (JPEG) from RTSP cameras, for example a
[DoorBird](https://www.doorbird.com/) door station, when the doorbell rings or motion is detected, and can send the
result to Telegram.

- **ffmpeg is included.** The adapter brings its own ffmpeg binary (package
  [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)), nothing has to be installed on the system.
- **No passwords in scripts.** Camera logins live in the adapter settings and are stored encrypted. Scripts only name
  the camera.
- **Works without scripts.** A trigger table connects any state (doorbell, motion, a button) to a camera.
- **Kind to small systems.** ffmpeg only runs while a clip is recorded, the number of parallel ffmpeg processes is
  limited, and the camera stream can be copied instead of re-encoded.

## Settings

### Cameras

One row per camera: a name, the RTSP URL, user and password. Examples of RTSP URLs:

| Camera             | URL                                                   |
| ------------------ | ----------------------------------------------------- |
| DoorBird           | `rtsp://192.168.1.20:554/mpeg/media.amp`              |
| Hikvision          | `rtsp://192.168.1.40:554/Streaming/Channels/101`      |
| Reolink            | `rtsp://192.168.1.41:554/h264Preview_01_main`         |
| Most ONVIF cameras | see the manual of the camera or the ONVIF device tool |

A login typed into the URL (`rtsp://user:password@host/...`) is moved into the user and password fields at the next
start. Special characters in passwords are fine, the adapter encodes them for ffmpeg.

_Transport_ is TCP by default; it works reliably also from Docker containers. _Key frames only_ helps when snapshots
of an H.265 camera come out grey.

The camera name becomes the object id: `Front Door` → `cam-recorder.0.cameras.front_door`. Letters with
diacritics are transliterated (`ü` → `ue`, `é` → `e`), other special characters become `_`.

### Triggers

| Column                           | Meaning                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| State                            | Any state, e.g. `doorbird.0.Doorbell.1.trigger` or `doorbird.0.Motion.trigger`                |
| Camera                           | Name of a camera of the first tab                                                             |
| Action                           | Video clip, snapshot, or both (both run at the same time, the photo arrives first)            |
| Duration                         | Seconds, 0 = value of the _Recording_ tab                                                     |
| Format                           | MP4 video, GIF animation, or _Default_                                                        |
| Condition                        | _Value is true_ (default) or _Every write_                                                    |
| Cooldown                         | Seconds in which further writes start no new clip (a doorbell pressed three times = one clip) |
| Notify                           | Send the result to Telegram and the further targets of the _Notifications_ tab                |
| Only if state, Comparison, Value | Optional condition, see below                                                                 |

**Conditions.** A trigger with _Only if state_ fires only while that state compares as set: `=`, `≠`, `>` or `<`
against _Value_. Examples: `0_userdata.0.away` `=` `true` (only when nobody is home), `javascript.0.isNight` `=`
`true`, `hm-rpc.0.ABC.LUX` `<` `50`. A boolean state also matches `1`/`0`, `on`/`off`, `yes`/`no`; texts are compared
without case. The state is read at the moment of the event; a skipped event is logged and starts no cooldown.

Every write of the state counts, also when the value does not change. With pre-recording, a write inside the cooldown
**extends** the clip that is still being cut instead of being ignored: the clip then ends the trigger's duration after
the last ring, up to _Maximum clip length_ on the _Recording_ tab (default 30 s). The log shows it as `extended 2x`.

### Recording

Clip length and format, and how MP4 files are made:

- **Re-encode** (default): the clip is scaled (default width 640 px) and encoded with H.264, small files that Telegram
  plays everywhere. This uses CPU for the length of the clip.
- **Copy the camera stream**: almost no CPU, original resolution. The camera has to send H.264.
  A copied stream can only start at a key frame, while the clip length counts from the connection: with a camera
  that sends a key frame every few seconds, a copied clip is shorter by up to that interval. Re-encoded clips start
  their length at the first picture and keep the full length.

GIF animations are always re-encoded (width and frame rate on the same tab).

### Pre-recording

A doorbell clip that starts when the button is pressed misses the person walking up to the door. With pre-recording
the clip also contains the seconds **before** the event.

- **Off by default.** Switch it on with _Pre-recording_ on the _Recording_ tab, then set _Pre-recording (s)_ (1 to 30)
  for each camera that should use it. Cameras with 0 are not affected.
- **What it costs.** For each such camera one ffmpeg process runs all the time. It copies the camera stream into
  2-second pieces without re-encoding (little CPU, a few MB of disk in the temp folder) and deletes old pieces. The
  camera keeps one stream open permanently — check that it allows a second stream for snapshots and live views.
- **How a clip is made.** At the event the adapter waits until the seconds after the event are on disk, joins the
  pieces and cuts the window _pre-recording + clip length_. A clip is therefore ready about 2 to 4 seconds later than
  without pre-recording. The duration in the trigger table and in `sendTo` is the time **after** the event.
- **Snapshots** come from the buffer while it runs: the newest picture on disk, at most about a second old, without a
  second connection to the camera — instant, and it shows the moment of the event. `sendTo` with `live: true` asks the
  camera instead.
- **When something fails** (camera offline, stream stalled for 20 s), the process is restarted after 5 s, 10 s, 30 s,
  60 s, then every 5 minutes, with a warning in the log. While the buffer is not running, clips are recorded from the
  event on as without pre-recording, with a warning in the log. After a start of the adapter the buffer needs about
  10 seconds (ffmpeg analyses the stream, then waits for key frames) until `prebuffer` shows `running`.
- The pieces go to the system temp folder (`/tmp/iobroker-cam-recorder.0-prebuffer` on Linux) unless you enter a
  folder. A RAM disk (tmpfs) is a good choice on systems with an SD card.

### Notifications

**Telegram:** instance, user (empty = all users of the bot) and caption: `{camera}`, `{date}` and `{time}` are replaced, the date in
the date format of the ioBroker system settings (default caption `{camera} {date} {time}`, e.g.
`DoorBird 17.10.2026 13:22:12`). The adapter passes
the file path to the [Telegram adapter](https://github.com/iobroker-community-adapters/ioBroker.telegram), which sends
MP4 as video, GIF as animation and JPEG as photo. Both adapters must run on the same host.

**Further targets** get the same results. Pick the instance; _Recipient_ is optional (empty = the default of that
adapter):

| Adapter        | What arrives                               | Recipient                                          |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| `max`          | the file (clip as video, picture as image) | user ID, negative group chat ID, empty = all users |
| `email`        | the file as attachment, caption as subject | address                                            |
| `pushover`     | pictures as attachment, a clip as text     | device                                             |
| `discord`      | the file                                   | `serverId/channelId`, a user id or a user tag      |
| `matrix-org`   | pictures, a clip as text                   | –                                                  |
| `signal-cmb`   | text with camera, kind and file name       | phone number                                       |
| `whatsapp-cmb` | text                                       | phone number                                       |
| `gotify`       | text                                       | –                                                  |
| `ntfy`         | text                                       | topic                                              |

For any other adapter enter a **template**: the JSON message for its `send` command, with the placeholders `{file}`,
`{fileName}`, `{fileUrl}`, `{caption}`, `{camera}`, `{format}`, `{duration}`, `{recipient}` and `{text}`, for example
`{"to": "{recipient}", "message": "{caption}", "file": "{file}"}`. A template also replaces the built-in format of a
known adapter. All targets must run on the same host as this adapter, since they read the file from its path.

### Timelapse

One row per camera: a picture every _Interval_ minutes, and once a day at _Video at_ (HH:MM, default 23:55) the
pictures become an MP4 video (_Frames per second_, width of the _Recording_ tab), named
`<camera>_timelapse_<YYYY-MM-DD>.mp4` after the day of its first picture. The pictures are deleted after the video
is made. While the pre-recording runs, the pictures come from the buffer, without a second connection to the camera.

- The button `cameras.<camera>.timelapse` (or `sendTo(…, 'timelapse', 'Front Door')`) makes the video at once.
- If the adapter was stopped at the time of the video, the missed video is made at the next start.
- _Notify_ sends the video to Telegram and the further targets.
- Disk space: one picture per minute at 640 px is about 50 MB a day until the video is made; at most 10 000 pictures
  wait per camera. Old timelapse videos are deleted after the maximum age of the _Storage_ tab.

### NAS (SFTP)

Every new clip, snapshot and timelapse video is copied to an SFTP server (a NAS such as Synology or QNAP, or any Linux
server with SSH), into `<folder>/<camera>/`. The adapter opens the SSH connection itself — no mount, no shell
command.

1. Create a user on the NAS that may only write into the target folder, and enable SFTP.
2. Enter host, port, user, password and folder, then press _Test connection_. It writes and deletes a small test
   file and shows the fingerprint of the server.
3. Enter that fingerprint: from then on a different server is refused before the password is sent. Without a
   fingerprint every copy warns in the log.

How it behaves:

- The copy runs in the background, one file after the other; notifications do not wait for it.
- A file appears on the server under its final name only when it is complete (upload as `.part`, size check, rename).
- A failed copy is logged and shown in `info.remoteError`; it is not retried, the next file is copied again.
  `info.lastRemoteCopy` holds the time of the last good copy.
- _Days kept on the server_ deletes older files of this adapter on the server (0 = keep everything); other files in
  the folders are never touched.
- The password is stored encrypted. The files are not encrypted on the server, only the transfer is.

### Storage

Files are written to `iobroker-data/cam-recorder.<instance>/media/` (or the folder you enter), named
`<camera>_<YYYY-MM-DD_HH-MM-SS>.<mp4|gif|jpg>`. Old files are deleted per camera and kind: the newest _n_ files are
kept (default 20) and nothing older than the maximum age (default 7 days). Other files in the folder are never
touched.

The newest file of each camera and kind is also copied into the ioBroker file storage
(`cam-recorder.0.storage/<camera>.mp4`, `.gif`, `.jpg`), where it can be opened in the admin tab _Files_ or through a
`web` instance.

### Advanced

- **Path of ffmpeg**: empty uses the bundled binary. Enter a path to use an ffmpeg of the system instead.
- **ffmpeg processes at the same time** (default 2): further requests wait. Set 1 on weak systems or for cameras that
  allow only one stream at a time.
- **Camera timeout**: seconds until an unreachable camera counts as failed.

## States

Per camera below `cam-recorder.0.cameras.<camera>`:

| State                | Meaning                                         |
| -------------------- | ----------------------------------------------- |
| `record`             | Button: record a clip with the default settings |
| `snapshot`           | Button: take a snapshot                         |
| `lastVideo`          | Path of the newest clip                         |
| `lastVideoTime`      | Time of the newest clip                         |
| `lastSnapshot`       | Path of the newest snapshot                     |
| `lastSnapshotTime`   | Time of the newest snapshot                     |
| `status`             | `idle`, `recording`, `snapshot` or `error`      |
| `lastError`          | Text of the last error, empty after a success   |
| `prebuffer`          | `off`, `starting`, `running` or `restarting`    |
| `timelapse`          | Button: make the timelapse video now            |
| `lastTimelapse`      | Path of the newest timelapse video              |
| `lastTimelapseTime`  | Time of the newest timelapse video              |
| `timelapseFrames`    | Pictures waiting for the next timelapse video   |
| `timelapseNextVideo` | Time of the next timelapse video                |

`info.connection` is true when ffmpeg was found and works, `info.ffmpegVersion` shows its version.
`info.lastRemoteCopy` and `info.remoteError` report the copy to the SFTP server.

## Scripts

The answer comes when the file is complete, so there is no need to wait a fixed time:

```js
on({ id: 'doorbird.0.Doorbell.1.trigger', change: 'any' }, () => {
    sendTo('cam-recorder.0', 'record', { camera: 'Front Door', duration: 5, format: 'mp4' }, result => {
        if (result.error) {
            log(result.error, 'warn');
            return;
        }
        sendTo('telegram.0', 'send', { text: result.file, user: 'User1', caption: 'Doorbell' });
    });
});
```

| Command       | Message                                                                         | Answer                                                                                                   |
| ------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `record`      | `{ camera, duration?, pre?, format?: 'mp4' \| 'gif', width?, fps?, telegram? }` | `{ file, size, format, duration, pre, extended, fromBuffer, realDuration, camera, time }` or `{ error }` |
| `snapshot`    | `{ camera, width?, live?, telegram? }` or just the camera name                  | as above, `format: 'jpg'`                                                                                |
| `timelapse`   | `{ camera }` or just the camera name                                            | the video as above, or `{ error }` when fewer than two pictures wait                                     |
| `listCameras` | –                                                                               | `[{ value, label }]`                                                                                     |

`telegram: true` sends the result to the configured Telegram instance as well.
`pre` limits the seconds before the event (at most the value set for the camera, `0` = no pre-recording for this
clip); `duration` is always the time after the event, and the answer's `duration` is the whole clip.

## Security notes

- Camera passwords are stored encrypted in the instance object, and the camera list is not readable for other
  adapters (`protectedNative`).
- ffmpeg is started without a shell. Logins are removed from every log line, state and answer.
- While ffmpeg runs, its command line (with the camera login) can be seen by other users **of the same machine** in
  the process list (`ps`). ffmpeg cannot take an RTSP login from anywhere else. On a dedicated ioBroker host or in a
  container this is usually acceptable; give the camera a user that may only view the stream.
- Recorded files are not encrypted. Files copied into the ioBroker file storage can be opened by every admin user and,
  depending on its settings, through a `web` instance.
- The SFTP password is stored encrypted (`encryptedNative`). A connection test with an empty password field uses the
  saved password only for the saved server, so no script can send it to another host.

## ffmpeg license

The adapter is MIT licensed. The bundled ffmpeg binary comes from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
and is licensed under the GPL (it contains libx264). It is started as a separate program and not linked into the
adapter.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (sadam6752-tech) Built-in notification format for the MAX adapter (clips as video, pictures as image, to a user,
  a group chat or all users)

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

## License

MIT License

Copyright (c) 2026 sadam6752-tech <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
