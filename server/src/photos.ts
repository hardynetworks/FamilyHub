/**
 * Photo slideshow sources.
 *
 *  - Amazon Photos: public shared-album links. Amazon has no public API for Photos, so this reads the
 *    same JSON endpoints the amazon.com share page uses. It needs no Amazon login, but Amazon can
 *    change these endpoints without notice.
 *  - Immich: official REST API with an API key (x-api-key), selected albums or favorites.
 *
 * The browser never talks to Amazon/Immich directly: FamilyHub keeps a cached list of photos and
 * proxies each image through /api/photos/:id/image (so API keys stay on the server and the
 * slideshow works for anyone who can reach FamilyHub).
 */
import type { Response } from 'express';
import { Readable } from 'stream';
import { photosConfig } from './config';
import { onSettingsChange } from './settings';
import { HttpError } from './util';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_PHOTOS = 3000;

interface AmazonRef {
  kind: 'amazon';
  base: string;
  /** Group share token ("<groupId>.<secret>") for /photos/shared/ links. */
  groupShareToken?: string;
  /** Legacy album share id for /photos/share/ links. */
  shareId?: string;
  nodeId: string;
  ownerId?: string;
  tempLink?: string;
}
interface ImmichRef {
  kind: 'immich';
  assetId: string;
}
interface PhotoEntry {
  id: string;
  takenAt: string | null;
  width?: number;
  height?: number;
  ref: AmazonRef | ImmichRef;
}

interface Cache {
  at: number;
  photos: PhotoEntry[];
  byId: Map<string, PhotoEntry>;
  errors: string[];
  counts: { amazon: number; immich: number };
}

let cache: Cache | null = null;
let refreshing: Promise<Cache> | null = null;
onSettingsChange(() => {
  cache = null;
});

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) {
    const err: any = new Error(`${r.status} ${r.statusText} from ${new URL(url).host}`);
    err.status = r.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected non-JSON response from ${new URL(url).host}`);
  }
}

// ---------------- Amazon Photos (shared links) ----------------

/**
 * Accepts the two kinds of Amazon Photos links:
 *  - group share links:  https://www.amazon.<tld>/photos/shared/<groupId>.<token>   (current "Share" button)
 *  - album share links:  https://www.amazon.<tld>/photos/share/<shareId>            (older album links)
 */
export function parseAmazonShare(link: string): { base: string; type: 'group' | 'album'; id: string } | null {
  const m = link.match(/^https?:\/\/(?:www\.)?amazon\.([a-z.]{2,12})\/photos\/(shared|share)\/([A-Za-z0-9_.-]+)/i);
  if (!m) return null;
  const base = `https://www.amazon.${m[1].toLowerCase()}`;
  const id = m[3];
  if (m[2].toLowerCase() === 'shared' || id.includes('.')) return { base, type: 'group', id };
  return { base, type: 'album', id };
}

function amazonHeaders(base: string) {
  return { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${base}/photos/` };
}

function amazonQuery(shareId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ ...extra, shareId, resourceVersion: 'V2', ContentType: 'JSON', _: String(Date.now()) }).toString();
}

function isImageNode(n: any) {
  const ct: string = n?.contentProperties?.contentType ?? '';
  return n?.kind === 'FILE' && (ct.startsWith('image/') || !!n?.contentProperties?.image);
}

async function amazonChildren(base: string, shareId: string, nodeId: string, out: any[], depth: number) {
  if (depth > 3 || out.length >= MAX_PHOTOS) return;
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const url =
      `${base}/drive/v1/nodes/${encodeURIComponent(nodeId)}/children?` +
      amazonQuery(shareId, { asset: 'ALL', limit: '200', offset: String(offset), searchOnFamily: 'false', tempLink: 'true' });
    const j = await getJson(url, { headers: amazonHeaders(base) });
    const items: any[] = j.data ?? [];
    for (const n of items) {
      if (isImageNode(n)) out.push(n);
      else if (n.kind === 'FOLDER' || n.kind === 'VISUAL_COLLECTION') await amazonChildren(base, shareId, n.id, out, depth + 1);
      if (out.length >= MAX_PHOTOS) return;
    }
    offset += items.length;
    if (!items.length || offset >= (j.count ?? 0)) break;
  }
}

/** Group share links: the same "search/groups" endpoint the amazon.com share page uses (no login needed). */
async function loadAmazonGroup(base: string, token: string): Promise<PhotoEntry[]> {
  const groupId = token.split('.')[0];
  const nodes: any[] = [];
  let offset = 0;
  for (let page = 0; page < 100 && nodes.length < MAX_PHOTOS; page++) {
    const q = new URLSearchParams({
      asset: 'ALL',
      filters: 'type:(PHOTOS)',
      limit: '200',
      offset: String(offset),
      searchContext: 'groups',
      sort: "['contentProperties.contentDate DESC']",
      tempLink: 'false',
      groupShareToken: token,
      resourceVersion: 'V2',
      ContentType: 'JSON',
      _: String(Date.now()),
    });
    const j = await getJson(`${base}/drive/v1/search/groups/${encodeURIComponent(groupId)}?${q}`, { headers: amazonHeaders(base) });
    const items: any[] = j.data ?? [];
    nodes.push(...items.filter(isImageNode));
    offset += items.length;
    if (!items.length || offset >= (j.count ?? 0)) break;
  }
  return nodes.map((n) => ({
    id: `a_${groupId}_${n.id}`,
    takenAt: n.contentProperties?.contentDate ?? n.createdDate ?? null,
    width: n.contentProperties?.image?.width,
    height: n.contentProperties?.image?.height,
    ref: { kind: 'amazon', base, groupShareToken: token, nodeId: n.id, ownerId: n.ownerId },
  }));
}

async function loadAmazonShare(link: string): Promise<PhotoEntry[]> {
  const share = parseAmazonShare(link);
  if (!share) throw new Error(`Not an Amazon Photos share link: ${link}`);
  if (share.type === 'group') return loadAmazonGroup(share.base, share.id);
  const { base } = share;
  const shareId = share.id;
  const info = await getJson(`${base}/drive/v1/shares/${encodeURIComponent(shareId)}?${amazonQuery(shareId)}`, { headers: amazonHeaders(base) });
  const root = info.nodeInfo ?? info;
  if (!root?.id) throw new Error('Amazon returned an unexpected response for this share (is the link still shared?)');
  const nodes: any[] = [];
  if (isImageNode(root)) nodes.push(root);
  else await amazonChildren(base, shareId, root.id, nodes, 0);
  return nodes.map((n) => ({
    id: `a_${shareId}_${n.id}`,
    takenAt: n.contentProperties?.contentDate ?? n.createdDate ?? null,
    width: n.contentProperties?.image?.width,
    height: n.contentProperties?.image?.height,
    ref: { kind: 'amazon', base, shareId, nodeId: n.id, ownerId: n.ownerId ?? root.ownerId, tempLink: n.tempLink },
  }));
}

function withViewBox(url: string, size = 1920) {
  return url + (url.includes('?') ? '&' : '?') + `viewBox=${size}`;
}

async function fetchAmazonImage(ref: AmazonRef): Promise<globalThis.Response> {
  const candidates: string[] = [];
  const thumb = (extra: Record<string, string>) =>
    `https://thumbnails-photos.amazon.com/v1/thumbnail/${encodeURIComponent(ref.nodeId)}?` +
    new URLSearchParams({ viewBox: '1920', ...(ref.ownerId ? { ownerId: ref.ownerId } : {}), ...extra });
  if (ref.groupShareToken) candidates.push(thumb({ groupShareToken: ref.groupShareToken }));
  if (ref.tempLink) candidates.push(withViewBox(ref.tempLink), ref.tempLink);
  if (ref.shareId) candidates.push(thumb({ shareId: ref.shareId }));
  let last = 'no image URL';
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${ref.base}/photos/` }, signal: AbortSignal.timeout(30_000) });
      if (r.ok && (r.headers.get('content-type') ?? '').startsWith('image/')) return r;
      last = `${r.status}`;
    } catch (e: any) {
      last = e.message;
    }
  }
  throw new HttpError(502, `Amazon image fetch failed (${last})`);
}

// ---------------- Immich ----------------

function immichHeaders(apiKey: string) {
  return { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
}

export async function immichAlbums(url: string, apiKey: string) {
  const base = url.replace(/\/+$/, '').replace(/\/api$/, '');
  const [own, shared] = await Promise.all([
    getJson(`${base}/api/albums`, { headers: immichHeaders(apiKey) }),
    getJson(`${base}/api/albums?shared=true`, { headers: immichHeaders(apiKey) }).catch(() => []),
  ]);
  const seen = new Map<string, { id: string; name: string; count: number }>();
  for (const a of [...(own ?? []), ...(shared ?? [])]) seen.set(a.id, { id: a.id, name: a.albumName, count: a.assetCount ?? 0 });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function immichSearch(base: string, apiKey: string, filter: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let page: number | null = 1;
  while (page && out.length < MAX_PHOTOS) {
    const j: any = await getJson(`${base}/api/search/metadata`, {
      method: 'POST',
      headers: immichHeaders(apiKey),
      body: JSON.stringify({ ...filter, type: 'IMAGE', size: 1000, page }),
    });
    out.push(...(j.assets?.items ?? []));
    page = j.assets?.nextPage ? Number(j.assets.nextPage) : null;
  }
  return out;
}

async function loadImmich(): Promise<PhotoEntry[]> {
  const cfg = photosConfig();
  const base = cfg.immichUrl;
  let assets: any[] = [];
  if (cfg.immichAlbumIds.length) {
    for (const albumId of cfg.immichAlbumIds) {
      try {
        assets.push(...(await immichSearch(base, cfg.immichApiKey, { albumIds: [albumId] })));
      } catch (e: any) {
        if (e.status !== 400) throw e;
        // Older Immich versions: search doesn't accept albumIds, read the album instead.
        const album = await getJson(`${base}/api/albums/${encodeURIComponent(albumId)}`, { headers: immichHeaders(cfg.immichApiKey) });
        assets.push(...(album.assets ?? []).filter((a: any) => a.type === 'IMAGE'));
      }
    }
  } else {
    assets = await immichSearch(base, cfg.immichApiKey, { isFavorite: true });
  }
  const seen = new Set<string>();
  return assets
    .filter((a) => !seen.has(a.id) && seen.add(a.id))
    .map((a) => ({
      id: `i_${a.id}`,
      takenAt: a.localDateTime ?? a.fileCreatedAt ?? null,
      width: a.exifInfo?.exifImageWidth,
      height: a.exifInfo?.exifImageHeight,
      ref: { kind: 'immich', assetId: a.id },
    }));
}

async function fetchImmichImage(ref: ImmichRef): Promise<globalThis.Response> {
  const cfg = photosConfig();
  const r = await fetch(`${cfg.immichUrl}/api/assets/${encodeURIComponent(ref.assetId)}/thumbnail?size=preview`, {
    headers: { 'x-api-key': cfg.immichApiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new HttpError(502, `Immich image fetch failed (${r.status})`);
  return r;
}

// ---------------- Cache ----------------

async function build(): Promise<Cache> {
  const cfg = photosConfig();
  const photos: PhotoEntry[] = [];
  const errors: string[] = [];
  const counts = { amazon: 0, immich: 0 };
  if (cfg.useAmazon) {
    for (const link of cfg.amazonLinks) {
      try {
        const list = await loadAmazonShare(link);
        counts.amazon += list.length;
        photos.push(...list);
      } catch (e: any) {
        errors.push(`Amazon (${link.slice(0, 60)}): ${e.message}`);
      }
    }
  }
  if (cfg.useImmich) {
    try {
      const list = await loadImmich();
      counts.immich += list.length;
      photos.push(...list);
    } catch (e: any) {
      errors.push(`Immich: ${e.message}`);
    }
  }
  errors.forEach((e) => console.warn(`Photos: ${e}`));
  return { at: Date.now(), photos, byId: new Map(photos.map((p) => [p.id, p])), errors, counts };
}

export async function getPhotos(force = false): Promise<Cache> {
  const cfg = photosConfig();
  const fresh = cache && Date.now() - cache.at < cfg.refreshMinutes * 60_000;
  if (!force && fresh) return cache!;
  if (!refreshing) {
    refreshing = build()
      .then((c) => (cache = c))
      .finally(() => (refreshing = null));
  }
  // Serve stale data while refreshing in the background, if we have any.
  if (cache && !force) return cache;
  return refreshing;
}

/** Stream one photo to the client. Only ids from the cached list are accepted (no arbitrary URLs). */
export async function sendPhoto(id: string, res: Response): Promise<void> {
  let entry = (await getPhotos()).byId.get(id);
  if (!entry) throw new HttpError(404, 'Photo not found');
  let upstream: globalThis.Response;
  try {
    upstream = entry.ref.kind === 'amazon' ? await fetchAmazonImage(entry.ref) : await fetchImmichImage(entry.ref);
  } catch (e) {
    // Amazon temp links expire; rebuild the list once and retry.
    if (entry.ref.kind !== 'amazon') throw e;
    entry = (await getPhotos(true)).byId.get(id);
    if (!entry) throw new HttpError(404, 'Photo not found');
    upstream = await fetchAmazonImage(entry.ref as AmazonRef);
  }
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(upstream.body as any).pipe(res);
}
