'use strict';

const assert = require('node:assert/strict');
const { ffmpegLines, failureReason } = require('../../lib/prebuffer-plan');
const { inputArgs } = require('../../lib/ffmpeg-args');
const { normalizeSettings } = require('../../lib/config');

const STALL_MS = 20_000;
const T0 = 1_800_000_000_000;

describe('report of a stopped pre-recording', () => {
    it('keeps the last different lines of ffmpeg and counts repeated ones', () => {
        const stderr = [
            '[rtsp @ 0x55d0a1b2c3d0] RTP: missed 3 packets',
            '[rtsp @ 0x55d0a1b2c3d0] max delay reached. need to consume packet',
            '[rtsp @ 0x55d0a1b2c3d0] RTP: missed 3 packets',
            '[rtsp @ 0x7f00aa] max delay reached. need to consume packet',
            '',
            '[rtsp @ 0x55d0a1b2c3d0] max delay reached. need to consume packet',
            '[matroska @ 0x1234] Non-monotonic DTS',
            '[rtsp @ 0x5] Session timeout',
        ].join('\r\n');
        assert.equal(
            ffmpegLines(stderr),
            '[rtsp] max delay reached. need to consume packet (3×) | [matroska] Non-monotonic DTS | [rtsp] Session timeout',
        );
        assert.equal(ffmpegLines('a\nb\nc', 2), 'b | c');
        assert.equal(ffmpegLines(''), '');
    });

    it('tells how long the stream ran before it stopped sending', () => {
        assert.equal(
            failureReason({
                stalled: true,
                code: null,
                startedAt: T0,
                firstData: T0 + 2_000,
                lastData: T0 + 37_400,
                stallMs: STALL_MS,
                stderr: '',
            }),
            'received no data for 20 s after 37 s of stream, ffmpeg reported nothing',
        );
    });

    it('tells a camera that never sent anything apart', () => {
        assert.equal(
            failureReason({
                stalled: true,
                code: null,
                startedAt: T0,
                firstData: 0,
                lastData: T0,
                stallMs: STALL_MS,
                stderr: '[rtsp @ 0xabc] method DESCRIBE failed: 401 Unauthorized\n',
            }),
            'received no data for 20 s before any data came: [rtsp] method DESCRIBE failed: 401 Unauthorized',
        );
        assert.equal(
            failureReason({
                stalled: false,
                code: 1,
                startedAt: T0,
                firstData: T0 + 1_000,
                lastData: T0 + 12_000,
                stallMs: STALL_MS,
                stderr: 'Connection timed out',
            }),
            'stopped after 12 s of stream (exit code 1): Connection timed out',
        );
    });

    it('asks ffmpeg for warnings only in the pre-recording', () => {
        const camera = /** @type {any} */ ({ url: 'rtsp://h/1', transport: 'tcp', username: '', password: '' });
        const settings = normalizeSettings({});
        const level = (/** @type {string[]} */ args) => args[args.indexOf('-loglevel') + 1];
        assert.equal(level(inputArgs(camera, settings, { live: true, loglevel: 'warning' })), 'warning');
        assert.equal(level(inputArgs(camera, settings)), 'error');
        assert.equal(level(inputArgs(camera, settings, { snapshot: true })), 'error');
    });
});
