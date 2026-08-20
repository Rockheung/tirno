// Backend-agnostic OCR types — shared across local (paddle / florence) and
// cloud (claude / openai / gemini) backends.

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
  readonly kind: 'local' | 'cloud';
  recognize(pngBuffer: Buffer, opts: OcrOptions): Promise<OcrResult>;
  shutdown(): Promise<void>;
}

export type LocalBackendName = 'paddle' | 'florence';
export type CloudBackendName = 'claude' | 'openai' | 'gemini';
export type BackendName = LocalBackendName | CloudBackendName;

export const LOCAL_BACKENDS: LocalBackendName[] = ['paddle', 'florence'];
export const CLOUD_BACKENDS: CloudBackendName[] = ['claude', 'openai', 'gemini'];
export const ALL_BACKENDS: BackendName[] = [...LOCAL_BACKENDS, ...CLOUD_BACKENDS];

export const DEFAULT_BACKEND: BackendName = 'paddle';
