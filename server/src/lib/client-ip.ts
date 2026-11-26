import { BlockList, isIP } from 'node:net';
import { safeEqual } from './crypto.ts';

/**
 * Client IP resolution behind a known chain of reverse proxies.
 *
 * `X-Forwarded-For` is a comma-separated list that each proxy APPENDS to. Anything to the left of
 * what our own proxies appended was written by the client and is forgeable, so the leftmost entry
 * must never be trusted. We count hops from the right instead (like Express `trust proxy = N`):
 *
 *   addrs = [socketPeer, xff[n-1], xff[n-2], …, xff[0]]
 *   client = addrs[hops]
 *
 * hops = number of proxies in front of the app. 0 = ignore the header (direct connections).
 *
 * Chain validation (both optional, both fail closed):
 *  - `trustedPeers`: the socket peer must be inside these CIDRs, otherwise the header is ignored.
 *  - `proxySecret`: the OUTERMOST proxy (e.g. Vercel) must send `x-traced-proxy-auth`. A request
 *    without it skipped that proxy (e.g. hit the Cloud Run URL directly), so one hop fewer is
 *    trusted, and the address Cloud Run itself observed is used.
 *
 * Fallback: if the chain is shorter than expected, or the selected entry isn't a valid IP, the
 * nearest address that a trusted proxy wrote is used. That is never client-controlled, and at worst
 * groups clients into one stricter rate-limit bucket.
 */
export type ProxyTrust = {
  hops: number;
  trustedPeers?: BlockList | null;
  proxySecret?: string | null;
};

export const PROXY_AUTH_HEADER = 'x-traced-proxy-auth';

export function normaliseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']')); // [v6]:port
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':')); // v4:port
  v = v.replace(/^::ffff:/i, '');
  return isIP(v) ? v.toLowerCase() : null;
}

export function parseCidrs(list: string | undefined): BlockList | null {
  if (!list || !list.trim()) return null;
  const bl = new BlockList();
  for (const item of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bitsRaw] = item.split('/');
    const ip = normaliseIp(addr);
    if (!ip) throw new Error(`TRUSTED_PROXY_CIDRS: invalid address "${item}"`);
    const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    const max = type === 'ipv6' ? 128 : 32;
    const bits = bitsRaw === undefined ? max : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`TRUSTED_PROXY_CIDRS: invalid prefix "${item}"`);
    bl.addSubnet(ip, bits, type);
  }
  return bl;
}

function inList(bl: BlockList, ip: string): boolean {
  return bl.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function resolveClientIp(
  input: { forwardedFor?: string | null; peer?: string | null; proxyAuth?: string | null },
  trust: ProxyTrust,
): string | null {
  const peer = normaliseIp(input.peer);
  let hops = Math.max(0, Math.floor(trust.hops));
  if (hops === 0) return peer;
  if (trust.trustedPeers && (!peer || !inList(trust.trustedPeers, peer))) return peer;
  if (trust.proxySecret && !safeEqual(input.proxyAuth ?? '', trust.proxySecret)) hops -= 1;
  if (hops === 0) return peer;

  // Bound the work on hostile headers. Keep the RIGHT end: that's where trusted proxies append.
  const MAX = 2048;
  const raw = input.forwardedFor ?? '';
  let list = raw.length > MAX ? raw.slice(-MAX) : raw;
  if (raw.length > MAX) list = list.slice(list.indexOf(',') + 1); // drop the partial first entry
  const entries = list.split(',').map((s) => s.trim()).filter(Boolean);
  const addrs: (string | null)[] = [peer, ...entries.reverse().map(normaliseIp)];

  // Walk inward from our side. Every slot up to `hops` must hold a valid address written by a
  // trusted hop; at the first gap or malformed entry, stop at the last good trusted address.
  for (let i = 1; i <= hops; i++) {
    if (i >= addrs.length || !addrs[i]) return addrs[i - 1] ?? null;
  }
  return addrs[hops]!;
}
