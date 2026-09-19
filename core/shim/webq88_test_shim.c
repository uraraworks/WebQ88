/*
 * core/shim/webq88_test_shim.c
 *
 * 試験ビルド専用のシム。配布ビルド(public/core/)には入らない
 * (scripts/build-core.sh で TEST_SHIM=1 のときだけコンパイル・リンクされる)。
 * 配布用シム(webq88_shim.c)には「ROM内容を読む口を足さない」という設計方針
 * (webq88_shim.c 冒頭コメント参照)があるため、拡張ROMバンク切り替えの確認は
 * こちらに独立して置く。
 *
 * webq88_shim.c と同じ二重の掛け金を守る: webq88_is_restricted() が真の間は
 * 常に -1 を返し、何も読み書きしない。
 *
 * main_io_out(0x32,...) / main_io_out(0x71,...) の副作用について
 * (src/pc88main.c の該当分岐を読んで確認):
 *   - 0x32 (misc_ctrl) 書き込み: chg&MISC_CTRL_ANALOG のときパレット再描画
 *     フラグを立てる程度で、また sound_port&SD_PORT_44_45 のとき割り込み
 *     マスクを更新する。読み出しは即座に元の misc_ctrl へ書き戻すため、
 *     この2つの副作用も呼び出し前の値に戻る。CPU実行を1命令も進めない
 *     (retro_run を呼ばない)ので、その他の状態(サウンド、CRTC等)は変化しない。
 *   - 0x71 (ext_rom_bank) 書き込み: main_memory_mapping_0000_7fff() を
 *     呼び直すだけで、0x32 と同様に副作用は無い。
 *   どちらも main_memory_mapping_0000_7fff() 経由で read_mem_6000_7fff の
 *   ポインタを差し替えるだけなので、読み終えて元の値に書き戻せば
 *   エミュレーション状態への影響は残らない。許容範囲と判断した。
 */

#include <string.h>

typedef unsigned char byte;
typedef unsigned short word;

extern int webq88_is_restricted(void);

/* src/pc88main.c のグローバル(pc88main.h で extern 宣言されている実体)。 */
extern byte misc_ctrl;      /* I/O[32] 各種Ctrl */
extern byte ext_rom_bank;   /* I/O[71] 拡張ROM BANK */
extern void main_io_out( byte port, byte data );
extern byte main_mem_read( word addr );

#define WEBQ88_TEST_MISC_CTRL_PORT 0x32
#define WEBQ88_TEST_EXT_ROM_PORT   0x71
#define WEBQ88_TEST_EBANK_MASK     0x03u /* MISC_CTRL_EBANK */
#define WEBQ88_TEST_EXT_ROM_NOT    0x01u /* EXT_ROM_NOT: 立っていると通常ROM */

#define WEBQ88_TEST_WINDOW_BASE 0x6000u
#define WEBQ88_TEST_WINDOW_SIZE 0x2000u

/*
 * bank=-1: 現状のまま、bank=0..3: そのバンクを選択した状態で、
 * main_mem_read(0x6000+i) (i=0..0x1FFF) を dst に読む。読み終えたら
 * misc_ctrl / ext_rom_bank を呼び出し前の値へ戻す。
 * restricted 中は何もせず -1。
 */
int webq88_test_window_read(int bank, unsigned char *dst)
{
    byte saved_misc_ctrl;
    byte saved_ext_rom_bank;
    unsigned int i;

    if (webq88_is_restricted()) return -1;
    if (!dst) return -1;
    if (bank < -1 || bank > 3) return -1;

    if (bank < 0) {
        for (i = 0; i < WEBQ88_TEST_WINDOW_SIZE; i++) {
            dst[i] = main_mem_read((word)(WEBQ88_TEST_WINDOW_BASE + i));
        }
        return 0;
    }

    saved_misc_ctrl = misc_ctrl;
    saved_ext_rom_bank = ext_rom_bank;

    main_io_out(WEBQ88_TEST_MISC_CTRL_PORT,
                (byte)((saved_misc_ctrl & ~WEBQ88_TEST_EBANK_MASK) | (bank & WEBQ88_TEST_EBANK_MASK)));
    main_io_out(WEBQ88_TEST_EXT_ROM_PORT,
                (byte)(saved_ext_rom_bank & ~WEBQ88_TEST_EXT_ROM_NOT));

    for (i = 0; i < WEBQ88_TEST_WINDOW_SIZE; i++) {
        dst[i] = main_mem_read((word)(WEBQ88_TEST_WINDOW_BASE + i));
    }

    main_io_out(WEBQ88_TEST_MISC_CTRL_PORT, saved_misc_ctrl);
    main_io_out(WEBQ88_TEST_EXT_ROM_PORT, saved_ext_rom_bank);

    return 0;
}
