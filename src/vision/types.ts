// Backend-agnostic OCR types — shared across tesseract / paddle / florence.

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number; // 0-100
}

export interface OcrResult {
  text: string;        // joined text
  words: OcrWord[];
  durationMs: number;
  backend: string;
}

export interface OcrOptions {
  lang?: string;       // backend-specific lang code(s)
}

export interface OcrBackend {
  readonly name: string;
  recognize(pngBuffer: Buffer, opts: OcrOptions): Promise<OcrResult>;
  shutdown(): Promise<void>;
}

export type BackendName = 'tesseract' | 'paddle' | 'florence';
