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

The camera name becomes the object id: `Haustür` → `cam-recorder.0.cameras.haustuer`.

### Triggers

| Column    | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| State     | Any state, e.g. `doorbird.0.Doorbell.1.trigger` or `doorbird.0.Motion.trigger`          |
| Camera    | Name of a camera of the first tab                                                       |
| Action    | Video clip, snapshot, or both (both run at the same time, the photo arrives first)      |
| Duration  | Seconds, 0 = value of the _Recording_ tab                                               |
| Format    | MP4 video, GIF animation, or _Default_                                                  |
| Condition | _Value is true_ (default) or _Every write_                                              |
| Cooldown  | Seconds in which further writes are ignored (a doorbell pressed three times = one clip) |
| Telegram  | Send the result to the Telegram instance of the _Telegram_ tab                          |

Every write of the state counts, also when the value does not change.

### Recording

Clip length and format, and how MP4 files are made:

- **Re-encode** (default): the clip is scaled (default width 640 px) and encoded with H.264, small files that Telegram
  plays everywhere. This uses CPU for the length of the clip.
- **Copy the camera stream**: almost no CPU, original resolution. The camera has to send H.264.

GIF animations are always re-encoded (width and frame rate on the same tab).

### Telegram

Instance, user (empty = all users of the bot) and caption: `{camera}`, `{date}` and `{time}` are replaced, the date in
the date format of the ioBroker system settings (default caption `{camera} {date} {time}`, e.g.
`DoorBird 17.10.2026 13:22:12`). The adapter passes
the file path to the [Telegram adapter](https://github.com/iobroker-community-adapters/ioBroker.telegram), which sends
MP4 as video, GIF as animation and JPEG as photo. Both adapters must run on the same host.

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

| State              | Meaning                                         |
| ------------------ | ----------------------------------------------- |
| `record`           | Button: record a clip with the default settings |
| `snapshot`         | Button: take a snapshot                         |
| `lastVideo`        | Path of the newest clip                         |
| `lastVideoTime`    | Time of the newest clip                         |
| `lastSnapshot`     | Path of the newest snapshot                     |
| `lastSnapshotTime` | Time of the newest snapshot                     |
| `status`           | `idle`, `recording`, `snapshot` or `error`      |
| `lastError`        | Text of the last error, empty after a success   |

`info.connection` is true when ffmpeg was found and works, `info.ffmpegVersion` shows its version.

## Scripts

The answer comes when the file is complete, so there is no need to wait a fixed time:

```js
on({ id: 'doorbird.0.Doorbell.1.trigger', change: 'any' }, () => {
    sendTo('cam-recorder.0', 'record', { camera: 'Haustür', duration: 5, format: 'mp4' }, result => {
        if (result.error) {
            log(result.error, 'warn');
            return;
        }
        sendTo('telegram.0', 'send', { text: result.file, user: 'User1', caption: 'Doorbell' });
    });
});
```

| Command       | Message                                                                   | Answer                                                          |
| ------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `record`      | `{ camera, duration?, format?: 'mp4' \| 'gif', width?, fps?, telegram? }` | `{ file, size, format, duration, camera, time }` or `{ error }` |
| `snapshot`    | `{ camera, width?, telegram? }` or just the camera name                   | as above, `format: 'jpg'`                                       |
| `listCameras` | –                                                                         | `[{ value, label }]`                                            |

`telegram: true` sends the result to the configured Telegram instance as well.

## Security notes

- Camera passwords are stored encrypted in the instance object, and the camera list is not readable for other
  adapters (`protectedNative`).
- ffmpeg is started without a shell. Logins are removed from every log line, state and answer.
- While ffmpeg runs, its command line (with the camera login) can be seen by other users **of the same machine** in
  the process list (`ps`). ffmpeg cannot take an RTSP login from anywhere else. On a dedicated ioBroker host or in a
  container this is usually acceptable; give the camera a user that may only view the stream.
- Recorded files are not encrypted. Files copied into the ioBroker file storage can be opened by every admin user and,
  depending on its settings, through a `web` instance.

## Planned

- Pre-recording: keep the last seconds before the event (switchable per camera, off by default, for weak systems).

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
