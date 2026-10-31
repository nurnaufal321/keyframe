// Decoding images/GIFs and rendering them to 240x135 frames for the keyboard.
import { WIDTH, HEIGHT, MAX_FRAMES_PER_SLOT, toRGB565 } from './protocol.js?v=20261031155931';

const DEFAULT_FRAME_MS = 100;

// Returns { name, frames: [{ bitmap, ms }] }. GIF frames come back fully
// composited from ImageDecoder, so partial-frame GIFs render correctly.
export async function decodeFile(file) {
  const isAnimated = /gif|webp|png|avif/.test(file.type) && 'ImageDecoder' in window;
  if (isAnimated) {
    try {
      const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
      await decoder.tracks.ready;
      const count = Math.min(decoder.tracks.selectedTrack.frameCount, MAX_FRAMES_PER_SLOT);
      const frames = [];
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const ms = image.duration ? Math.max(20, Math.round(image.duration / 1000)) : DEFAULT_FRAME_MS;
        frames.push({ bitmap: await createImageBitmap(image), ms });
        image.close();
      }
      decoder.close();
      if (frames.length) return { name: file.name, frames };
    } catch (e) {
      console.warn('ImageDecoder failed, falling back to a still image', e);
    }
  }
  return { name: file.name, frames: [{ bitmap: await createImageBitmap(file), ms: DEFAULT_FRAME_MS }] };
}

// Which source frames get sent, after "every Nth" and the frame cap.
export function pickFrames(source, { every = 1, cap = 60 }) {
  const picked = [];
  for (let i = 0; i < source.frames.length && picked.length < cap; i += every) {
    const f = source.frames[i];
    // Fold skipped frames' time into the kept one so the preview speed holds.
    let ms = 0;
    for (let k = i; k < Math.min(i + every, source.frames.length); k++) ms += source.frames[k].ms;
    picked.push({ bitmap: f.bitmap, ms });
  }
  return picked;
}

// Draw one source bitmap onto a 240x135 context.
// fit: 'fill' (crop, panX/panY 0..1), 'fit' (letterbox on bg), 'stretch'.
export function drawFrame(ctx, bitmap, { fit = 'fill', panX = 0.5, panY = 0.5, bg = '#000000' }) {
  const w = bitmap.width, h = bitmap.height;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.imageSmoothingQuality = 'high';
  if (fit === 'stretch') {
    ctx.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
    return;
  }
  const scale = fit === 'fill' ? Math.max(WIDTH / w, HEIGHT / h) : Math.min(WIDTH / w, HEIGHT / h);
  const dw = w * scale, dh = h * scale;
  const dx = fit === 'fill' ? (WIDTH - dw) * panX : (WIDTH - dw) / 2;
  const dy = fit === 'fill' ? (HEIGHT - dh) * panY : (HEIGHT - dh) / 2;
  ctx.drawImage(bitmap, dx, dy, dw, dh);
}

// Render the picked frames to keyboard-ready RGB565 buffers.
export function renderForKeyboard(picked, opts) {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return picked.map((f) => {
    drawFrame(ctx, f.bitmap, opts);
    return toRGB565(ctx.getImageData(0, 0, WIDTH, HEIGHT));
  });
}
