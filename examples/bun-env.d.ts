// Minimal ambient declaration so examples that boot via `bun run` typecheck
// without pulling @types/bun into the package. Examples use only Bun.serve.
declare const Bun: {
  serve(options: { port?: number; fetch: (req: Request) => Response | Promise<Response> }): unknown;
};
