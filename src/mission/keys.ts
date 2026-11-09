import { decodeKittyPrintable, getKeybindings, isKeyRelease } from '@earendil-works/pi-tui';

export interface TypedInput {
  readonly kind: 'text' | 'paste';
  readonly text: string;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
const LOCK_BITS = 64 | 128;
const SHIFT_BIT = 1;
const SELECTION_KEYBINDINGS = ['tui.select.up', 'tui.select.down', 'tui.select.confirm'] as const;

export function selectionKey(data: string): boolean {
  if (data === '\n') return true;
  const keybindings = getKeybindings();
  return SELECTION_KEYBINDINGS.some((keybinding) => keybindings.matches(data, keybinding));
}

export function typedInput(data: string): TypedInput | undefined {
  if (data.startsWith(PASTE_START)) {
    const end = data.indexOf(PASTE_END);
    const text = data.slice(PASTE_START.length, end === -1 ? undefined : end);
    return text.length === 0 ? undefined : { kind: 'paste', text };
  }
  if (data.length === 0 || isKeyRelease(data)) return undefined;
  const decoded = decodeKittyPrintable(data) ?? decodeModifyOtherKeys(data);
  if (decoded !== undefined) return { kind: 'text', text: decoded };
  for (const char of data) {
    if (!isPrintable(char.codePointAt(0) ?? 0)) return undefined;
  }
  return { kind: 'text', text: data };
}

function decodeModifyOtherKeys(data: string): string | undefined {
  const match = MODIFY_OTHER_KEYS.exec(data);
  if (match === null) return undefined;
  const modifier = (Number.parseInt(match[1] ?? '', 10) - 1) & ~LOCK_BITS;
  const codepoint = Number.parseInt(match[2] ?? '', 10);
  if ((modifier & ~SHIFT_BIT) !== 0 || !isPrintable(codepoint)) return undefined;
  return String.fromCodePoint(codepoint);
}

function isPrintable(codepoint: number): boolean {
  return Number.isFinite(codepoint) && codepoint >= 32 && codepoint !== 127 && (codepoint < 0x80 || codepoint >= 0xa0);
}
