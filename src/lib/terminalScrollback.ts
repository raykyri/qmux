const ESC = 0x1b;
const CAN = 0x18;
const BEL = 0x07;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const ST_8BIT = 0x9c;
const DCS_8BIT = 0x90;
const SOS_8BIT = 0x98;
const PM_8BIT = 0x9e;
const APC_8BIT = 0x9f;

const ESC_CSI = 0x5b; // [
const ESC_OSC = 0x5d; // ]
const ESC_DCS = 0x50; // P
const ESC_SOS = 0x58; // X
const ESC_PM = 0x5e; // ^
const ESC_APC = 0x5f; // _
const ESC_ST = 0x5c; // \
const ESC_RIS = 0x63; // c

// Alternate-screen bytes are not scrollback in a real terminal. If we merely
// strip the mode toggle, the TUI's cursor/erase traffic mutates normal history.
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

// Restored scrollback is historical output, not the current process's terminal
// contract. Mode changes from that history must not leak into the fresh xterm.
export const RESTORED_SCROLLBACK_TERMINAL_RESET =
  String.fromCharCode(CAN) +
  "\x1b[0m" +
  "\x1b(B" +
  "\x1b[4l" +
  "\x1b[?1l" +
  "\x1b[?7h" +
  "\x1b[?9l" +
  "\x1b[?25h" +
  "\x1b[?45l" +
  "\x1b[?66l" +
  "\x1b[?47l" +
  "\x1b[?1000l" +
  "\x1b[?1002l" +
  "\x1b[?1003l" +
  "\x1b[?1004l" +
  "\x1b[?1005l" +
  "\x1b[?1006l" +
  "\x1b[?1015l" +
  "\x1b[?1016l" +
  "\x1b[?1047l" +
  "\x1b[?2004l" +
  "\x1b[?2026l";

export function sanitizeRestoredScrollback(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let copyFrom = 0;
  let index = 0;
  let changed = false;
  let inAlternateScreen = false;

  const dropAndKeepPrevious = (start: number, end: number) => {
    changed = true;
    if (copyFrom < start) {
      chunks.push(bytes.subarray(copyFrom, start));
    }
    copyFrom = end;
  };

  const dropThrough = (end: number) => {
    changed = true;
    copyFrom = end;
  };

  while (index < bytes.length) {
    const c1 = c1ControlAt(bytes, index);
    const byte = c1?.code ?? bytes[index];
    if (!c1) {
      const utf8Length = validUtf8SequenceLength(bytes, index);
      if (utf8Length > 1) {
        index += utf8Length;
        continue;
      }
    }

    if (byte === CSI_8BIT) {
      const end = findCsiEnd(bytes, index + (c1?.length ?? 1));
      if (end === -1) {
        if (inAlternateScreen) {
          dropThrough(bytes.length);
        } else {
          dropAndKeepPrevious(index, bytes.length);
        }
        break;
      }
      const csi = parseCsi(bytes, index + (c1?.length ?? 1), end);
      if (inAlternateScreen) {
        dropThrough(end + 1);
        if (isAlternateScreenReset(csi)) {
          inAlternateScreen = false;
        }
      } else if (isAlternateScreenSet(csi)) {
        dropAndKeepPrevious(index, end + 1);
        inAlternateScreen = true;
      } else if (shouldStripCsi(csi)) {
        dropAndKeepPrevious(index, end + 1);
      }
      index = end + 1;
      continue;
    }

    if (
      byte === OSC_8BIT ||
      byte === DCS_8BIT ||
      byte === SOS_8BIT ||
      byte === PM_8BIT ||
      byte === APC_8BIT
    ) {
      const end = findStringControlEnd(bytes, index + (c1?.length ?? 1), true);
      if (end === -1) {
        if (inAlternateScreen) {
          dropThrough(bytes.length);
        } else {
          dropAndKeepPrevious(index, bytes.length);
        }
        break;
      }
      if (inAlternateScreen) {
        dropThrough(end);
      } else {
        dropAndKeepPrevious(index, end);
      }
      index = end;
      continue;
    }

    if (byte !== ESC) {
      index += c1?.length ?? 1;
      continue;
    }
    if (index + 1 >= bytes.length) {
      if (inAlternateScreen) {
        dropThrough(bytes.length);
      } else {
        dropAndKeepPrevious(index, bytes.length);
      }
      break;
    }

    const next = bytes[index + 1];
    if (next === ESC_CSI) {
      const end = findCsiEnd(bytes, index + 2);
      if (end === -1) {
        if (inAlternateScreen) {
          dropThrough(bytes.length);
        } else {
          dropAndKeepPrevious(index, bytes.length);
        }
        break;
      }
      const csi = parseCsi(bytes, index + 2, end);
      if (inAlternateScreen) {
        dropThrough(end + 1);
        if (isAlternateScreenReset(csi)) {
          inAlternateScreen = false;
        }
      } else if (isAlternateScreenSet(csi)) {
        dropAndKeepPrevious(index, end + 1);
        inAlternateScreen = true;
      } else if (shouldStripCsi(csi)) {
        dropAndKeepPrevious(index, end + 1);
      }
      index = end + 1;
      continue;
    }

    if (
      next === ESC_OSC ||
      next === ESC_DCS ||
      next === ESC_SOS ||
      next === ESC_PM ||
      next === ESC_APC
    ) {
      const end = findStringControlEnd(bytes, index + 2, true);
      if (end === -1) {
        if (inAlternateScreen) {
          dropThrough(bytes.length);
        } else {
          dropAndKeepPrevious(index, bytes.length);
        }
        break;
      }
      if (inAlternateScreen) {
        dropThrough(end);
      } else {
        dropAndKeepPrevious(index, end);
      }
      index = end;
      continue;
    }

    if (next === ESC_RIS) {
      if (inAlternateScreen) {
        dropThrough(index + 2);
      } else {
        dropAndKeepPrevious(index, index + 2);
      }
      index += 2;
      continue;
    }

    if (inAlternateScreen) {
      dropThrough(index + 2);
    }

    index += 1;
  }

  if (inAlternateScreen && copyFrom < bytes.length) {
    dropThrough(bytes.length);
  }

  if (!changed) {
    return bytes;
  }
  if (copyFrom < bytes.length) {
    chunks.push(bytes.subarray(copyFrom));
  }
  return concatChunks(chunks);
}

function findCsiEnd(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte >= 0x40 && byte <= 0x7e) {
      return index;
    }
  }
  return -1;
}

type ParsedCsi = {
  final: number;
  private: boolean;
  params: number[];
};

function parseCsi(bytes: Uint8Array, start: number, end: number): ParsedCsi {
  const params: number[] = [];
  let privatePrefix = false;
  let current: number | null = null;

  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === 0x3f) {
      privatePrefix = true;
      continue;
    }
    if (byte >= 0x30 && byte <= 0x39) {
      current = (current ?? 0) * 10 + byte - 0x30;
      continue;
    }
    if (byte === 0x3b || byte === 0x3a) {
      params.push(current ?? 0);
      current = null;
      continue;
    }
    if (current !== null) {
      params.push(current);
      current = null;
    }
  }
  if (current !== null) {
    params.push(current);
  }

  return {
    final: bytes[end],
    private: privatePrefix,
    params,
  };
}

function shouldStripCsi(csi: ParsedCsi): boolean {
  return csi.final === 0x68 || csi.final === 0x6c; // h/l: mode set/reset
}

function isAlternateScreenSet(csi: ParsedCsi): boolean {
  return isAlternateScreenMode(csi, 0x68); // h
}

function isAlternateScreenReset(csi: ParsedCsi): boolean {
  return isAlternateScreenMode(csi, 0x6c); // l
}

function isAlternateScreenMode(csi: ParsedCsi, final: number): boolean {
  return (
    csi.private &&
    csi.final === final &&
    csi.params.some((param) => ALTERNATE_SCREEN_MODES.has(param))
  );
}

function findStringControlEnd(bytes: Uint8Array, start: number, allowC1St: boolean): number {
  for (let index = start; index < bytes.length; index += 1) {
    const c1 = c1ControlAt(bytes, index);
    if (c1) {
      if (allowC1St && c1.code === ST_8BIT) {
        return index + c1.length;
      }
      index += c1.length - 1;
      continue;
    }
    const utf8Length = validUtf8SequenceLength(bytes, index);
    if (utf8Length > 1) {
      index += utf8Length - 1;
      continue;
    }
    if (bytes[index] === BEL) {
      return index + 1;
    }
    if (allowC1St && bytes[index] === ST_8BIT) {
      return index + 1;
    }
    if (bytes[index] === ESC && index + 1 < bytes.length && bytes[index + 1] === ESC_ST) {
      return index + 2;
    }
  }
  return -1;
}

function c1ControlAt(bytes: Uint8Array, index: number): { code: number; length: number } | null {
  const first = bytes[index];
  if (first >= 0x80 && first <= 0x9f) {
    return { code: first, length: 1 };
  }
  if (first === 0xc2 && bytes[index + 1] >= 0x80 && bytes[index + 1] <= 0x9f) {
    return { code: bytes[index + 1], length: 2 };
  }
  return null;
}

function validUtf8SequenceLength(bytes: Uint8Array, index: number): number {
  const first = bytes[index];
  if (first >= 0xc2 && first <= 0xdf) {
    return isUtf8Continuation(bytes[index + 1]) ? 2 : 0;
  }
  if (first === 0xe0) {
    return bytes[index + 1] >= 0xa0 &&
      bytes[index + 1] <= 0xbf &&
      isUtf8Continuation(bytes[index + 2])
      ? 3
      : 0;
  }
  if (first >= 0xe1 && first <= 0xec) {
    return isUtf8Continuation(bytes[index + 1]) && isUtf8Continuation(bytes[index + 2])
      ? 3
      : 0;
  }
  if (first === 0xed) {
    return bytes[index + 1] >= 0x80 &&
      bytes[index + 1] <= 0x9f &&
      isUtf8Continuation(bytes[index + 2])
      ? 3
      : 0;
  }
  if (first >= 0xee && first <= 0xef) {
    return isUtf8Continuation(bytes[index + 1]) && isUtf8Continuation(bytes[index + 2])
      ? 3
      : 0;
  }
  if (first === 0xf0) {
    return (
      bytes[index + 1] >= 0x90 &&
      bytes[index + 1] <= 0xbf &&
      isUtf8Continuation(bytes[index + 2]) &&
      isUtf8Continuation(bytes[index + 3])
    )
      ? 4
      : 0;
  }
  if (first >= 0xf1 && first <= 0xf3) {
    return (
      isUtf8Continuation(bytes[index + 1]) &&
      isUtf8Continuation(bytes[index + 2]) &&
      isUtf8Continuation(bytes[index + 3])
    )
      ? 4
      : 0;
  }
  if (first === 0xf4) {
    return (
      bytes[index + 1] >= 0x80 &&
      bytes[index + 1] <= 0x8f &&
      isUtf8Continuation(bytes[index + 2]) &&
      isUtf8Continuation(bytes[index + 3])
    )
      ? 4
      : 0;
  }
  return 0;
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
