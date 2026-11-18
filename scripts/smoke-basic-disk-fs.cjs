// 仕様書 §4 の空媒体を D88 の標準2Dセクタで構成する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-disk-fs-'));
try {
  cp.execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/basic-disk-fs.ts', '--target', 'ES2020', '--module', 'commonjs', '--skipLibCheck', '--outDir', tmp]);
  const { N88FS, encodePC, decodePC } = require(path.join(tmp, 'basic-disk-fs.js'));
  const trackSize = 16 * 272, header = 0x2b0;
  const disk = new Uint8Array(header + 80 * trackSize); disk.fill(255, header);
  const view = new DataView(disk.buffer); disk.fill(0, 0, header); view.setUint32(0x1c, disk.length, true);
  const sec = (t, s) => header + t * trackSize + s * 272 + 16;
  for (let t=0;t<80;t++) { view.setUint32(0x20+t*4, header+t*trackSize, true); for(let s=0;s<16;s++) { const p=sec(t,s)-16; disk.fill(0,p,p+16); disk[p]=Math.floor(t/2); disk[p+1]=t%2; disk[p+2]=s+1; disk[p+3]=1; view.setUint16(p+4,16,true); view.setUint16(p+14,256,true); } }
  disk.fill(0,sec(37,12),sec(37,12)+256);
  for(let s=13;s<16;s++) { disk[sec(37,s)+74]=0xa0; disk[sec(37,s)+75]=0xa0; }
  let image = new N88FS(disk); const original = image.list().free;
  const content = encodePC('10 PRINT "ｱｲｳ"\r\n'); image.write('TEST',content);
  image = new N88FS(image.bytes()); assert.equal(image.list().entries[0].name,'TEST'); assert.equal(decodePC(image.read('TEST')),decodePC(content)); assert.equal(image.list().free,original-2048);
  image.write('TEST',encodePC('ABC\r\n')); assert.equal(decodePC(image.read('TEST')),'ABC\r\n');
  image.delete('TEST'); image = new N88FS(image.bytes()); assert.equal(image.list().entries.length,0); assert.equal(image.list().free,original);
  const blank = new Uint8Array(fs.readFileSync('compat-rom/BLANK2D.D88'));
  const roundTrip = (bytes) => {
    let actual = new N88FS(bytes);
    assert.equal(actual.list().writeProtected, false, 'ブランクの書込禁止判定');
    actual.write('ROUND', content);
    actual = new N88FS(actual.bytes());
    assert.ok(actual.list().entries.some(entry => entry.name === 'ROUND'));
    assert.deepEqual(actual.read('ROUND'), content);
    actual.delete('ROUND');
    actual = new N88FS(actual.bytes());
    assert.ok(!actual.list().entries.some(entry => entry.name === 'ROUND'));
  };
  roundTrip(blank);
  const modified = blank.slice(), modifiedView = new DataView(modified.buffer);
  for (let t = 0; t < 80; t++) {
    const start = modifiedView.getUint32(0x20 + t * 4, true);
    for (let i = 0; i < 16; i++) {
      modified[start + i * 272 + 6] = 0x40;
      modified[start + i * 272 + 7] = 0x10;
      modified[start + i * 272 + 8] = 0xb0;
    }
    const first = modified.slice(start, start + 272);
    modified.copyWithin(start, start + 15 * 272, start + 16 * 272);
    modified.set(first, start + 15 * 272);
  }
  roundTrip(modified);
  console.log('N88FS 往復検査成功');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
