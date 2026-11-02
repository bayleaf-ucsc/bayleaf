// pdfjs-dist's types describe its package entry; src/pdf/worker.ts imports
// the build files by path (build-pdf.mjs pins and rewrites them), so these
// say what those paths are.
declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
