// compat-rom.ts
//
// 同梱の互換ROM（compat-rom/、PC88Behaviorのビルド成果物）を取得し、
// manifest.json の SHA-256 と照合してから返す。不一致なら起動せずエラーを投げる。
//
// ROM本体はバイナリなので `?url` でアセットURLを得る（このリポジトリの
// 方針どおり "import で URL を得る" 方式。Vite が dist ビルド時に
// dist/assets/ 配下へコピーし、URLを書き換えてくれる）。

import n88RomUrl from '../compat-rom/N88.ROM?url';
import diskRomUrl from '../compat-rom/DISK.ROM?url';
import fontRomUrl from '../compat-rom/FONT.ROM?url';
import n88Ext0RomUrl from '../compat-rom/N88_0.ROM?url';
import n88Ext1RomUrl from '../compat-rom/N88_1.ROM?url';
import n88Ext2RomUrl from '../compat-rom/N88_2.ROM?url';
import n88Ext3RomUrl from '../compat-rom/N88_3.ROM?url';
import n88nRomUrl from '../compat-rom/N88N.ROM?url';
import blank2dUrl from '../compat-rom/BLANK2D.D88?url';
import manifest from '../compat-rom/manifest.json';

interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
}

interface Manifest {
  generatedBy: string;
  sourceCommit: string;
  license: string;
  files: ManifestFile[];
}

const ROM_URLS: Record<string, string> = {
  'N88.ROM': n88RomUrl,
  'DISK.ROM': diskRomUrl,
  'FONT.ROM': fontRomUrl,
  'N88_0.ROM': n88Ext0RomUrl,
  'N88_1.ROM': n88Ext1RomUrl,
  'N88_2.ROM': n88Ext2RomUrl,
  'N88_3.ROM': n88Ext3RomUrl,
  'N88N.ROM': n88nRomUrl,
  'BLANK2D.D88': blank2dUrl,
};

function isDiskImage(name: string): boolean {
  return /\.d88$/i.test(name);
}

export interface VerifiedRom {
  name: string;
  bytes: ArrayBuffer;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * compat-rom/ の全ファイルを取得し、manifest.json の SHA-256 と突き合わせる。
 * 1件でも不一致・取得失敗があれば例外を投げる（空文字列や0を返して
 * 成功したように見せない。../docs/API-DESIGN.md 4節と同じ考え方）。
 */
export async function loadVerifiedCompatRoms(): Promise<VerifiedRom[]> {
  return loadVerified((name) => !isDiskImage(name));
}

/**
 * 同梱のディスクイメージ(BLANK2D.D88: 空のデータディスク)を、ROMと同じ
 * manifest の SHA-256 照合を通して取得する。ROM としては渡さない
 * (loadVerifiedCompatRoms は .D88 を含まない)。manifest に無ければ空配列。
 */
export async function loadVerifiedBundledDisks(): Promise<VerifiedRom[]> {
  return loadVerified(isDiskImage);
}

async function loadVerified(pick: (name: string) => boolean): Promise<VerifiedRom[]> {
  const m = manifest as Manifest;
  const results: VerifiedRom[] = [];
  for (const entry of m.files) {
    if (!pick(entry.name)) continue;
    const url = ROM_URLS[entry.name];
    if (!url) {
      throw new Error(`compat-rom: manifest に載っている ${entry.name} の配信元が無い`);
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`compat-rom: ${entry.name} の取得に失敗 (HTTP ${res.status})`);
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength !== entry.size) {
      throw new Error(
        `compat-rom: ${entry.name} のサイズが manifest と一致しない (実測 ${bytes.byteLength}, manifest ${entry.size})`,
      );
    }
    const hex = await sha256Hex(bytes);
    if (hex !== entry.sha256) {
      throw new Error(
        `compat-rom: ${entry.name} の SHA-256 が manifest と一致しない (実測 ${hex}, manifest ${entry.sha256})`,
      );
    }
    results.push({ name: entry.name, bytes });
  }
  return results;
}
