// RGB565 → ImageData(RGBA) の変換表(LUT)。
//
// 参考: WebX68k の src/rgb565.ts と同じ考え方。RGB565 は取りうる値が
// 65536通りしかないため、あらかじめ全パターンを計算した Uint32Array の表を
// 1回だけ作っておき、毎フレームの変換は「表を引いて1ピクセル1回書き」で済ませる。

/**
 * RGB565 の1ピクセルを ImageData(RGBA) の32bit値へ変換する表を作る。
 */
export function buildRgb565Lut(littleEndian: boolean): Uint32Array {
  const lut = new Uint32Array(65536);
  for (let px = 0; px < 65536; px++) {
    const r5 = (px >> 11) & 0x1f;
    const g6 = (px >> 5) & 0x3f;
    const b5 = px & 0x1f;
    const r = (r5 << 3) | (r5 >> 2);
    const g = (g6 << 2) | (g6 >> 4);
    const b = (b5 << 3) | (b5 >> 2);
    lut[px] = littleEndian
      ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  }
  return lut;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const LUT = buildRgb565Lut(IS_LITTLE_ENDIAN);

/**
 * ワーカーから届いた RGB565 の生バッファ（pitch考慮）を、
 * 既存の ImageData.data (Uint8ClampedArray) に変換して書き込む。
 */
export function convertRgb565ToImageData(
  src: Uint8Array,
  pitch: number,
  width: number,
  height: number,
  dst: Uint32Array,
): void {
  for (let y = 0; y < height; y++) {
    const rowOffset = y * pitch;
    const dstRowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const off = rowOffset + x * 2;
      const px = src[off] | (src[off + 1] << 8);
      dst[dstRowOffset + x] = LUT[px];
    }
  }
}
