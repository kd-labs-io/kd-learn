// Page fetcher with SSRF guards (plan nguon-hoc.md A5, risk 38). SERVER ONLY. Research fetches a
// few result pages of SearXNG, whose snippets are too short to teach from (spike C2). A URL from a
// search result is untrusted, so:
// - only http(s), default ports or any port, no credentials in the URL;
// - the address is checked when the socket connects (custom `lookup`), so a DNS answer that
//   changes between a check and the connection cannot reach a private address;
// - redirects are followed by hand (at most 3), each one checked the same way;
// - a size cap and a time cap on the whole fetch; only text/html and text/plain.
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { htmlTitle, htmlToText } from './html.ts';

export { htmlTitle, htmlToText } from './html.ts';

export interface FetchedPage {
  readonly url: string;
  readonly title: string | undefined;
  readonly text: string;
}

export type FetchFailure =
  | 'BlockedAddress'
  | 'BadUrl'
  | 'TooManyRedirects'
  | 'TooLarge'
  | 'Timeout'
  | 'NotText'
  | 'HttpError'
  | 'Network';

export class FetchPageError extends Error {
  constructor(readonly reason: FetchFailure) {
    super(`Page fetch failed: ${reason}`);
  }
}

export interface FetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Tests only: which resolved addresses may be reached. Default: public addresses only. */
  readonly isAllowedAddress?: (address: string) => boolean;
}

const v4ToInt = (ip: string) =>
  ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const inV4 = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};
const privateV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Expands an IPv6 address to 8 groups of 16 bits. */
const v6Groups = (ip: string): number[] | undefined => {
  let text = ip.toLowerCase().split('%')[0]!;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4 !== null) {
    const n = v4ToInt(v4[1]!);
    tail = [n >>> 16, n & 0xffff];
    text = text.slice(0, -v4[1]!.length) + '0:0';
  }
  const [head, rest] = text.split('::');
  const left = head === '' || head === undefined ? [] : head.split(':');
  const right = rest === undefined ? [] : rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return undefined;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return undefined;
  if (tail.length > 0) groups.splice(6, 2, ...tail);
  return groups;
};

/** True for an address on the public Internet (not loopback, private, link-local, ...). */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !privateV4.some(([base, bits]) => inV4(address, base, bits));
  if (family !== 6) return false;
  const g = v6Groups(address);
  if (g === undefined) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the IPv4 inside.
  const embedded = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicAddress(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicAddress(embedded);
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
};

const guardedLookup =
  (allowed: (address: string) => boolean): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as unknown as Array<{ address: string; family: number }>;
      const usable = list.filter((entry) => allowed(entry.address));
      if (usable.length === 0 || usable.length !== list.length) {
        return callback(new FetchPageError('BlockedAddress') as NodeJS.ErrnoException, '', 0);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
      }
      callback(null, usable[0]!.address, usable[0]!.family);
    });
  };

const decoded = (response: http.IncomingMessage): Readable => {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  return response;
};

const charsetOf = (contentType: string) => {
  const match = /charset=([^;]+)/i.exec(contentType);
  const label = match?.[1]?.trim().replace(/"/g, '').toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('utf-8');
  }
};

/** Fetches one page as readable text. Throws `FetchPageError`. */
export const fetchPage = async (url: string, options: FetchOptions = {}): Promise<FetchedPage> => {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const lookup = guardedLookup(allowed);
  const deadline = Date.now() + timeoutMs;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new FetchPageError('BadUrl');
  }
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new FetchPageError('BadUrl');
    }
    if (current.username !== '' || current.password !== '') throw new FetchPageError('BadUrl');
    // A literal address never goes through `lookup`: check it here.
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !allowed(host)) throw new FetchPageError('BlockedAddress');

    const left = deadline - Date.now();
    if (left <= 0) throw new FetchPageError('Timeout');
    const result = await new Promise<
      { kind: 'redirect'; location: string } | { kind: 'page'; body: Buffer; contentType: string }
    >((resolve, reject) => {
      const client = current.protocol === 'https:' ? https : http;
      const request = client.get(
        current,
        {
          lookup,
          headers: {
            'user-agent': 'kd-learn research (+self-hosted)',
            accept: 'text/html,text/plain;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
          },
          timeout: left,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location !== undefined) {
            response.resume();
            return resolve({ kind: 'redirect', location: response.headers.location });
          }
          if (status < 200 || status >= 300) {
            response.resume();
            return reject(new FetchPageError('HttpError'));
          }
          const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
          if (!/^text\/(html|plain)\b/.test(contentType) && !contentType.includes('xhtml')) {
            response.resume();
            return reject(new FetchPageError('NotText'));
          }
          const length = Number(response.headers['content-length'] ?? 0);
          if (length > maxBytes) {
            response.destroy();
            return reject(new FetchPageError('TooLarge'));
          }
          const parts: Buffer[] = [];
          let size = 0;
          const stream = decoded(response);
          stream.on('data', (part: Buffer) => {
            size += part.length;
            if (size > maxBytes) {
              stream.destroy();
              response.destroy();
              reject(new FetchPageError('TooLarge'));
              return;
            }
            parts.push(part);
          });
          stream.on('end', () =>
            resolve({ kind: 'page', body: Buffer.concat(parts), contentType }),
          );
          stream.on('error', () => reject(new FetchPageError('Network')));
        },
      );
      request.on('timeout', () => {
        request.destroy();
        reject(new FetchPageError('Timeout'));
      });
      request.on('error', (error) =>
        reject(error instanceof FetchPageError ? error : new FetchPageError('Network')),
      );
    });
    if (result.kind === 'redirect') {
      if (hop >= maxRedirects) throw new FetchPageError('TooManyRedirects');
      try {
        current = new URL(result.location, current);
      } catch {
        throw new FetchPageError('BadUrl');
      }
      continue;
    }
    const raw = charsetOf(result.contentType).decode(result.body);
    const html = result.contentType.includes('html');
    return {
      url: current.toString(),
      title: html ? htmlTitle(raw) : undefined,
      text: (html ? htmlToText(raw) : raw).normalize('NFC'),
    };
  }
};
