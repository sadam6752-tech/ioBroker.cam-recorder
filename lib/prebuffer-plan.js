'use strict';

/**
 * Pure helpers of the pre-recording: the buffer process writes the camera stream into
 * short segments named by the local time they started (`YYYYMMDDHHMMSS.ts`; `%s` is not
 * available in the Windows build of ffmpeg), and a clip is
 * cut from the segments that cover the wanted time window.
 */

/** Target length of one segment in seconds (ffmpeg cuts at the next key frame). */
const SEGMENT_SECONDS = 2;

/**
 * @typedef {object} Segment
 * @property {string} name - File name
 * @property {number} start - Start time in ms
 */

/**
 * @param {string[]} names - File names of the buffer folder
 * @returns {Segment[]} Segments, oldest first
 */
function parseSegments(names) {
    /** @type {Segment[]} */
    const segments = [];
    for (const name of names) {
        const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.ts$/.exec(name);
        if (match) {
            const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
            segments.push({ name, start: new Date(y, mo - 1, d, h, mi, s).getTime() });
        }
    }
    return segments.sort((a, b) => a.start - b.start);
}

/**
 * Picks the segments for the window `from`..`to`. Only complete segments are used: the
 * newest file is still being written, so a segment counts when a newer one exists.
 *
 * @param {Segment[]} segments - All segments, oldest first
 * @param {number} from - Window start in ms
 * @param {number} to - Window end in ms
 * @returns {{segments: Segment[], offset: number, complete: boolean}} Segments to join, seconds to skip
 *   at the start, and whether the window end is already covered by complete segments
 */
function selectSegments(segments, from, to) {
    const done = segments.slice(0, -1);
    const next = segments.length ? segments[segments.length - 1] : null;
    // a segment ends where the following one starts
    const picked = done.filter((s, i) => {
        const end = i + 1 < segments.length ? segments[i + 1].start : Infinity;
        return end > from && s.start < to;
    });
    const complete = !!next && next.start >= to;
    const offset = picked.length ? Math.max(0, (from - picked[0].start) / 1000) : 0;
    return { segments: picked, offset, complete };
}

/**
 * Segments that are no longer needed: everything that ended before `keepFrom`.
 *
 * @param {Segment[]} segments - All segments, oldest first
 * @param {number} keepFrom - Oldest time in ms that must stay available
 * @returns {Segment[]} Segments to delete
 */
function expiredSegments(segments, keepFrom) {
    return segments.filter((s, i) => i + 1 < segments.length && segments[i + 1].start <= keepFrom);
}

/**
 * Line for the concat demuxer of ffmpeg; quotes in the path are escaped.
 *
 * @param {string[]} files - Absolute paths
 * @returns {string} Content of the list file
 */
function concatList(files) {
    return `${files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')}\n`;
}

/**
 * Pause before the next restart of a failed buffer process: 5 s, 10 s, 30 s, 60 s, then 5 min.
 *
 * @param {number} attempt - Failed starts in a row, starting with 1
 * @returns {number} Milliseconds
 */
function restartDelay(attempt) {
    const steps = [5, 10, 30, 60];
    return (steps[Math.max(0, attempt - 1)] ?? 300) * 1000;
}

module.exports = { SEGMENT_SECONDS, parseSegments, selectSegments, expiredSegments, concatList, restartDelay };
