'use strict';

const { buildInputUrl, isRtsp } = require('./camera-url');
const { orientFilter, displayArgs } = require('./orientation');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Settings} Settings
 * @typedef {import('./types').ClipOptions} ClipOptions
 */

/**
 * Arguments that open the camera. The URL carries the plain login, so the arguments are
 * passed to `spawn` directly (no shell) and never logged without masking.
 *
 * @param {Camera} camera - Camera with the decrypted password
 * @param {Settings} settings - Adapter settings
 * @param {{snapshot?: boolean, live?: boolean, loglevel?: 'error' | 'warning', before?: string[]}} [options] - Snapshot
 *   inputs may skip frames until a key frame; a live input (pre-recording) reads a local file endlessly in real time,
 *   as a stand-in camera for tests; `loglevel` of ffmpeg, default `error`; `before` goes right before `-i` (the display
 *   matrix of a copied clip, see {@link copyInputArgs})
 * @returns {string[]} Input arguments
 */
function inputArgs(camera, settings, options = {}) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', options.loglevel || 'error'];
    if (isRtsp(camera.url)) {
        args.push('-rtsp_transport', camera.transport, '-timeout', String(settings.rtspTimeout * 1_000_000));
    } else if (options.live && !/^[a-z][a-z0-9+.-]*:\/\//i.test(camera.url)) {
        args.push('-re', '-stream_loop', '-1');
    }
    if (options.snapshot && camera.keyframesOnly) {
        args.push('-skip_frame', 'nokey');
    }
    args.push(...(options.before || []), '-i', buildInputUrl(camera.url, camera.username, camera.password));
    return args;
}

/**
 * @param {ClipOptions} clip - What to record
 * @returns {string[]} Input options of a clip that copies the stream of a turned camera (display matrix), else empty
 */
function copyInputArgs(clip) {
    return clip.format === 'mp4' && clip.mode === 'copy' ? displayArgs(clip.orientation) : [];
}

/**
 * @param {ClipOptions} clip - What to record
 * @param {string} output - Target file
 * @returns {string[]} Output arguments
 */
function clipArgs(clip, output) {
    // Sound only in mp4: the first video and the first audio stream, the audio one optional
    // ("?"), so a camera without sound still records. Cameras send G.711 (PCMA/PCMU) or AAC;
    // mp4 and Telegram need AAC, so the sound is always encoded, also when the picture is copied.
    const audio = clip.audio === true && clip.format === 'mp4';
    const args = ['-t', String(clip.duration), ...(audio ? ['-map', '0:v:0', '-map', '0:a:0?'] : ['-an'])];
    const audioCodec = audio ? ['-c:a', 'aac', '-b:a', '64k', '-ac', '1'] : [];
    // A live stream joined between two key frames delivers pictures only from the next key
    // frame on, but the clock starts at the connection: without the reset a 5 s clip of a
    // camera with a key frame every 4 s held about 3 s of video. The reset starts the clip at
    // the first picture. A copied stream cannot be filtered (see the README). With sound the
    // reset would move the picture against the sound, so picture and sound keep their times.
    const restart = audio ? '' : 'setpts=PTS-STARTPTS';
    // turned before scaling, so the width is the width of the turned picture
    const orient = orientFilter(clip.orientation);
    if (clip.format === 'gif') {
        const fps = clip.fps > 0 ? `fps=${clip.fps},` : '';
        const scale = clip.width > 0 ? `scale=${clip.width}:-1:flags=lanczos,` : '';
        args.push(
            '-vf',
            `${[restart, orient].filter(Boolean).join(',') || 'null'},${fps}${scale}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`,
            '-loop',
            '0',
            '-f',
            'gif',
        );
    } else if (clip.mode === 'copy') {
        args.push(
            '-c:v',
            'copy',
            ...audioCodec,
            '-avoid_negative_ts',
            'make_zero',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
        );
    } else {
        const filters = [restart, orient, clip.width > 0 ? `scale=${clip.width}:-2` : ''].filter(Boolean);
        if (filters.length) {
            args.push('-vf', filters.join(','));
        }
        if (clip.fps > 0) {
            args.push('-r', String(clip.fps));
        }
        args.push(
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            ...audioCodec,
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
        );
    }
    args.push('-y', output);
    return args;
}

/**
 * @param {number} width - Width in pixels, 0 = original
 * @param {import('./types').Orientation} [orientation] - Turning of the camera
 * @returns {string[]} `-vf` with the filters of a picture, empty for none
 */
function pictureFilter(width, orientation) {
    const filters = [orientFilter(orientation), width > 0 ? `scale=${width}:-2` : ''].filter(Boolean);
    return filters.length ? ['-vf', filters.join(',')] : [];
}

/**
 * @param {number} width - Width in pixels, 0 = original
 * @param {string} output - Target file
 * @param {import('./types').Orientation} [orientation] - Turning of the camera
 * @returns {string[]} Output arguments for one JPEG picture
 */
function snapshotArgs(width, output, orientation) {
    const args = ['-frames:v', '1', '-an', ...pictureFilter(width, orientation)];
    args.push('-q:v', '3', '-f', 'image2', '-update', '1', '-y', output);
    return args;
}

module.exports = { inputArgs, copyInputArgs, clipArgs, snapshotArgs, pictureFilter };
