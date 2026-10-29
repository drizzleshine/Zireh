/**
 * Prepare an image on this device before it becomes evidence: decode it, redraw it on a canvas
 * of at most about 4 megapixels (8000 px on the long side), and re-encode as JPEG. Re-encoding
 * drops all EXIF data (GPS position, camera serial, timestamps). The original is never stored or sent.
 */
export async function prepareImage(file: File): Promise<{ dataUrl: string; width: number; height: number; removedBytes: number }> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Images over 25 MB aren't supported.");
  const bitmap = await createImageBitmap(file);
  // Capped by area, not by the long side, so a tall screenshot keeps its full width and stays readable.
  const scale = Math.min(1, Math.sqrt(4_000_000 / (bitmap.width * bitmap.height)), 8000 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataUrl, width, height, removedBytes: Math.max(0, file.size - Math.round((dataUrl.length * 3) / 4)) };
}
