'use strict';

const { buildInputUrl, isRtsp } = require('./camera-url');

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
 * @param {{snapshot?: boolean}} [options] - Snapshot inputs may skip frames until a key frame
 * @returns {string[]} Input arguments
 */
function inputArgs(camera, settings, options = {}) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (isRtsp(camera.url)) {
        args.push('-rtsp_transport', camera.transport, '-timeout', String(settings.rtspTimeout * 1_000_000));
    }
    if (options.snapshot && camera.keyframesOnly) {
        args.push('-skip_frame', 'nokey');
    }
    args.push('-i', buildInputUrl(camera.url, camera.username, camera.password));
    return args;
}

/**
 * @param {ClipOptions} clip - What to record
 * @param {string} output - Target file
 * @returns {string[]} Output arguments
 */
function clipArgs(clip, output) {
    const args = ['-t', String(clip.duration), '-an'];
    if (clip.format === 'gif') {
        const fps = clip.fps > 0 ? `fps=${clip.fps},` : '';
        const scale = clip.width > 0 ? `scale=${clip.width}:-1:flags=lanczos,` : '';
        args.push(
            '-vf',
            `${fps}${scale}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`,
            '-loop',
            '0',
            '-f',
            'gif',
        );
    } else if (clip.mode === 'copy') {
        args.push('-c:v', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4');
    } else {
        if (clip.width > 0) {
            args.push('-vf', `scale=${clip.width}:-2`);
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
 * @param {string} output - Target file
 * @returns {string[]} Output arguments for one JPEG picture
 */
function snapshotArgs(width, output) {
    const args = ['-frames:v', '1', '-an'];
    if (width > 0) {
        args.push('-vf', `scale=${width}:-2`);
    }
    args.push('-q:v', '3', '-f', 'image2', '-update', '1', '-y', output);
    return args;
}

module.exports = { inputArgs, clipArgs, snapshotArgs };
