// The pdf worker's message protocol, types only: src/pdf.ts posts a
// PdfRequest and reads a PdfReply, src/pdf/worker.ts the reverse. Each side
// casts once, where event data arrives; this is what crosses into the worker.

// -x -y -W -H, in pixels of the rendered page from its top left.
export interface PdfCrop { x: number; y: number; W: number | undefined; H: number | undefined }
interface PdfOpen { data: Uint8Array; password: string | undefined }
export interface PdfInfoJob extends PdfOpen { action: 'info'; scan: number }
export interface PdfTextJob extends PdfOpen { action: 'text'; first: number; last: number; layout: boolean }
export interface PdfRenderJob extends PdfOpen {
  action: 'render'; first: number; last: number; dpi: number; maxPixels: number; maxBytes?: number; type: string; crop: PdfCrop | null;
}
export type PdfJob = PdfInfoJob | PdfTextJob | PdfRenderJob;
export type PdfAction = PdfJob['action'];
// A job as the page's commands build it (the bytes added later), and as the engine posts it (with its id).
export type PdfJobInput = Omit<PdfInfoJob, 'data'> | Omit<PdfTextJob, 'data'> | Omit<PdfRenderJob, 'data'>;
export type PdfJobBody = Omit<PdfInfoJob, 'action'> | Omit<PdfTextJob, 'action'> | Omit<PdfRenderJob, 'action'>;
export interface PdfLoad { id: number; action: 'load'; pack: ArrayBuffer }
export interface PdfStop { id?: undefined; action: 'stop'; job: number }
export type PdfRequest = (PdfJob & { id: number }) | PdfLoad | PdfStop;

// pdf.js's document info dictionary (Title, Author, EncryptFilterName, IsAcroFormPresent ...).
export type PdfDocInfo = Record<string, string | number | boolean | undefined>;
export interface PdfInfo { pages: number; info: PdfDocInfo; javascript: boolean; size: [number, number]; rotate: number; noText: number[]; scanned: number }
export interface PdfTextPage { n: number; text: string; empty: boolean }
export interface PdfText { numPages: number; pages: PdfTextPage[] }
export interface PdfImage { n: number; width: number; height: number; bytes: Uint8Array }
export interface PdfRender { numPages: number; pages: PdfImage[] }
export interface PdfLoaded { files: number }
export type PdfResult = PdfInfo | PdfText | PdfRender | PdfLoaded;
export type PdfResultOf<A extends PdfAction> = A extends 'info' ? PdfInfo : A extends 'text' ? PdfText : PdfRender;

export type PdfReply =
  | { id: number; note: string; result?: undefined; error?: undefined }
  | { id: number; result: PdfResult; note?: undefined; error?: undefined }
  | { id: number; error: string; code?: string; name?: string; note?: undefined; result?: undefined };
