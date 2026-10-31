# Keyframe

Put your own images and GIFs on a keyboard's built-in screen, from the browser.

Open the site in **Chrome or Edge on a computer** (it uses WebHID, which Safari
and Firefox don't have), plug the keyboard in with its USB cable, press
**Connect**, drop an image or GIF on each slot, and press **Upload to keyboard**.

- Two custom screen slots. Each upload rewrites both; an empty slot 2 reuses
  slot 1's first frame.
- Fill (drag to crop), fit or stretch to the 240×135 screen, frame cap and
  frame skipping for long GIFs, and animated previews.
- Load from a file, a link (Giphy page links work), a pasted image, or a
  drag from another tab. Some sites block other pages from downloading their
  images; save those first.
- **Sync clock** sets the keyboard's clock screen to your computer's time.
  Uploads do this too.

Uploads take about 3.5 seconds per frame. Each one rewrites the keyboard's
flash, so don't automate it every few seconds.

## Supported keyboards

| Keyboard | USB ID | Status |
|---|---|---|
| ZUOYA GMK104 | `320F:5055` | Tested, USB cable only |

Keyboards not in `DEVICES` in [`protocol.js`](protocol.js) are refused. Screen
protocols differ between makers, and a wrong command can leave a screen
unusable. Sister models with the same firmware may work; add them only after
testing. [`PROTOCOL.md`](PROTOCOL.md) documents the protocol and how it was
worked out.

## If the keyboard stops responding

Unplug the cable, switch the keyboard to a wireless mode and back to wired
(on the GMK104 that's the mode switch on the front), plug it back in, and
reconnect.

## Running locally

It's a static page with no build step:

```
python3 -m http.server 8000
```

then open `http://localhost:8000` in Chrome.

Unofficial. Not affiliated with any keyboard maker.
