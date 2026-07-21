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
