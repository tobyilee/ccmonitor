import { expect, test } from 'bun:test';
import { splitKeys } from './keys.js';

test('splitKeys separates burst input and keeps escape sequences whole', () => {
  expect(splitKeys('b')).toEqual(['b']);
  expect(splitKeys('cjj')).toEqual(['c', 'j', 'j']);
  expect(splitKeys('b\x1bsq')).toEqual(['b', '\x1b', 's', 'q']);
  expect(splitKeys('\x1b[A\x1b[B')).toEqual(['\x1b[A', '\x1b[B']);
  expect(splitKeys('\x1b[5~j')).toEqual(['\x1b[5~', 'j']);
  expect(splitKeys('\x1b')).toEqual(['\x1b']);
  expect(splitKeys('')).toEqual([]);
});
