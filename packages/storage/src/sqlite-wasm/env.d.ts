// Vite resolves `?url` imports; wa-sqlite ships its VFS examples as untyped JS.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  export class OPFSCoopSyncVFS {
    static create(name: string, module: unknown): Promise<OPFSCoopSyncVFS>;
    close(): Promise<void>;
  }
}
