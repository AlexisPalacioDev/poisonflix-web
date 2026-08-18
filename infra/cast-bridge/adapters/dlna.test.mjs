// Tests for the SOAP that AVTransport renderers are fed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { didlMetadata, parseSoapFault, soapEnvelope } from './dlna.mjs';
import { guessMimeType } from '../mime.mjs';
import { escapeXml } from '../xml.mjs';

describe('escaping', () => {
  test('every character XML cares about', () => {
    assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });

  test('a media URL with query parameters stays intact but escaped', () => {
    // Signed URLs are full of `&`, and an unescaped one ends the element early
    // — the renderer then gets a truncated URL and reports a media error.
    const url = 'http://bff/stream?id=7&token=abc';
    assert.match(escapeXml(url), /id=7&amp;token=abc$/);
  });
});

describe('guessMimeType', () => {
  test('recognises the containers this house actually streams', () => {
    assert.equal(guessMimeType('http://x/movie.mkv'), 'video/x-matroska');
    assert.equal(guessMimeType('http://x/movie.MP4?range=1'), 'video/mp4');
    assert.equal(guessMimeType('http://x/song.m4a'), 'audio/mp4');
  });

  test('an extensionless URL is treated as progressive MP4', () => {
    assert.equal(guessMimeType('http://bff/bff/stream?id=7'), 'video/mp4');
  });
});

describe('didlMetadata', () => {
  test('carries the title and a protocolInfo that matches the URL', () => {
    const didl = didlMetadata({ title: 'Alien & Aliens', url: 'http://x/movie.mkv' });
    assert.match(didl, /<dc:title>Alien &amp; Aliens<\/dc:title>/);
    assert.match(didl, /protocolInfo="http-get:\*:video\/x-matroska:\*"/);
    assert.match(didl, /<upnp:class>object\.item\.videoItem<\/upnp:class>/);
  });

  test('audio gets the audio class, because renderers switch UI on it', () => {
    assert.match(didlMetadata({ title: 'x', url: 'http://x/a.mp3' }), /audioItem/);
  });
});

describe('soapEnvelope', () => {
  test('wraps the action in the AVTransport namespace with its arguments', () => {
    const body = soapEnvelope('SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: 'http://x/a&b.mp4',
      CurrentURIMetaData: '<DIDL-Lite/>',
    });
    assert.match(body, /<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
    assert.match(body, /<InstanceID>0<\/InstanceID>/);
    assert.match(body, /<CurrentURI>http:\/\/x\/a&amp;b\.mp4<\/CurrentURI>/);
    // The metadata is a document inside an element, so it is escaped a second
    // time on the way out. A renderer receiving raw `<DIDL-Lite>` here sees
    // malformed SOAP and answers 500.
    assert.match(body, /<CurrentURIMetaData>&lt;DIDL-Lite\/&gt;<\/CurrentURIMetaData>/);
  });
});

describe('parseSoapFault', () => {
  test('digs the UPnP error out of a 500 body', () => {
    const fault = parseSoapFault(`<s:Envelope><s:Body><s:Fault><detail>
      <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
        <errorCode>718</errorCode>
        <errorDescription>Transition not available</errorDescription>
      </UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    assert.deepEqual(fault, { code: '718', description: 'Transition not available' });
  });

  test('a body with no fault in it is null, not an empty fault', () => {
    assert.equal(parseSoapFault('<s:Envelope><s:Body/></s:Envelope>'), null);
  });
});
