'use strict';

/**
 * Turning and mirroring the picture of a camera (column ↻ of the tab Cameras), for cameras that are mounted
 * upside down or on their side and cannot turn the picture themselves. Rotation is clockwise.
 *
 * @typedef {import('./types').Orientation} Orientation
 */

/** @type {Orientation[]} */
const ORIENTATIONS = ['0', '90', '180', '270', 'hflip', 'vflip'];

/**
 * @param {unknown} value - Raw value of the admin
 * @returns {Orientation} A known orientation, '0' for anything else
 */
function normalizeOrientation(value) {
    const text = String(value ?? '0').trim();
    return /** @type {Orientation} */ (ORIENTATIONS.find(o => o === text) || '0');
}

/** ffmpeg filter per orientation; transpose=1 turns clockwise. */
const FILTERS = { 0: '', 90: 'transpose=1', 180: 'hflip,vflip', 270: 'transpose=2', hflip: 'hflip', vflip: 'vflip' };

/**
 * @param {Orientation | undefined} orientation - Orientation of the camera
 * @returns {string} The video filter that turns the decoded picture, '' for none
 */
function orientFilter(orientation) {
    return FILTERS[orientation || '0'] || '';
}

/**
 * A copied stream cannot be filtered: the mp4 gets a display matrix instead, which players apply when they show the
 * video. `-display_rotation` turns counter-clockwise, so 90° clockwise is -90. Input options, they go before `-i`.
 *
 * @param {Orientation | undefined} orientation - Orientation of the camera
 * @returns {string[]} Input arguments, empty for none
 */
function displayArgs(orientation) {
    switch (orientation) {
        case '90':
            return ['-display_rotation', '-90'];
        case '180':
            return ['-display_rotation', '180'];
        case '270':
            return ['-display_rotation', '90'];
        case 'hflip':
            return ['-display_hflip'];
        case 'vflip':
            return ['-display_vflip'];
        default:
            return [];
    }
}

/**
 * @param {string} version - First line of `ffmpeg -version`
 * @returns {boolean} Whether ffmpeg knows `-display_rotation` (6.0 and newer; a build without a version number, e.g. a
 *   git build, counts as new)
 */
function supportsDisplayMatrix(version) {
    const match = /version\s+n?(\d+)\.\d/i.exec(String(version ?? ''));
    return !match || Number(match[1]) >= 6;
}

module.exports = { ORIENTATIONS, normalizeOrientation, orientFilter, displayArgs, supportsDisplayMatrix };
