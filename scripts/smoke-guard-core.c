/* 自作バイト列のみ。実際のZ80命令ループとshimを検査する（ROM不要）。
 * macOS:
 * cc -O2 -I_local/quasi88-libretro-src/src \
 *   -I_local/quasi88-libretro-src/src/LIBRETRO \
 *   -I_local/quasi88-libretro-src/src/LIBRETRO/libretro-common/include -Wl,-dead_strip \
 *   scripts/smoke-guard-core.c _local/quasi88-libretro-src/src/z80.c \
 *   core/shim/webq88_shim.c -o /tmp/webq88-smoke-guard-core
 */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "quasi88.h"
#include "z80.h"
#include "webq88_guard.h"

z80arch z80main_cpu;
int verbose_z80, webq88_guard_rom_mapped;
static byte ram[65536];
static int interrupt_once;
void webq88_guard_enable(int);
void webq88_guard_set_entries(const uint16_t *, int);
void webq88_guard_set_relay_sources(const uint32_t *, int);
int webq88_guard_poll(uint32_t *, uint32_t *);
void webq88_restrict(void);
static byte read_byte(word a) { return ram[a]; }
static void write_byte(word a, byte b) { ram[a] = b; }
static byte in_byte(byte p) { (void)p; return 0; }
static void out_byte(byte p, byte b) { (void)p; webq88_guard_rom_mapped = !(b & 2); }
static void intr_update(void) {
    z80main_cpu.icount = 100;
    z80main_cpu.INT_active = interrupt_once;
    interrupt_once = 0;
}
static int intr_ack(void) { return 0xff; }
static void init(void) {
    memset(ram, 0, sizeof ram);
    memset(&z80main_cpu, 0, sizeof z80main_cpu);
    z80main_cpu.fetch = z80main_cpu.mem_read = read_byte;
    z80main_cpu.mem_write = write_byte;
    z80main_cpu.io_read = in_byte;
    z80main_cpu.io_write = out_byte;
    z80main_cpu.intr_update = intr_update;
    z80main_cpu.intr_ack = intr_ack;
    z80_reset(&z80main_cpu);
    z80main_cpu.PC.W = 0xe000;
    z80main_cpu.SP.W = 0xf000;
    webq88_guard_rom_mapped = 1;
    interrupt_once = 0;
}
static void steps(int n) { while (n--) z80_emu(&z80main_cpu, 1); }
static void call(word dst) {
    ram[0xe000] = 0xcd; ram[0xe001] = dst & 255; ram[0xe002] = dst >> 8;
    ram[0xe003] = 0x76;
}
static void set_return(word dst) { ram[0xf000] = dst & 255; ram[0xf001] = dst >> 8; }
static void stopped(word dst, word src) {
    uint32_t a, s;
    assert(webq88_guard_poll(&a, &s) == 1 && a == dst && s == src);
    assert(webq88_guard_poll(&a, &s) == 0);
    assert(webq88_guard_stopped && z80main_cpu.PC.W == dst);
    steps(3);
    assert(z80main_cpu.PC.W == dst); /* poll後も命令を実行しない */
}
int main(void) {
    const uint16_t entries[] = {0, 8, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x66, 0x37c9};
    init(); call(0x1234); steps(2); assert(!webq88_guard_stopped); /* 既定 */
    webq88_guard_set_entries(entries, sizeof entries / sizeof *entries);
    init(); call(0x1234); steps(2); assert(!webq88_guard_stopped); /* setだけでは有効にしない */
    webq88_guard_enable(1);
    init(); call(0x1234); steps(2); stopped(0x1234, 0xe000);
    init(); ram[0xe000]=0xc3; ram[0xe001]=0x34; ram[0xe002]=0x12;
    steps(2); stopped(0x1234, 0xe000); /* JP */
    init(); call(0x37c9); ram[0x37c9]=0xc9; steps(4); assert(!webq88_guard_stopped);
    /* 中継領域内と両端の直外でJP/CALLを確認する。 */
    const uint32_t relays[] = {0xff9d, 0xffbc, 0xffdc, 0xffeb};
    for (unsigned r=0; r<2; r++) for (unsigned op=0; op<2; op++) {
        const word sources[] = {relays[r*2], relays[r*2+1]-1,
                                relays[r*2]-1, relays[r*2+1]};
        for (unsigned j=0; j<4; j++) {
            webq88_guard_set_entries(entries, sizeof entries / sizeof *entries);
            webq88_guard_set_relay_sources(relays, 2); webq88_guard_enable(1);
            init(); word src=sources[j]; z80main_cpu.PC.W=src;
            ram[src]=op ? 0xcd : 0xc3; ram[(word)(src+1)]=0x34; ram[(word)(src+2)]=0x12;
            steps(2);
            if (j<2) assert(!webq88_guard_stopped); else stopped(0x1234,src);
        }
    }
    webq88_guard_set_entries(entries, sizeof entries / sizeof *entries); webq88_guard_enable(1);
    init(); z80main_cpu.PC.W=0xff9d; ram[0xff9d]=0xc3; ram[0xff9e]=0x34; ram[0xff9f]=0x12;
    steps(2); stopped(0x1234,0xff9d); /* 一覧再設定で中継元なし */
    /* ROM -> RAM hook -> RET -> 非公開ROM番地 */
    init(); z80main_cpu.PC.W=0x1200;
    ram[0x1200]=0xcd; ram[0x1201]=0; ram[0x1202]=0xe0; ram[0xe000]=0xc9;
    steps(3); assert(!webq88_guard_stopped && z80main_cpu.PC.W==0x1204);
    /* 全RET条件を成立させ、EDのRETI/RETNも確認 */
    const byte rets[]={0xc9,0xc0,0xc8,0xd0,0xd8,0xe0,0xe8,0xf0,0xf8,0x4d,0x45};
    for (unsigned i=0;i<sizeof rets;i++) {
        init(); set_return(0x1234);
        byte op=rets[i];
        z80main_cpu.AF.B.l=(op==0xc8?0x40:op==0xd8?1:op==0xe8?4:op==0xf8?0x80:0);
        if (i>=9) { ram[0xe000]=0xed; ram[0xe001]=op; }
        else ram[0xe000]=op;
        steps(2); assert(!webq88_guard_stopped && z80main_cpu.PC.W==0x1235);
    }
    /* RAMの下位アドレス、およびバンク切替命令後の遷移 */
    init(); webq88_guard_rom_mapped=0; call(0x1234); steps(2); assert(!webq88_guard_stopped);
    init(); webq88_guard_rom_mapped=0; z80main_cpu.PC.W=0x1232;
    ram[0x1232]=0xd3; ram[0x1233]=0x31; z80main_cpu.AF.B.h=0;
    steps(2); stopped(0x1234,0x1232);
    /* prefix operandを独立命令と扱わない */
    init(); z80main_cpu.PC.W=0x7fff; ram[0x7fff]=0xed; ram[0x8000]=0x44;
    steps(1); assert(!webq88_guard_previous_ram);
    /* RSTとINTは一覧に従う。RET直後のINTも除外しない */
    init(); ram[0xe000]=0xff; steps(2); assert(!webq88_guard_stopped);
    uint16_t only_zero=0;
    webq88_guard_set_entries(&only_zero,1); webq88_guard_enable(1);
    init(); ram[0xe000]=0xff; steps(2); stopped(0x38,0xe000);
    init(); ram[0xe000]=0xc9; set_return(0xe010);
    z80main_cpu.IFF=INT_ENABLE; z80main_cpu.IM=1; interrupt_once=1;
    steps(2); stopped(0x38,0xe000);
    webq88_guard_set_entries(entries, sizeof entries / sizeof *entries); webq88_guard_enable(1);
    init(); z80main_cpu.IFF=INT_ENABLE; z80main_cpu.IM=1; interrupt_once=1;
    steps(2); assert(!webq88_guard_stopped);
    /* sub CPUは対象外 */
    init(); call(0x1234); z80arch sub=z80main_cpu; z80_emu(&sub,30); assert(!webq88_guard_stopped);
    webq88_guard_set_entries(NULL,0); webq88_guard_enable(1); assert(!webq88_guard_enabled);
    webq88_guard_set_entries(entries, sizeof entries / sizeof *entries);
    webq88_restrict(); webq88_guard_enable(1);
    init(); call(0x1234); steps(2); assert(!webq88_guard_enabled && !webq88_guard_stopped);
    puts("PASS: guard core (CALL/JP, entries, RET, mapping, prefixes, RST/INT, sub CPU, reset/poll, default/restricted)");
}
