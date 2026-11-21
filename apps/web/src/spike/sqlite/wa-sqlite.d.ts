// SPIKE (phase 1 step 1): wa-sqlite ships its VFS examples as untyped JS.
declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  export class OPFSCoopSyncVFS {
    static create(name: string, module: unknown): Promise<OPFSCoopSyncVFS>;
    close(): Promise<void>;
  }
}
