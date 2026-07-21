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
    <rect width="1200" height="630" fill="#202722"/>
    <circle cx="1040" cy="80" r="290" fill="#6F8275" opacity=".19"/>
    <circle cx="120" cy="660" r="330" fill="#AD5A3D" opacity=".18"/>
    <path d="M520 132h540" stroke="#E4D7B8" stroke-opacity=".18"/>
    <text x="520" y="278" fill="#F4EFE2" font-family="Georgia, serif" font-size="104" font-weight="600" letter-spacing="2">Yomu</text>
    <text x="526" y="344" fill="#CDBD9B" font-family="Arial, sans-serif" font-size="24" letter-spacing="8">LIGHT READING</text>
    <text x="526" y="422" fill="#B7C0B9" font-family="Arial, sans-serif" font-size="26">Read anywhere · Continue everywhere</text>
  </svg>`);
const ogIcon = await sharp(source).resize(300, 300).png().toBuffer();
await sharp(ogBackground)
  .composite([{ input: ogIcon, left: 142, top: 165 }])
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(new URL("../public/og.png", import.meta.url)));
