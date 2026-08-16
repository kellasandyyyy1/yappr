/**
 * Rasterises the brand icon into every size the web needs.
 *
 *   npm run icons
 *
 * Source of truth is public/favicon/yappr-penguins-icon.svg. Everything else in
 * public/favicon/ that is a .png or .ico is generated — do not hand-edit those,
 * re-run this instead.
 *
 * WHY THE WORDMARK IS NOT RASTERISED HERE
 *   yappr-wordmark.svg draws its text with a live <text> element in Poppins.
 *   A rasteriser only has the fonts installed on the machine running it, so the
 *   output would silently differ between a developer's laptop and CI. The
 *   wordmark is therefore shipped as SVG only, and the icon — which is pure
 *   geometry with no text — is the one that gets rasterised.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const DIR = path.join(process.cwd(), 'public', 'favicon');
const ICON = path.join(DIR, 'yappr-penguins-icon.svg');
const OG = path.join(DIR, 'yappr-logo.svg');

/** Background for contexts that cannot show transparency (OG cards, iOS). */
const DARK = { r: 5, g: 5, b: 7, alpha: 1 }; // #050507, the app background

const PNGS = [
  { file: 'favicon-16x16.png', size: 16 },
  { file: 'favicon-32x32.png', size: 32 },
  { file: 'favicon-48x48.png', size: 48 },
  // iOS ignores transparency and composites on black, so flatten deliberately.
  { file: 'apple-touch-icon.png', size: 180, flatten: true },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

const render = (svg, size) =>
  sharp(svg, { density: 384 }).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

async function main() {
  await fs.access(ICON);
  const written = [];

  for (const { file, size, flatten } of PNGS) {
    let pipeline = render(ICON, size);
    if (flatten) pipeline = pipeline.flatten({ background: DARK });
    const buffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    await fs.writeFile(path.join(DIR, file), buffer);
    written.push([file, `${size}×${size}`, buffer.length]);
  }

  // Maskable icon: Android crops to a circle and can clip up to 20% per edge,
  // so the artwork is inset into the safe zone rather than filling the square.
  // Without this the penguins' feet and the chat bubble get sliced off.
  const SAFE = 512;
  const inner = Math.round(SAFE * 0.72);
  const maskable = await sharp({
    create: { width: SAFE, height: SAFE, channels: 4, background: { r: 234, g: 244, b: 255, alpha: 1 } },
  })
    .composite([{ input: await render(ICON, inner).png().toBuffer(), gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(path.join(DIR, 'icon-512-maskable.png'), maskable);
  written.push(['icon-512-maskable.png', '512×512', maskable.length]);

  // favicon.ico. Browsers still request /favicon.ico unprompted, and sw.js
  // referenced one that never existed. The ICO container holds PNG payloads
  // directly, so this is a header plus the 16/32/48 PNGs already rendered.
  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map((s) => render(ICON, s).png({ compressionLevel: 9 }).toBuffer()));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type 1 = icon
  header.writeUInt16LE(sizes.length, 4); // image count

  let offset = 6 + 16 * sizes.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 0); // width  (0 means 256)
    e.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 1); // height
    e.writeUInt8(0, 2);                  // palette size
    e.writeUInt8(0, 3);                  // reserved
    e.writeUInt16LE(1, 4);               // colour planes
    e.writeUInt16LE(32, 6);              // bits per pixel
    e.writeUInt32LE(img.length, 8);      // payload size
    e.writeUInt32LE(offset, 12);         // payload offset
    offset += img.length;
    return e;
  });

  const ico = Buffer.concat([header, ...entries, ...images]);
  await fs.writeFile(path.join(DIR, 'favicon.ico'), ico);
  written.push(['favicon.ico', '16/32/48', ico.length]);

  // Open Graph / Twitter card. Fixed 1200×630 with the lockup centred on the
  // app background — social scrapers will not render SVG, and a transparent
  // PNG shows as black or white depending on the platform.
  const ogInner = await sharp(OG, { density: 384 })
    .resize(900, 322, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const og = await sharp({
    create: { width: 1200, height: 630, channels: 4, background: DARK },
  })
    .composite([{ input: ogInner, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(path.join(DIR, 'og-image.png'), og);
  written.push(['og-image.png', '1200×630', og.length]);

  const pad = Math.max(...written.map(([f]) => f.length));
  console.log(`Generated into public/favicon/ from ${path.basename(ICON)}:\n`);
  for (const [file, dims, bytes] of written) {
    console.log(`  ${file.padEnd(pad)}  ${dims.padStart(9)}  ${(bytes / 1024).toFixed(1)} kB`);
  }
  console.log(`\n${written.length} files written.`);
}

main().catch((err) => {
  console.error('Icon generation failed:', err.message);
  process.exit(1);
});
