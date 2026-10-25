import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkName, safeUrl, splitLinks } from '../src/ui/urls.js';

test('only web links can be opened', () => {
  assert.equal(safeUrl('https://github.com/acme/api').href, 'https://github.com/acme/api');
  assert.equal(safeUrl('github.com/acme/api').href, 'https://github.com/acme/api', 'bare domain read as https');
  assert.equal(safeUrl('http://wiki.acme.io/x').protocol, 'http:');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'not a link', '', null]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('links: one per line, short names', () => {
  assert.deepEqual(splitLinks(' a.io \n\n b.io/x '), ['a.io', 'b.io/x']);
  assert.equal(splitLinks(' \n '), null);
  assert.equal(linkName(safeUrl('https://www.github.com/acme/api/')), 'github.com/acme/api');
  assert.equal(linkName(safeUrl('https://example.com/' + 'x'.repeat(60))).length, 40);
});
