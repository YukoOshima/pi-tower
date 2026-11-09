import { isKittyProtocolActive, setKittyProtocolActive } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { selectionKey, typedInput } from '../../src/mission/keys.ts';

const SELECTION_KEYS = ['\x1b[A', '\x1bOA', '\x1b[B', '\x1bOB', '\x1b[1;1B', '\r', '\n', '\x1b[13u', '\x1bOM', '\x1b[57414u'];

const OTHER_KEYS = ['j', 'k', 'a', '请', '\x1b[106u', '\x1b', '\x1b[27u', '\t', '\x1b[C', '\x1b[D', '\x1b[5~', '\x1b[6~', '\x0e', '\x10', '\x7f', '\x1b[1;2B', ''];

describe('selectionKey', () => {
  it("matches every key pi's selector moves or confirms with: ↑, ↓ and Enter in each encoding, and a bare LF", () => {
    for (const key of SELECTION_KEYS) expect(selectionKey(key), JSON.stringify(key)).toBe(true);
  });

  it('leaves out j, k, typed text, Esc and the keys the selector ignores', () => {
    for (const key of OTHER_KEYS) expect(selectionKey(key), JSON.stringify(key)).toBe(false);
  });

  it('still matches a bare LF under the Kitty keyboard protocol, as the selector does', () => {
    const kitty = isKittyProtocolActive();
    setKittyProtocolActive(true);
    try {
      for (const key of SELECTION_KEYS) expect(selectionKey(key), JSON.stringify(key)).toBe(true);
      for (const key of OTHER_KEYS) expect(selectionKey(key), JSON.stringify(key)).toBe(false);
    } finally {
      setKittyProtocolActive(kitty);
    }
  });
});

describe('typedInput', () => {
  it('reads plain characters, j and k included, and input-method text as typing', () => {
    for (const key of ['j', 'k', 'p', 'J', ' ', '?', 'ä', '请', '计划', '🙂']) {
      expect(typedInput(key), key).toEqual({ kind: 'text', text: key });
    }
  });

  it('reads printable Kitty and modifyOtherKeys sequences as the characters they type', () => {
    expect(typedInput('\x1b[106u')).toEqual({ kind: 'text', text: 'j' });
    expect(typedInput('\x1b[107u')).toEqual({ kind: 'text', text: 'k' });
    expect(typedInput('\x1b[106:74;2u')).toEqual({ kind: 'text', text: 'J' });
    expect(typedInput('\x1b[106;1:2u')).toEqual({ kind: 'text', text: 'j' });
    expect(typedInput('\x1b[27;2;65~')).toEqual({ kind: 'text', text: 'A' });
    expect(typedInput('\x1b[27;1;106~')).toEqual({ kind: 'text', text: 'j' });
  });

  it('reads a bracketed paste as pasted text', () => {
    expect(typedInput('\x1b[200~split M3 into two\nfeatures\x1b[201~')).toEqual({
      kind: 'paste',
      text: 'split M3 into two\nfeatures',
    });
    expect(typedInput('\x1b[200~\x1b[201~')).toBeUndefined();
  });

  it('leaves arrows, Enter, Esc, control keys and key releases to the dialog', () => {
    for (const key of [
      '\x1b[A',
      '\x1b[B',
      '\x1b[C',
      '\x1b[D',
      '\x1bOA',
      '\x1bOB',
      '\x1b[1;1B',
      '\r',
      '\n',
      '\x1bOM',
      '\x1b[13u',
      '\x1b',
      '\x1b[27u',
      '\t',
      '\x7f',
      '\x03',
      '\x0f',
      '\x1b[106;5u',
      '\x1b[106;3u',
      '\x1b[27;5;106~',
      '\x1b[106;1:3u',
      '\x1b[5~',
      '\x1b[6~',
      '',
    ]) {
      expect(typedInput(key), JSON.stringify(key)).toBeUndefined();
    }
  });
});
