import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  parseChannel,
  parseChannelNumber,
  parseDateHeader,
  parseDvr,
  parseJobs,
  parseStatus,
} from '../src/channels/parse.js';

const NOW = Date.parse('2023-02-23T23:40:00Z'); // 1677195600
// The documented example of GET /api/v1/jobs (getchannels.com, Server API: Jobs).
const DOC_JOB = {
  id: '1677195000-231',
  name: 'NBC Nightly News With Lester Holt',
  start_time: 1677195000,
  end_time: 1677196800,
  duration: 1800,
  channels: ['512', '12.1', '6000'],
  skipped: false,
  failed: false,
  updated_at: 1677092762571,
  item: { title: 'NBC Nightly News With Lester Holt', playback_time: 0 },
};

test('jobs: the documented example records at its time, is upcoming before, gone after', () => {
  assert.deepEqual(parseJobs([DOC_JOB], NOW), {
    recording: 1,
    upcoming: 0,
    recordingTitle: 'NBC Nightly News With Lester Holt',
    nextTitle: null,
  });
  assert.deepEqual(parseJobs([DOC_JOB], 1677195000_000 - 1), {
    recording: 0,
    upcoming: 1,
    recordingTitle: null,
    nextTitle: 'NBC Nightly News With Lester Holt',
  });
  assert.equal(parseJobs([DOC_JOB], 1677196800_000).recording, 0, 'end excluded');
  assert.equal(parseJobs([DOC_JOB], 1677195000_000).recording, 1, 'start included');
  assert.deepEqual(parseJobs([], NOW), {
    recording: 0,
    upcoming: 0,
    recordingTitle: null,
    nextTitle: null,
  });
});

test('jobs: skipped and failed; the next is the earliest', () => {
  const jobs = [
    { ...DOC_JOB, failed: true },
    { ...DOC_JOB, id: 'b', name: 'Later', start_time: 1677200000, end_time: 1677201000 },
    { ...DOC_JOB, id: 'c', name: 'Sooner', start_time: 1677199000, end_time: 1677201000 },
    {
      ...DOC_JOB,
      id: 'd',
      name: 'Skipped',
      start_time: 1677198000,
      end_time: 1677201000,
      skipped: true,
    },
  ];
  assert.deepEqual(parseJobs(jobs, NOW), {
    recording: 0,
    upcoming: 2,
    recordingTitle: null,
    nextTitle: 'Sooner',
  });
});

test('jobs: anything not as documented is unknown, never 0', () => {
  for (const json of [
    null,
    {},
    'x',
    [null],
    [[]],
    [{ ...DOC_JOB, start_time: '1677195000' }],
    [{ ...DOC_JOB, start_time: 1677195000123, end_time: 1677196800123 }],
    [{ ...DOC_JOB, end_time: 1677194000 }],
    [{ ...DOC_JOB, skipped: 'no' }],
    [{ ...DOC_JOB, start_time: 1.5e9 + 0.5 }],
  ]) {
    assert.equal(parseJobs(json, NOW), null, JSON.stringify(json));
  }
  assert.equal(parseJobs([DOC_JOB], NaN), null);
  assert.equal(parseJobs(new Array(5001).fill(DOC_JOB), NOW), null, 'too many');
  // A skipped job is not read further.
  assert.equal(parseJobs([{ skipped: true }], NOW).upcoming, 0);
});

test('Date header: the HTTP format only', () => {
  assert.equal(parseDateHeader('Thu, 23 Feb 2023 23:40:00 GMT'), NOW);
  assert.equal(parseDateHeader(['Thu, 23 Feb 2023 23:40:00 GMT']), NOW);
  for (const value of [
    undefined,
    '',
    '1677195600',
    '2023-02-23T23:40:00Z',
    'Thu, 23 Feb 2023 25:99:00 GMT',
  ]) {
    assert.equal(parseDateHeader(value), null, String(value));
  }
});

test('disk: bytes, used from total - free when absent; anything odd is unknown', () => {
  assert.deepEqual(
    parseDvr({ disk: { free: 57250316288, total: 499963174912, used: 439830028288 } }),
    {
      free: 57250316288,
      used: 439830028288,
    },
  );
  assert.deepEqual(parseDvr({ disk: { free: 10, total: 30 } }), { free: 10, used: 20 });
  for (const json of [
    null,
    [],
    {},
    { disk: [] },
    { disk: { free: '1', total: 2 } },
    { disk: { free: 3, total: 2 } },
    { disk: { free: 3, total: 2, used: 1 } },
    { disk: { free: 0, total: 0 } },
    { disk: { free: 1, total: 2, used: 3 } },
    { disk: { free: -1, total: 2 } },
    { disk: { free: 1.5, total: 2 } },
  ]) {
    assert.equal(parseDvr(json), null, JSON.stringify(json));
  }
});

test('status: the documented example', () => {
  assert.deepEqual(
    parseStatus({
      status: 'paused',
      muted: false,
      channel: { number: '552', name: 'TBS HD', image_url: 'http://tmsimg.fancybits.co/x.png' },
      now_playing: { type: 'tv', title: 'Seinfeld', episode_title: 'The Truth', season_number: 3 },
    }),
    {
      playback: 0,
      muted: false,
      channel: { number: '552', value: 552, name: 'TBS HD' },
      title: 'Seinfeld — The Truth',
    },
  );
  assert.deepEqual(parseStatus({ status: 'stopped' }), {
    playback: 2,
    muted: null,
    channel: null,
    title: '',
  });
  assert.equal(parseStatus({ status: 'playing', now_playing: { title: 'Movie' } }).title, 'Movie');
  assert.equal(parseStatus({ status: 'rewinding' }).playback, null, 'unknown status: unknown');
  for (const json of [null, [], {}, { status: 1 }, 'playing'])
    assert.equal(parseStatus(json), null);
  assert.equal(parseStatus({ status: 'playing', muted: 'no' }).muted, null);
  assert.equal(parseStatus({ status: 'playing', channel: { number: 'abc' } }).channel, null);
});

test('channel of the status: the text kept; a value only when exact', () => {
  assert.deepEqual(parseChannel({ number: '12.10', name: 'KCET' }), {
    number: '12.10',
    value: null,
    name: 'KCET',
  });
  assert.deepEqual(parseChannel({ number: '12.1' }), { number: '12.1', value: 12.1, name: '' });
  assert.deepEqual(parseChannel({ number: '0512' }).value, null);
  assert.equal(parseChannel({ number: 512 }), null, 'a number, not the documented string');
  assert.equal(parseChannel({ number: '100000' }), null);
});

test('channel numbers: 1 to 99999, up to 3 decimals', () => {
  assert.equal(parseChannelNumber('512'), 512);
  assert.equal(parseChannelNumber('12.1'), 12.1);
  assert.equal(parseChannelNumber(6000), 6000);
  for (const value of [
    '0',
    '100000',
    '99999.5',
    '123456789',
    '1.2345',
    '-1',
    '1e3',
    '',
    ' ',
    null,
    '0x10',
    'Infinity',
  ]) {
    assert.equal(parseChannelNumber(value), null, String(value));
  }
});

test('texts: controls out, capped at 200', () => {
  assert.equal(cleanText('a\u0000b\r\nc d'), 'a b c d');
  assert.equal(cleanText('x'.repeat(300)).length, 200);
  assert.equal(cleanText(42), '');
});
