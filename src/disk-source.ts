import { baseNameOf, extractArchive, resolveArchiveFileName } from './api/archive';
import { getDisk, listDisks, putDisk, type StoredDisk } from './disk-store';

export async function fetchSource(url: string, progress: (message: string) => void): Promise<Uint8Array> {
  const parsed = new URL(url, location.href);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HTTP(S) URLを指定してください');
  if (/(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/.test(parsed.hostname)) throw new Error('OneDriveの共有リンクは利用できません');
  const direct = new URL(parsed);
  if (direct.hostname === 'dropbox.com' || direct.hostname === 'www.dropbox.com') direct.hostname = 'dl.dropboxusercontent.com';
  const proxy = (import.meta.env.VITE_DISK_PROXY ?? '').trim().replace(/\/+$/, '');
  const google = /(^|\.)(drive|docs)\.google\.com$/.test(parsed.hostname);
  const read = async (target: string): Promise<Uint8Array> => {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) { for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); size += part.value.length; progress(`取得中: ${(size / 1024).toFixed(0)} KB${total ? ` / ${(total / 1024).toFixed(0)} KB` : ''}`); } }
    else { const b = new Uint8Array(await response.arrayBuffer()); chunks.push(b); size = b.length; }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (response.headers.get('content-type')?.includes('text/html') || /^\s*(<!do|<html|<\?xml)/i.test(new TextDecoder().decode(bytes.subarray(0, 64)))) throw new Error('ディスクではなくHTMLページが返されました');
    return bytes;
  };
  progress('取得中…');
  try { if (google && proxy) return await read(`${proxy}/fetch?url=${encodeURIComponent(url)}`); return await read(direct.href); }
  catch (err) {
    if (proxy && !google) { try { return await read(`${proxy}/fetch?url=${encodeURIComponent(url)}`); } catch (proxyErr) { throw new Error(`中継取得に失敗しました: ${(proxyErr as Error).message}`); } }
    throw new Error(`取得に失敗しました: ${(err as Error).message}。配布元のCORS設定を確認してください${google && !proxy ? '（Google Driveには中継サービスの設定が必要です）' : ''}`);
  }
}

export async function registerSource(name: string, bytes: Uint8Array, source: string, url?: string): Promise<StoredDisk[]> {
  const archive = resolveArchiveFileName(name, bytes);
  const entries = archive ? (await extractArchive(archive, bytes)).filter(e => /\.(d88|88d)$/i.test(e.name)) : [{ name, data: bytes }];
  if (!entries.length) throw new Error('アーカイブに .d88 / .88d がありません');
  const result: StoredDisk[] = [];
  for (const entry of entries) {
    const key = archive ? `${source}:entry:${entry.name}` : source;
    const old = await getDisk(key);
    const disk: StoredDisk = old ?? { sourceKey: key, name: baseNameOf(entry.name), bytes: entry.data, savedAt: Date.now(), url, archiveEntry: archive ? entry.name : undefined };
    if (!old) await putDisk(disk);
    result.push(disk);
  }
  return result;
}
export async function registerUrl(url: string, progress: (message: string) => void): Promise<StoredDisk[]> {
  const source = `url:${url}`;
  const existing = (await listDisks()).filter(d => d.url === url);
  if (existing.length) return existing.sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
  const bytes = await fetchSource(url, progress);
  const path = new URL(url, location.href).pathname;
  let name = path.split('/').pop() || 'disk'; try { name = decodeURIComponent(name); } catch { /* そのまま */ }
  const disks = await registerSource(name, bytes, source, url);
  for (let i = 0; i < disks.length; i++) { disks[i].sourceOrder = i; await putDisk(disks[i]); }
  return disks;
}
export async function originalBytes(disk: StoredDisk, progress: (message: string) => void): Promise<Uint8Array> {
  if (!disk.url) throw new Error('配布元URLがありません');
  const bytes = await fetchSource(disk.url, progress);
  if (!disk.archiveEntry) return bytes;
  const archive = resolveArchiveFileName(new URL(disk.url, location.href).pathname, bytes);
  if (!archive) throw new Error('配布元がアーカイブではありません');
  const entry = (await extractArchive(archive, bytes)).find(e => e.name === disk.archiveEntry);
  if (!entry) throw new Error('アーカイブ内に元のディスクがありません');
  return entry.data;
}
