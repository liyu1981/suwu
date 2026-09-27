// Polyfills for QuickJS, which has neither TextEncoder/TextDecoder nor a
// `process` global. Loaded first so the bundled resolver can assume them.
//
// The suwu embedded WGSL compiler runs this bundle inside the QuickJS runtime
// the binary already ships (pkg/gqjs), never in a browser.

function bytesOf(str) {
  const out = new Uint8Array(str.length * 3);
  let j = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) out[j++] = cp;
    else if (cp < 0x800) {
      out[j++] = 0xc0 | (cp >> 6);
      out[j++] = 0x80 | (cp & 63);
    } else if (cp < 0x10000) {
      out[j++] = 0xe0 | (cp >> 12);
      out[j++] = 0x80 | ((cp >> 6) & 63);
      out[j++] = 0x80 | (cp & 63);
    } else {
      out[j++] = 0xf0 | (cp >> 18);
      out[j++] = 0x80 | ((cp >> 12) & 63);
      out[j++] = 0x80 | ((cp >> 6) & 63);
      out[j++] = 0x80 | (cp & 63);
    }
  }
  return out.subarray(0, j);
}

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(input = '') {
      return bytesOf(String(input));
    }
  };
}

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(input = new Uint8Array(0)) {
      const b = input instanceof Uint8Array ? input : new Uint8Array(input);
      let out = '';
      for (let i = 0; i < b.length; ) {
        const b0 = b[i];
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
          i += 1;
          continue;
        }
        let cp;
        let extra;
        if (b0 >= 0xc2 && b0 <= 0xdf) {
          extra = 1;
          cp = b0 & 0x1f;
        } else if (b0 >= 0xe0 && b0 <= 0xef) {
          extra = 2;
          cp = b0 & 0x0f;
        } else if (b0 >= 0xf0 && b0 <= 0xf4) {
          extra = 3;
          cp = b0 & 0x07;
        } else {
          out += '\ufffd';
          i += 1;
          continue;
        }
        if (i + extra >= b.length) {
          out += '\ufffd';
          break;
        }
        let matched = 0;
        for (let k = 1; k <= extra; k++) {
          const byte = b[i + k];
          if ((byte & 0xc0) !== 0x80) break;
          matched = k;
          cp = (cp << 6) | (byte & 0x3f);
        }
        if (matched < extra) {
          out += '\ufffd';
          i += matched + 1;
          continue;
        }
        i += extra + 1;
        if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) {
          out += '\ufffd';
          continue;
        }
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  };
}

// The resolver reads `process.env.VGPU_VALIDATE` only when `validate` is unset
// (we always pass false); `process.versions.pnp` only on the unreachable
// package-walk path. A stub keeps both from throwing.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {}, versions: {} };
}
