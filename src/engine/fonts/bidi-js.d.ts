declare module "bidi-js" {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl"): EmbeddingLevels;
    getBidiCharTypeName(char: string): string;
  }
  const factory: () => Bidi;
  export default factory;
}
