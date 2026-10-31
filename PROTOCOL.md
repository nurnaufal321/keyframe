# ZUOYA GMK104 screen protocol (reverse-engineered)

Source: static decompilation (Ghidra 12.2) of `Image Custom Tool.exe` from the
vendor installer `custom image tool.exe`. Nothing here has been sent to a
keyboard yet; it is what the Windows tool does, not a tested spec.

## Device

| | USB cable | 2.4 GHz dongle |
|---|---|---|
| VID:PID | `0x320F:0x5055` | `0x320F:0x5088` |
| Vendor interface | usage page `0xFF1C`, usage `0x92` (interface 3) | same page, interface 2 |
| Report | ID `0x04`, 64 bytes out / 64 in | same |
| Data per packet | 56 bytes (`0x38`) | 24 bytes (`0x18`) |
| Reply timeout | 1 s write, 120 s read | 5 s / 5 s |

## Packet (64 bytes, every command)

| Byte | Meaning |
|---|---|
| 0 | `0x04` report ID |
| 1–2 | checksum, little-endian: 16-bit sum of bytes 3..63 |
| 3 | command |
| 4 | payload length (≤ 56 wired) |
| 5–7 | offset, little-endian (24-bit for `0x21`, 16-bit for others) |
| 8–63 | payload, zero-padded |

The tool waits for a 64-byte reply after every packet and accepts it when
reply byte 3 equals the command. A reply byte 3 of `0xAA` in wireless mode is
treated as an error. A reply byte 7 of `0xFF` or `0xFE` aborts an upload.

## Commands seen

| Cmd | Payload | Used for |
|---|---|---|
| `0x01` | none | begin session (sent only when a device flag is set) |
| `0x02` | none | end session / apply (sent after every upload) |
| `0x21` | data, 24-bit offset | **screen image upload to flash**; tool sleeps 500 ms after the offset-0 packet (flash erase) |
| `0x23` | none | sent before an animated (multi-frame) upload |
| `0x0B` | RGB triples, 16-bit offset | per-key RGB lighting (not the screen) |
| `0x03 0x05 0x06 0x07 0x09 0x12 0x15 0x17 0x1A 0x1B 0x1C 0xAA` | various | keymap, macros, lighting, etc. (not mapped) |

## Image format

- 240 × 135 pixels (32,400 per frame).
- RGB565, **big-endian** (high byte first): `(R>>3)<<11 | (G>>2)<<5 | (B>>3)`.
- Raw frame = 64,800 bytes, padded with zeros to the next 32 KiB = **65,536 bytes per frame**.
- Animation: frames concatenated, each padded to 65,536.

## Static image upload sequence (from `FUN_004ac060`)

1. (`0x01` begin, only if the device flag at `+0x890` is set)
2. `0x21` × ceil(65536 / 56) = 1,171 packets, offset 0, 56, 112, …
3. `0x02` end

## Test results (2026-10-31, USB cable)

1. `0x21` × 1,171 + `0x02` **without** `0x01`: every packet acknowledged
   instantly, 2.9 s total, but nothing new appeared on the screen.
2. With `0x01` first: begin replied `04 01 00 01 00 00 00 00` (replies echo the
   header). The first `0x21` packet then got no reply within 1 s, consistent
   with a flash erase (the vendor tool waits up to 120 s). The script gave up.
3. Next run: `0x01` got no reply in 120 s, and then writes to the vendor
   interface failed outright. The keyboard needed a restart.

Lesson: once `0x01` is sent, keep waiting on the first `0x21` reply rather
than aborting, and close with `0x02` on any error.

Run 1 **did** write the image. A video of the keyboard shows the test image
for one frame each time the screen switches from the clock to the car
animation. The car is the custom animation; the upload replaced its frame 0,
and the keyboard still plays the old frame count.

4. Replies over USB are 8 bytes (`04`, checksum, cmd, 4 data/status bytes);
   matching on the offset was discarding them. Matching on cmd only fixed reads.
5. Setting frame count 1 made the car slot show the test image, but mixed
   with the old car frame: `0x21` writes without erasing (flash bits only go
   1 → 0).
6. `0x01` then `0x21` (with correct matching): no reply to `0x21` at all, and
   the vendor interface locked up again. `0x01` is only for settings writes.

7. **Working sequence (confirmed on the screen):** `0x23` (instant reply),
   `0x21` × 2,341 for two frames (frame 0 = slot 1, frame 1 = slot 2; 12 s),
   `0x02`, then settings write (`0x01`, `0x06` × 48 bytes, `0x02`) with
   `0x22 = 1`, `0x2E = 1` and the current clock. Both slots display cleanly,
   orientation and colours correct, and the clock picked up the new time.
   The factory car and bear animations are gone.

8. 24-frame GIF: frames 1–18 clean, 19–24 showed the old car underneath.
   `0x23` erases **(saved `0x22` + saved `0x2E`) frames** from offset 0, using
   the counts already on the keyboard, and replies only when finished
   (7.3 s for 25 frames). The counts were 1 + 17 before the first erase
   (18 frames) and 1 + 1 before the GIF upload (2 frames), which matches.
   Fix: save the new counts first, then `0x23`, then upload (as the tool does).

Frame layout in flash: slot 1's frames start at frame 0, slot 2's follow
immediately after (`0x22` frames in). Re-uploading means saving counts,
`0x23`, and rewriting both slots.

## Settings block (frame count and clock)

`FUN_0049dfa0` saves a 48-byte block with `0x06` (write, 16-bit offset), framed
by `0x01` … `0x02`, at offset `profile * 0x31`. `FUN_0049c0f0` reads it back
with `0x05` (len 48, offset 0, no `0x01`); read data is at reply bytes 8+.

| Block byte | Meaning |
|---|---|
| `0x00` | profile index (the tool writes its first argument here) |
| `0x01`–`0x08` | lighting mode, speed, brightness (`4 - x`), colour |
| `0x21` | custom screen slot (tool sets `slot + 1`) |
| `0x22` | **frame count of custom animation 1** (single-image upload sets 1) |
| `0x23`–`0x29` | clock in BCD: seconds, minutes, hours, ?, day, month - 1, year % 100 (exact order still to confirm) |
| `0x2B`–`0x2C` | 16-bit value from the tool (`+0x2840`) |
| `0x2E` | frame count of custom animation 2 |

Plan: read the block, change only `0x22` (and the clock if wanted), write it
back. Writing a block built from scratch would reset lighting settings.

## Practical limits

- ~1,171 round-trips per frame: expect a few seconds per full-screen update on USB.
- `0x21` writes to the keyboard's flash. SPI NOR flash typically survives ~100k
  erase cycles, so updating every minute could wear it out in months; every
  15 minutes is roughly years. No RAM-only "show now" command was found.
