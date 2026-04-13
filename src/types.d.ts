declare module 'pixelmatch' {
  function pixelmatch(
    img1: Buffer | Uint8Array,
    img2: Buffer | Uint8Array,
    output: Buffer | Uint8Array | null,
    width: number,
    height: number,
    options?: { threshold?: number; includeAA?: boolean; alpha?: number; diffColor?: [number, number, number]; diffColorAlt?: [number, number, number] }
  ): number;
  export default pixelmatch;
}
