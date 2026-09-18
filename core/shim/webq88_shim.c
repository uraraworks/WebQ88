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
 */

#include <string.h>

typedef unsigned char byte;

extern byte *main_ram;
extern byte *main_high_ram;
extern byte *sub_romram;

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
