'use strict';

/**
 * Answer to the message `help`: what an AI agent such as ioBroker.pi-agent needs to
 * use the commands of this adapter. English on purpose: it is read by a language model, which answers the user in the
 * user's language.
 */
const HELP = `cam-recorder records clips (mp4 or gif) and snapshots (jpg) of IP cameras (RTSP/HTTP) with ffmpeg and sends them through the profiles of its tab Send (Telegram, email, Pushover …).

Commands (sendTo cam-recorder.<n>, the answer comes in the callback):
- help: this text.
- listCameras: [{value, label}] with the names of the active cameras. Reads only.
- listProfiles: [{value, label}] with the names of the active send profiles. Reads only.
- snapshot {camera, width?, live?, profiles?}: takes a picture now. camera = name as in listCameras (also a plain string message). width in pixels (0 = original); live: true takes it from the camera and not from the pre-recording. Answer: {file, size, format: "jpg", time, …} or {error}.
- record {camera, duration?, pre?, format?, width?, fps?, profiles?}: records a clip now and answers when it is finished (duration seconds after now, 1-60, default from the settings; pre = seconds before now from the pre-recording; format "mp4" or "gif"). Answer: {file, size, format, duration, time, …} or {error}. It takes as long as the clip, plus a few seconds.
- timelapse {camera} (or the camera name as message): builds the timelapse video of the camera from the frames gathered so far. Answer: {file, …}, or {error} when fewer than two frames wait.

profiles = names of send profiles ("Alex, Family" or an array); without it nothing is sent, the file only lands in the storage folder. A profile with criteria of the tab AI check ("a person") gets the files as always, and an extra message when an AI agent finds a criterion in a snapshot. When a check ran, the answer has "description" with what the agent saw.

States per camera (cam-recorder.<n>.cameras.<id>.): record, snapshot, timelapse (buttons, write true), lastVideo, lastSnapshot, lastTimelapse (paths), status (idle, recording, snapshot, error), lastError, reachable (camera answers on the network), description (last text of the AI check), prebuffer.

Schedule per camera (cam-recorder.<n>.cameras.<id>.schedule.), write the states (ack false), the adapter checks and applies them at once: enabled (true/false, the main switch), interval (every N minutes counted from midnight, 0 = off, 30 = at :00 and :30), from and to ("HH:MM", the interval runs only between them, also over midnight like 22:00 to 06:00; both empty = all day), cron (five fields "minute hour day month weekday", e.g. "0 7,19 * * *" = 7:00 and 19:00, "*/15 * * * 1-5" = every 15 min on weekdays; empty = off), action (snapshot, record or both), profiles (names of send profiles, empty = only saved). next (read only) is the time of the next run in ms, 0 = none; check it after a change. A wrong value is reported in the log and that part does not run. Each run works like a trigger: files, profiles and the AI check.

How to talk to the user:
- If the user did not name a camera and there are several, call listCameras and ask which one; never guess.
- Send a file only through profiles the user named; if unsure, call listProfiles and ask.
- record and snapshot write files and can send messages: say what you will do before, and tell the user the file name or what was sent after.
- A reachable false camera cannot record; tell the user instead of retrying.
- Before switching a schedule on, tell the user how often it will send messages.`;

module.exports = { HELP };
