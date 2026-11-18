# WebQ88

[日本語](README.md)

A web player that runs QUASI88-libretro — a libretro port of the PC-8801 emulator
[QUASI88](https://www.eonet.ne.jp/~showtime/quasi88/) — in the browser, compiled
to WebAssembly with emscripten. Instead of the official ROM, it bundles a
clean-room compatible ROM,
[PC88Behavior](https://github.com/uraraworks/PC88Behavior), so it's a "just open
the URL and boot to an N88-BASIC-compatible screen" experience.

See [docs/API-DESIGN.md](docs/API-DESIGN.md) for the design of the automation API.

## Try it now

- **Live site**: <https://uraraworks.github.io/WebQ88/> (coming soon; for now, run it locally by following "Development")

No official ROM or commercial software disk images are bundled. You can load your own
D88 images by dragging and dropping them onto a drive row.

## Usage

An introduction page highlighting WebQ88's features is available at
<https://uraraworks.github.io/WebQ88/about.html>.

A player-facing usage page is available at
<https://uraraworks.github.io/WebQ88/help.html>.
Both pages can be switched between Japanese and English with the button at the
top right (`?lang=ja` / `?lang=en`). They can also be opened from **"Help"** at
the bottom of the screen.

### URL parameters

| Parameter | Meaning |
|---|---|
| `fd1=URL` / `fd2=URL` | URL of a disk image to put in drive 1 / drive 2 (percent-encode it) |
| `lib=URL` | Register it in the Disk Library without inserting it. Can be given multiple times |
| `run=1` | Boot automatically without pressing the start button |
| `bridge=1` | Connect to the WebSocket bridge for AI agents (see "MCP support") |
| `aspect=4:3` / `aspect=native` | Set the display aspect ratio |
| `filter=sharp` / `filter=nearest` | Set the display filter |
| `perf=1` | Show the performance overlay for this session |
| `volume=0`–`100` | Set the volume |
| `mute=0` / `mute=1` | Unmute / mute |
| `driveSound=0` / `driveSound=1` | Disable / enable drive sounds |
| `pause=1` | Start paused |

These display, audio and pause parameters apply only to the current visit and do not change saved settings. Invalid values are ignored.

- ZIP/LZH archives are extracted; every .d88/.88d inside is registered in the library and the first one is inserted.
- The host must support CORS. Dropbox share links are converted automatically.
  Google Drive needs a relay service (`VITE_DISK_PROXY` at build time). OneDrive is not supported.
- On later visits, your saved changes are restored. "Restore from source" in the library lets you fetch the image again.

### Toolbar

| Button | Action |
|---|---|
| Pause | Stop / resume emulation |
| Mute | Turn sound off / on (volume is in the "..." menu) |
| Fullscreen | Enlarge the screen |
| Soft keyboard | Show a PC-88 layout keyboard on screen |
| Virtual pad | Show a touch D-pad and buttons |
| Screenshot | Save the screen as a PNG |
| Disk Library | Pick a saved disk and insert it |
| ... (more actions) | Copy share URL, volume, display ratio, interpolation, gamepad/key assignment, numpad substitute, user ROM |
| Reset | Reset the machine |

### Drives (FDD1 / FDD2)

- Use "+" to pick a D88/88D/ZIP/LZH file, or drag and drop onto a drive row.
- "⏏" ejects, and "↓" downloads the current disk.
- "Blank FD" on FDD2 creates an empty N88-BASIC 2D data disk (not bootable).
- Writes are saved automatically to the browser (IndexedDB) every few seconds and
  inserted automatically next time. Clearing site data also clears the saves, so
  download any disk you care about.

### Keyboard and gamepad

- Alphanumerics, Enter, arrows, Shift, Ctrl, F1-F10 and so on are typed with the
  corresponding keys. Symbols are converted to PC-88 keys according to the
  character you typed.
- Turning on "Numpad substitute" makes the main number keys act as the numpad,
  and the arrow keys act as numpad 8, 2, 4 and 6 (for PCs without a numpad).
- "Gamepad / key assignment" lets you change the physical gamepad's buttons and
  axes, the dead zone, the virtual pad's parts, and the targets of the physical
  keyboard's keys. Settings are saved in the browser.

### User ROM (restricted mode)

"..." → User ROM lets you pick a ROM file of your own and restart with it. The
ROM is used only inside the browser and is never sent anywhere. While running
with a user ROM, you are in **restricted mode**, and part of the automation API
becomes unavailable (see [docs/API-DESIGN.md](docs/API-DESIGN.md) for the reason and scope).

## Bundled compatible ROM

`compat-rom/` contains only PC88Behavior's build output.

- PC88Behavior is a clean-room implementation written using only externally
  observable behavior as a guide, and contains none of the official ROM's bytes.
- The boot screen shows the compatible ROM's name, date and commit.
- A self-made kanji ROM generated from the free Shinonome font is bundled (glyphs differ from real hardware).
- See [compat-rom/README.md](compat-rom/README.md) for details.

## MCP support (remote control from AI agents)

`mcp/` contains an MCP server that lets AI agents operate WebQ88. Open the page
in a browser with `?bridge=1` and it connects to the MCP server on your machine,
allowing key input, text input, screen state queries, inserting and ejecting disks, and more. `find_text` and `wait_screen` search or wait for text without returning screen contents; they are unavailable in restricted mode. For setup, see
[mcp/README.md](mcp/README.md); for the list of commands and which are available,
see [docs/AUTOMATION.md](docs/AUTOMATION.md).

## Development

```sh
npm install
npm run dev       # 開発サーバー
npm run build     # 型チェック + 本番ビルド (dist/)
npm run preview   # ビルド成果物のプレビュー
```

To refresh the help screenshots, start `npm run dev` in a separate terminal, then run
`npm run capture-help`. Set `CHROME_PATH` to your Chrome executable if needed and
`WEBQ88_URL` to the development server URL (default: `http://localhost:5173`).
The player UI is currently Japanese, including in the English screenshots.

### Setup after cloning

This repository runs a contamination check (to prevent accidentally committing
official ROMs, disk images and the like) in a pre-commit hook, on the assumption
that it will be made public. After cloning, run the following.

```sh
git config core.hooksPath tools/hooks
```

### Building the core

The upstream source (quasi88-libretro) is not included in this repository.
`scripts/build-core.sh` fetches the pinned commit from `core/UPSTREAM`, applies
the distribution patches in `core/patches/`, and then builds with emscripten.

Prerequisites:
- emsdk installed at `~/emsdk`, with `emcc` 6.0.7
- [PC88Behavior](../PC88Behavior) located next to this repository, to generate the compatible ROM

```sh
./scripts/build-core.sh
# public/core/q88_libretro.{js,wasm} と q88_libretro.build.json が生成される
# （いずれも .gitignore 済みでコミットしない）

# 動作確認（互換ROMを自動生成してスモークテスト）
./scripts/smoke-core.sh

# 陰性対照（パッチなしの素の上流をビルドして、フォントが壊れることを確認）
NO_PATCH=1 OUT_DIR=/tmp/q88-no-patch ./scripts/build-core.sh
./scripts/smoke-core.sh /tmp/q88-no-patch

# 拡張ROMバンク切り替えの確認（試験ビルド専用シムを使う。配布物には入らない）
TEST_SHIM=1 OUT_DIR=/tmp/q88-test-shim ./scripts/build-core.sh
node scripts/smoke-ext-bank.cjs /tmp/q88-test-shim compat-rom
node scripts/smoke-ext-bank.cjs /tmp/q88-test-shim compat-rom --omit N88_2.ROM  # 陰性対照
```

The four patches in `core/patches/` fix four bugs in upstream libretro.c /
memory.c: "the built-in font and kanji ROM overwrite the font even when the font
ROM loaded successfully", "without N88.ROM/DISK.ROM it falls back to a
pseudo-BIOS of unknown origin", "`rom_filename` is referenced uninitialized in
load_system_file", and "the identity-mapping loop in handle_input() misses
KEY88_AT (='@'), so the '@' key never responds at all". Removing font.h and
pseudo_bios.h (their contents are huge byte arrays) is done with `rm` in the
build script rather than with a patch.

## License and bundled content

- The license for this repository's own code is unspecified.
- The core (QUASI88-libretro) is BSD 3-Clause licensed.
- The compatible ROM in `compat-rom/` (PC88Behavior's build output) is MIT licensed.
  The Shinonome font used to generate the bundled kanji ROM is in the public domain.
- **No official PC-8801 ROM or commercial software disk images are bundled.**
  A pre-commit hook (`tools/check_publishable.sh`) checks for accidental commits.
- Users are responsible for legally obtaining and using any ROM or disk image they load.

## Implemented features

- ROM-less boot with the compatible ROM (open the URL and start with one button; auto-start with `run=1`)
- Disk loading via URL parameters with fetch progress display, drag & drop, ZIP/LZH extraction
- Automatic disk saving via IndexedDB, with automatic insertion on the next launch
- Disk Library, blank FD creation, disk download, share URL copy
- Drive access lamps
- BGM and sound effects playback (audio output via AudioWorklet), mute and volume (settings saved in the browser)
- Pause, reset, fullscreen, screenshot (PNG)
- Switchable display ratio (4:3 / dot-for-dot) and interpolation (sharp bilinear / nearest)
- Soft keyboard, virtual pad, physical gamepad, key assignment, numpad substitute
- Boot with a user ROM (restricted mode)
- Automation via the MCP server and WebSocket bridge

## Not supported / known caveats

- The bundled kanji ROM is self-made from the Shinonome font, so its glyphs differ from real hardware.
- The compatible ROM is not identical to the official ROM. Some commercial software does not run.
- BASIC programs in intermediate-code format (SAVEd by the official ROM) cannot be read. Exchange
  programs in ASCII format (`SAVE "x",A`).
- Save states / load states are not supported.
- The player screen (buttons and menus) is Japanese only. The About and Help pages are available in both Japanese and English.

The drive row's file button lists, extracts, writes ASCII files to, and deletes files from standard 2D N88-BASIC disks. Use it only while the guest is not accessing the disk; the guest may retain a cache after reinsertion. MCP disk file operations are unavailable in restricted mode.
