/*
 * core/shim/webq88_shim.c
 *
 * WebQ88 がリンク時に追加する薄いシム。上流 quasi88-libretro のソースには
 * 一切手を入れず（core/patches/ ではなく、このファイル単体を追加リンクする
 * ことで実現する）、「利用者が公式ROMを読み込んだセッションでは、コアの外へ
 * メモリ内容を出す口を閉じる」ための一方向の掛け金を提供する。
 *
 * 設計方針: ../../docs/API-DESIGN.md 第3節・第6節。
 * 呼び出し元(JS側)の判定に加えて、ここでも独立に同じ判定を行う
 * ("二重に止める")。JS側の判定を故意に迂回しても、ここで拒否される。
 *
 * - webq88_restrict()      : 一方向の掛け金。呼ぶと二度と戻せない
 *                            (戻す関数は意図的に用意しない)。
 * - webq88_is_restricted() : 現在の状態を返す(0/1)。
 * - webq88_ram_read/write(): RAM 領域だけを読み書きする。restricted 中は
 *                            常に -1 を返し、何も読み書きしない。
 *                            ROM を指す配列(main_rom, main_rom_ext,
 *                            main_rom_n, sub_romram の 0x0000-0x3FFF,
 *                            kanji_rom, jisho_rom, font_*)を返す口は
 *                            意図的に用意しない。
 * - webq88_text_cols/webq88_text_snapshot(): テキスト画面の文字コードだけを
 *                            取り出す(属性・色は含めない)。screen_signature
 *                            (docs/API-DESIGN.md 第4節)の署名計算に
 *                            互換・制限どちらのモードでも必要なため、
 *                            この2関数だけは restricted を見ない
 *                            (掛け金の対象外。本文を返さない用途にしか
 *                            使わない設計はJS側=core-worker.jsで担保する)。
 *
 * region:
 *   0 = main_ram      (メインRAM,        64KB = 0x10000)
 *   1 = main_high_ram (高速RAMの裏,       4KB = 0x1000)
 *   2 = サブ側RAM     (sub_romram の 0x4000-0x7FFF, 16KB = 0x4000)
 *
 * main_ram / main_high_ram / sub_romram は上流の src/memory.c で
 * mem_alloc() により確保される byte* グローバル(src/memory.h で extern
 * 宣言されている)。quasi88.h / memory.h をインクルードすると他の大量の
 * マクロ・型定義まで巻き込むため、ここでは意図的に extern 宣言だけを
 * 重複させる(byte の実体は unsigned char で一致するのでリンクできる)。
 *
 * テキスト画面の抽出は src/crtcdmac.c の crtc_make_text_attr() を読んで
 * 決めた: 文字コードは、表示モード(non_separate / transparent)いずれでも
 * main_ram 上の text_dma_addr.W を先頭に、1行 crtc_byte_per_line バイトごと、
 * 各行の先頭 crtc_sz_columns バイトに"属性を挟まず"連続して並ぶ(属性は
 * それとは別に、行内のさらに後ろ or 1バイトおきに置かれるだけで、文字コード
 * 自体の並びには影響しない)。text_dma_addr は dmac_address[2] (crtcdmac.h の
 * `#define text_dma_addr dmac_address[2]`)。pair は quasi88.h で
 * union{ struct{byte l,h;} B; word W; } (LSB_FIRST=リトルエンディアン、
 * このビルドはwasm=常にLSB_FIRST相当) と定義されており、ここでは
 * quasi88.h を巻き込まずに同じレイアウトの型を単体で再定義して使う。
 */

#include <string.h>

typedef unsigned char byte;
typedef unsigned short word;

typedef union {
    struct { byte l, h; } B;
    word W;
} webq88_pair;

extern byte *main_ram;
extern byte *main_high_ram;
extern byte *sub_romram;

/* src/crtcdmac.c のグローバル(crtcdmac.h で extern 宣言されている実体)。 */
extern int crtc_sz_lines;    /* 現在の表示行数 (20〜25) */
extern int crtc_sz_columns;  /* 現在の表示桁数 (2〜80) */
extern int crtc_byte_per_line; /* 1行あたりのメモリバイト数 */
extern unsigned char sys_ctrl; /* OUT[30] SystemCtrl。bit0=1:80桁 / 0:40桁 */
extern int text_display;     /* 0=TEXT_DISABLE 1=ATTR_ONLY 2=ENABLE */
extern webq88_pair dmac_address[4]; /* [2] が text_dma_addr */

#define WEBQ88_TEXT_MAX_COLS 80
#define WEBQ88_TEXT_MAX_ROWS 25

static int g_webq88_restricted = 0;

#define WEBQ88_REGION_MAIN_RAM      0
#define WEBQ88_REGION_MAIN_HIGH_RAM 1
#define WEBQ88_REGION_SUB_RAM       2

#define WEBQ88_MAIN_RAM_SIZE      0x10000u
#define WEBQ88_MAIN_HIGH_RAM_SIZE 0x1000u
#define WEBQ88_SUB_RAM_OFFSET     0x4000u
#define WEBQ88_SUB_RAM_SIZE       0x4000u

void webq88_restrict(void)
{
    g_webq88_restricted = 1;
}

int webq88_is_restricted(void)
{
    return g_webq88_restricted;
}

/* region の実体ポインタと領域サイズを解決する。無効な region なら 0 を返す。 */
static int webq88_resolve_region(int region, byte **base, unsigned int *size)
{
    switch (region) {
    case WEBQ88_REGION_MAIN_RAM:
        if (!main_ram) return 0;
        *base = main_ram;
        *size = WEBQ88_MAIN_RAM_SIZE;
        return 1;
    case WEBQ88_REGION_MAIN_HIGH_RAM:
        if (!main_high_ram) return 0;
        *base = main_high_ram;
        *size = WEBQ88_MAIN_HIGH_RAM_SIZE;
        return 1;
    case WEBQ88_REGION_SUB_RAM:
        if (!sub_romram) return 0;
        *base = sub_romram + WEBQ88_SUB_RAM_OFFSET;
        *size = WEBQ88_SUB_RAM_SIZE;
        return 1;
    default:
        return 0;
    }
}

int webq88_ram_read(int region, unsigned int offset, unsigned int len, unsigned char *dst)
{
    byte *base;
    unsigned int size;

    if (g_webq88_restricted) return -1;
    if (!dst) return -1;
    if (!webq88_resolve_region(region, &base, &size)) return -1;
    if (offset > size || len > size - offset) return -1; /* 範囲外(オーバーフロー安全) */

    memcpy(dst, base + offset, len);
    return 0;
}

int webq88_ram_write(int region, unsigned int offset, unsigned int len, const unsigned char *src)
{
    byte *base;
    unsigned int size;

    if (g_webq88_restricted) return -1;
    if (!src) return -1;
    if (!webq88_resolve_region(region, &base, &size)) return -1;
    if (offset > size || len > size - offset) return -1;

    memcpy(base + offset, src, len);
    return 0;
}

/*
 * 現在の表示桁数(1〜80)を返す。screen_signature/screen_text 呼び出し側が
 * webq88_text_snapshot() の戻り値(総バイト数)から行数を逆算するために使う。
 */
static int webq88_text_stride(void)
{
    /* I/O 0x30 の bit0 (ハードウェアの桁数選択)。40桁のとき文字は2バイトおき。 */
    return (sys_ctrl & 0x01) ? 1 : 2;
}

int webq88_text_cols(void)
{
    int cols = crtc_sz_columns;
    if (cols < 1) cols = 1;
    if (cols > WEBQ88_TEXT_MAX_COLS) cols = WEBQ88_TEXT_MAX_COLS;
    if (webq88_text_stride() == 2) cols = (cols + 1) / 2;
    return cols;
}

/*
 * テキスト画面の文字コードだけを dst に詰めて返す(属性・色は含めない)。
 * 戻り値は書き込んだバイト数(= 現在の行数×桁数)。dst が NULL、または
 * maxLen が足りない場合は -1。restricted は見ない(この関数のコメント冒頭参照)。
 */
int webq88_text_snapshot(unsigned char *dst, unsigned int maxLen)
{
    int rows = crtc_sz_lines;
    int stride = webq88_text_stride();
    int cols = webq88_text_cols();
    unsigned int need;
    unsigned int base_addr;
    int i, j;

    if (!dst) return -1;
    if (rows < 0) rows = 0;
    if (rows > WEBQ88_TEXT_MAX_ROWS) rows = WEBQ88_TEXT_MAX_ROWS;

    need = (unsigned int)rows * (unsigned int)cols;
    if (need > maxLen) return -1;

    if (text_display == 0 /* TEXT_DISABLE */ || !main_ram) {
        memset(dst, 0, need);
        return (int)need;
    }

    base_addr = dmac_address[2].W;
    for (i = 0; i < rows; i++) {
        unsigned int rowAddr = (base_addr + (unsigned int)i * (unsigned int)crtc_byte_per_line) & 0xFFFFu;
        for (j = 0; j < cols; j++) {
            unsigned int addr = (rowAddr + (unsigned int)(j * stride)) & 0xFFFFu;
            dst[i * cols + j] = main_ram[addr];
        }
    }
    return (int)need;
}

/*
 * ディスク操作の薄い口。上流の quasi88_disk_insert()/quasi88_disk_eject()
 * (quasi88.c)と get_drive_ready()(fdc.c)をそのまま呼ぶだけで、ここには
 * 判断を持たない。RAM を返す口ではないので restricted は見ない
 * (ディスクの中身の取り出し制限は JS 層の get_disk_image で行う)。
 *
 * - webq88_disk_insert(): drv は 0=ドライブ1 / 1=ドライブ2。path は MEMFS 上の
 *                         D88 イメージ。成功なら 1、失敗なら 0(上流 TRUE/FALSE)。
 * - webq88_disk_eject():  イジェクト。上流は disk_image_exist() が偽でも安全。
 * - webq88_drive_busy():  アクセスランプ。get_drive_ready() は「FDC が drv を
 *                         選択して処理中」のとき 0 を返す(status.c のランプ判定と同じ)。
 *                         ランプONなら 1。
 */
extern int quasi88_disk_insert(int drv, const char *filename, int image, int ro);
extern void quasi88_disk_eject(int drv);
extern int get_drive_ready(int drv);

int webq88_disk_insert(int drv, const char *path)
{
    if (drv < 0 || drv > 1 || !path) return 0;
    return quasi88_disk_insert(drv, path, 0, 0);
}

void webq88_disk_eject(int drv)
{
    if (drv < 0 || drv > 1) return;
    quasi88_disk_eject(drv);
}

int webq88_drive_busy(int drv)
{
    if (drv < 0 || drv > 1) return 0;
    return get_drive_ready(drv) ? 0 : 1;
}
