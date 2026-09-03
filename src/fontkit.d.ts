declare module "fontkit" {
  export type FontkitFont = {
    unitsPerEm: number;
    variationAxes?: Record<string, { min: number; default: number; max: number }>;
    getVariation(settings: Record<string, number>): FontkitFont;
    layout(text: string): { advanceWidth: number };
  };

  export function openSync(path: string): FontkitFont;
}
