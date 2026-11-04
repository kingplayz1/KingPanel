/**
 * Updater trust policy.
 *
 * These tests cover the decision the application makes before it asks
 * electron-updater to check for updates. They do not exercise a real signed
 * installer: that needs a certificate, and is listed as NOT TESTED in the phase
 * report. What they do prove is that an unpinned build, a feed without
 * publisherName (which makes electron-updater skip verification) and a mismatched
 * publisher all stop the update check instead of proceeding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import policy from '../updater-policy.cjs';

const { evaluateUpdaterPolicy, publisherList } = policy;
const PIN = 'IS King Panel Ltd';

const feed = (overrides = {}) => ({
  provider: 'github',
  owner: 'kingplayz1',
  repo: 'KingPanel',
  updaterCacheDirName: 'iskingpanel-updater',
  ...overrides,
});

describe('updater publisher policy', () => {
  test('a pinned publisher that matches the feed is allowed', () => {
    const result = evaluateUpdaterPolicy({
      appUpdate: feed({ publisherName: PIN }),
      expectedPublisher: PIN,
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.declared, [PIN]);
  });

  test('a feed without publisherName is refused, not silently trusted', () => {
    // electron-updater returns null (skip) when this field is absent, so this is
    // the difference between "verified" and "not checked at all".
    const result = evaluateUpdaterPolicy({ appUpdate: feed(), expectedPublisher: PIN });
    assert.equal(result.allowed, false);
    assert.ok(result.problems.some((p) => /no publisherName/.test(p)));
  });

  test('a build with no pinned publisher refuses to update', () => {
    const result = evaluateUpdaterPolicy({
      appUpdate: feed({ publisherName: PIN }),
      expectedPublisher: '',
    });
    assert.equal(result.allowed, false);
    assert.ok(result.problems.some((p) => /pins no publisher/.test(p)));
  });

  test('a different trusted publisher is refused', () => {
    const result = evaluateUpdaterPolicy({
      appUpdate: feed({ publisherName: 'Someone Else Ltd' }),
      expectedPublisher: PIN,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.problems.some((p) => /expects publisher "Someone Else Ltd"/.test(p)));
  });

  test('a list of publisher names is accepted when one matches', () => {
    const result = evaluateUpdaterPolicy({
      appUpdate: feed({ publisherName: ['CN=Other, O=Other', PIN] }),
      expectedPublisher: PIN,
    });
    assert.equal(result.allowed, true);
  });

  test('a full distinguished name matches on its CN', () => {
    const result = evaluateUpdaterPolicy({
      appUpdate: feed({ publisherName: `CN=${PIN}, O=${PIN}, C=IN` }),
      expectedPublisher: PIN,
    });
    assert.equal(result.allowed, true);
  });

  test('publisherName may be an array or a string and is normalised', () => {
    assert.deepEqual(publisherList(undefined), []);
    assert.deepEqual(publisherList('ACME'), ['ACME']);
    assert.deepEqual(publisherList(['A', ' ', 'B']), ['A', 'B']);
  });
});
