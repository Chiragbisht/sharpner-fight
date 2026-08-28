// Sharpener skins. Purely cosmetic — every skin uses the identical collision
// radius and the identical physics. Nothing in src/game/ knows these exist,
// which is what guarantees a skin can never change a match outcome.

export interface Skin {
  id: string;
  name: string;
  body: string;
  light: string;
  dark: string;
}

export const SKINS: Skin[] = [
  { id: 'bubblegum',   name: 'Bubblegum',   body: '#ff4f9a', light: '#ffb3d3', dark: '#b01f60' },
  { id: 'firecracker', name: 'Firecracker', body: '#f4483c', light: '#ffb0a8', dark: '#a81f16' },
  { id: 'grape',       name: 'Grape',       body: '#b93fd6', light: '#e3a8f2', dark: '#741a8c' },
  { id: 'lemon',       name: 'Lemon',       body: '#f6c81f', light: '#ffe98f', dark: '#a8850a' },
  { id: 'steel',       name: 'Steel',       body: '#c3ccd4', light: '#eef2f6', dark: '#7b8791' },
  { id: 'tangerine',   name: 'Tangerine',   body: '#f4802c', light: '#ffc496', dark: '#a84c0d' },
];

export const DEFAULT_SKIN = 'bubblegum';

export function getSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function skinSrc(id: string): string {
  return `/sharpeners/${getSkin(id).id}.webp`;
}

const images = new Map<string, HTMLImageElement>();

function loadSkin(id: string): HTMLImageElement {
  const cached = images.get(id);
  if (cached) return cached;
  const img = new Image();
  img.src = skinSrc(id);
  images.set(id, img);
  return img;
}

export function preloadSkins(): void {
  SKINS.forEach((s) => loadSkin(s.id));
}

const silhouettes = new Map<string, HTMLCanvasElement>();

/**
 * A flat, solid-colour copy of the sprite in the skin's dark tone. Stacking a
 * few of these between the desk and the top face turns a flat photo into a
 * cuboid with real sides, using the sprite's own silhouette rather than a
 * rectangle that would not match its shape.
 */
export function skinSilhouette(id: string): HTMLCanvasElement | null {
  const cached = silhouettes.get(id);
  if (cached) return cached;
  const img = skinImage(id);
  if (!img) return null; // not cached until the source has decoded

  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext('2d');
  if (!x) return null;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = getSkin(id).dark;
  x.fillRect(0, 0, c.width, c.height);

  silhouettes.set(id, c);
  return c;
}

/** The decoded image, or null while it is still loading (draw the vector then). */
export function skinImage(id: string): HTMLImageElement | null {
  const img = images.get(id) ?? loadSkin(id);
  return img.complete && img.naturalWidth > 0 ? img : null;
}
