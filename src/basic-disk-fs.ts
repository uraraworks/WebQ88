// N88-BASIC の媒体上の規則は l3-disk-format.md §1〜§3 に基づく。
export interface Entry { name: string; type: number; attribute: string; size: number | null; }
export class N88FS {
  private data: Uint8Array;
  private sectors: number[] = [];
  private fat: number[] = [];
  private base = 0;
  constructor(bytes: Uint8Array, image = 0) {
    this.data = bytes.slice();
    const v = new DataView(this.data.buffer);
    for (let i = 0; i < image; i++) { if (this.base + 0x2b0 > bytes.length) throw Error('D88イメージが不正です'); this.base += v.getUint32(this.base + 0x1c, true); }
    const b = this.base;
    if (b + 0x2b0 > bytes.length) throw Error('D88ヘッダが不正です');
    const size = v.getUint32(b + 0x1c, true), end = b + size;
    if (size < 0x2b0 || end > bytes.length || this.data[b + 0x1b] !== 0) throw Error('2D D88以外は未対応です');
    const used = new Set<number>();
    for (let t = 0; t < 80; t++) {
      let p = b + v.getUint32(b + 0x20 + t * 4, true);
      if (p < b + 0x2b0 || p >= end) throw Error('トラックが不正です');
      for (let s = 0; s < 16; s++) {
        const r = this.data[p + 2];
        if (p + 272 > end || this.data[p] !== Math.floor(t / 2) || this.data[p + 1] !== t % 2 || r < 1 || r > 16 || this.sectors[t * 16 + r - 1] !== undefined || this.data[p + 3] !== 1 || v.getUint16(p + 14, true) !== 256) throw Error('標準2Dセクタ以外は未対応です');
        for (let j = p; j < p + 272; j++) { if (used.has(j)) throw Error('セクタが重複しています'); used.add(j); }
        this.sectors[t * 16 + r - 1] = p + 16; p += 272;
      }
    }
    this.fat = [14, 15, 16].map(r => this.sec(18, 1, r));
    for (let i = 0; i < 160; i++) if (this.data[this.fat[0] + i] !== this.data[this.fat[1] + i] || this.data[this.fat[0] + i] !== this.data[this.fat[2] + i]) throw Error('割り当て表が一致しません');
    if (this.data[this.fat[0] + 74] === 255 || this.data[this.fat[0] + 75] === 255) throw Error('管理領域が予約されていません');
  }
  private sec(c: number, h: number, r: number): number { return this.sectors[(c * 2 + h) * 16 + r - 1]; }
  private entries(): number[] { const a: number[] = []; for (let r = 1; r <= 12; r++) for (let i = 0; i < 16; i++) { const p = this.sec(18, 1, r) + i * 16; if (this.data[p] === 255) return a; if (this.data[p] !== 0) a.push(p); } return a; }
  private name(p: number): string { return decodePC(this.data.subarray(p, p + 9)).replace(/ +$/, ''); }
  private chain(p: number): { units: number[]; sectors: number } {
    const units: number[] = []; let n = this.data[p + 10];
    for (;;) { if (n >= 160 || n === 74 || n === 75 || units.includes(n)) throw Error('割り当て鎖が不正です'); units.push(n); const x = this.data[this.fat[0] + n]; if (x < 160) { n = x; continue; } if (x >= 0xc0 && x <= 0xc8) return { units, sectors: (units.length - 1) * 8 + x - 0xc0 }; throw Error('割り当て鎖の終端が不正です'); }
  }
  private raw(p: number): Uint8Array { const c = this.chain(p), out = new Uint8Array(c.sectors * 256); for (let i = 0; i < c.sectors; i++) out.set(this.data.subarray(this.sectors[c.units[Math.floor(i / 8)] * 8 + i % 8], this.sectors[c.units[Math.floor(i / 8)] * 8 + i % 8] + 256), i * 256); return out; }
  private body(p: number): Uint8Array { const t = this.data[p + 9], raw = this.raw(p); if (t === 0) { if (!raw.length) return raw; const end = raw.indexOf(26); if (end < 0) throw Error('ASCII終端がありません'); return raw.slice(0, end); } if (t === 1) { if (raw.length < 4) throw Error('機械語ヘッダが不正です'); const start = raw[0] | raw[1] << 8, end = raw[2] | raw[3] << 8; if (end < start || end - start + 4 > raw.length) throw Error('折り返す機械語形式は未対応です'); return raw.slice(0, end - start + 4); } throw Error('この種別の本文は未対応です'); }
  list(): { entries: Entry[]; free: number; total: number; writeProtected: boolean | null } { return { entries: this.entries().map(p => { const type = this.data[p + 9]; let size: number | null = null; try { size = this.body(p).length; } catch { /* 未測定の本文 */ } return { name: this.name(p), type, attribute: ({0:'ASCII', 1:'機械語', 128:'BASICバイナリ', 160:'保護BASIC'} as Record<number,string>)[type] ?? '不明', size }; }), free: Array.from({length:160}, (_,i) => this.data[this.fat[0]+i] === 255 ? 2048 : 0).reduce<number>((a,b)=>a+b,0), total: 158 * 2048, writeProtected: this.protection() }; }
  private protection(): boolean | null { if (this.data[this.base + 0x1a]) return true; const p = this.sec(18,1,13), values = this.data.subarray(p,p+256); if (!values.every(x => x === values[0])) return null; if ((values[0] & 16) === 0) return false; if ((values[0] & 16) !== 0) return true; return null; }
  private writable(): void { const p = this.protection(); if (p !== false) throw Error(p ? '書き込み禁止です' : '書き込み禁止の判定位置は未確定です'); }
  read(name: string): Uint8Array { const p = this.entries().find(x => this.name(x) === name); if (p === undefined) throw Error('ファイルがありません'); return this.body(p); }
  private validateChains(): void { const seen = new Set<number>(); for (const p of this.entries()) for (const n of this.chain(p).units) { if (seen.has(n)) throw Error('ファイル間で割り当て単位が重複しています'); seen.add(n); } }
  private setFat(n: number, v: number): void { for (const p of this.fat) this.data[p+n] = v; }
  delete(name: string): void { this.writable(); this.validateChains(); const p = this.entries().find(x => this.name(x) === name); if (p === undefined) throw Error('ファイルがありません'); const chain = this.chain(p); for (const n of chain.units) this.setFat(n,255); this.data[p] = 0; }
  write(name: string, bytes: Uint8Array): void {
    this.writable(); this.validateChains(); const nb = encodePC(name); if (!nb.length || nb.length > 9 || !/^[\x21-\x7e]+$/.test(name) || /[\\/]/.test(name)) throw Error('名前は区切り文字を含まない半角英数字記号9文字以内にしてください');
    if (bytes.includes(26)) throw Error('ASCII本文中の0x1Aは未対応です');
    const existing = this.entries().find(x => this.name(x) === name); if (existing !== undefined && this.data[existing+9] !== 0) throw Error('ASCII以外への上書きは未対応です');
    let p = existing; if (p === undefined) { outer: for (let r=1;r<=12;r++) for(let i=0;i<16;i++) { const q=this.sec(18,1,r)+i*16; if (this.data[q]===0 || this.data[q]===255) { p=q; break outer; } } } if (p === undefined) throw Error('ディレクトリが満杯です');
    const old = existing === undefined ? [] : this.chain(existing).units; const payload = new Uint8Array(bytes.length+1); payload.set(bytes); payload[bytes.length]=26;
    const count = Math.ceil(payload.length/2048), order: number[] = []; for(let t=36;t>=0;t--) order.push(t*2,t*2+1); for(let t=39;t>=38;t--) order.push(t*2,t*2+1);
    const free=order.filter(n => old.includes(n) || this.data[this.fat[0]+n]===255); if(free.length<count) throw Error('ディスクの空き容量が不足しています');
    // §1.5・§2.4: 変更は容量検査後にまとめて行う。
    for(const n of old) this.setFat(n,255); const chosen=free.slice(0,count); for(let i=0;i<count;i++) { const n=chosen[i], part=payload.subarray(i*2048,(i+1)*2048); this.setFat(n,i+1<count?chosen[i+1]:0xc0+Math.ceil(part.length/256)); for(let s=0;s<8;s++) { const pos=this.sectors[n*8+s]; this.data.fill(0,pos,pos+256); this.data.set(part.subarray(s*256,(s+1)*256),pos); } }
    this.data.fill(255,p,p+16); this.data.fill(32,p,p+9); this.data.set(nb,p); this.data[p+9]=0; this.data[p+10]=chosen[0];
  }
  bytes(): Uint8Array { return this.data.slice(); }
}
// 文字コードのうち ASCII と半角カナのみを可逆に扱う。
export function decodePC(bytes: Uint8Array): string { return Array.from(bytes, b => { if (b <= 0x7f) return String.fromCharCode(b); if (b >= 0xa1 && b <= 0xdf) return String.fromCharCode(0xff61+b-0xa1); throw Error('未対応の文字コードです'); }).join(''); }
export function encodePC(s: string): Uint8Array { return Uint8Array.from(Array.from(s, ch => { const n=ch.codePointAt(0)!; if(n<=0x7f) return n; if(n>=0xff61 && n<=0xff9f) return n-0xff61+0xa1; throw Error(`未対応の文字: ${ch}`); })); }
