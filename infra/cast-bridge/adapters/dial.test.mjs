// Tests for the DIAL app resource: the document a TV answers with, and the URL
// its running instance lives at.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { instanceUrl, parseAppState } from './dial.mjs';

const RUNNING = `<?xml version="1.0" encoding="UTF-8"?>
<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">
  <name>PoisonFlix</name>
  <options allowStop="true"/>
  <state>running</state>
  <link rel="run" href="run"/>
</service>`;

const STOPPED = `<?xml version="1.0" encoding="UTF-8"?>
<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">
  <name>PoisonFlix</name>
  <options allowStop="true"/>
  <state>stopped</state>
</service>`;

describe('parseAppState', () => {
  test('reads the name, the state and the run link', () => {
    assert.deepEqual(parseAppState(RUNNING), {
      name: 'PoisonFlix',
      state: 'running',
      runHref: 'run',
    });
  });

  test('a stopped app has no instance to delete', () => {
    const state = parseAppState(STOPPED);
    assert.equal(state.state, 'stopped');
    assert.equal(state.runHref, null);
  });

  test('a namespaced document reads exactly the same', () => {
    // Legal DIAL, and shipped by real firmware. The private regexes this used
    // to have matched neither the prefix nor the entity, so `stop` would have
    // answered "estado: desconocido" forever on such a TV.
    const state = parseAppState(`<dial:service xmlns:dial="urn:dial-multiscreen-org:schemas:dial">
      <dial:name>Poison&amp;Flix</dial:name><dial:state>running</dial:state>
      <dial:link rel="run" href="run"/></dial:service>`);
    assert.deepEqual(state, { name: 'Poison&Flix', state: 'running', runHref: 'run' });
  });

  test('an app the TV could install reports that state verbatim', () => {
    // `installable=<url>` is a legal state and is NOT `running` — the caller
    // decides what to say about it, this only has to not lie.
    const state = parseAppState('<service><state>installable=https://store/app</state></service>');
    assert.equal(state.state, 'installable=https://store/app');
  });
});

describe('instanceUrl', () => {
  test('appends to the app resource instead of replacing its last segment', () => {
    // The bug this exists to prevent: `new URL('run', '…/ws/app/PoisonFlix')`
    // resolves to `…/ws/app/run`, so the DELETE would go to a resource that
    // belongs to no app at all — and the TV would answer 404 while the video
    // kept playing.
    assert.equal(
      instanceUrl('http://192.168.1.28:8080/ws/app/PoisonFlix', 'run'),
      'http://192.168.1.28:8080/ws/app/PoisonFlix/run',
    );
  });

  test('an absolute href from the TV wins', () => {
    assert.equal(
      instanceUrl('http://192.168.1.28:8080/ws/app/PoisonFlix', 'http://192.168.1.28:8080/run/7'),
      'http://192.168.1.28:8080/run/7',
    );
  });

  test('no href falls back to the conventional `run` child', () => {
    assert.equal(
      instanceUrl('http://192.168.1.28:8080/ws/app/PoisonFlix', null),
      'http://192.168.1.28:8080/ws/app/PoisonFlix/run',
    );
  });
});
