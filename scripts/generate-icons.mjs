import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sizes = [192, 512];
const sourcePath = fileURLToPath(new URL("../public/yomu-icon.svg", import.meta.url));
const source = await readFile(sourcePath);

for (const size of sizes) {
  const outputPath = fileURLToPath(new URL(`../public/icon-${size}.png`, import.meta.url));
  await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toFile(outputPath);
}

const ogBackground = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="ogbg" x1="92" y1="44" x2="1100" y2="610" gradientUnits="userSpaceOnUse">
        <stop stop-color="#F8F7F1"/>
        <stop offset="1" stop-color="#E3E8E5"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#ogbg)"/>
    <circle cx="1040" cy="70" r="310" fill="#567991" opacity=".13"/>
    <circle cx="110" cy="650" r="340" fill="#E7B85C" opacity=".17"/>
    <path d="M410 160c-116-30-220-15-310 45v285c92-46 197-53 310-20M790 160c116-30 220-15 310 45v285c-92-46-197-53-310-20" fill="none" stroke="#567991" stroke-width="3" opacity=".1"/>
  </svg>`);
const ogIcon = await sharp(source).resize(330, 330).png().toBuffer();
await sharp(ogBackground)
  .composite([{ input: ogIcon, left: 435, top: 150 }])
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(new URL("../public/og.png", import.meta.url)));
