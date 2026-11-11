import { readMetadata, editMetadata, type EditOutcome, type MetadataReport, type ReadOptions } from "./document.js";
import { ImgwandError } from "./errors.js";
import type { MetadataField } from "./fields.js";
import { readImageFile, writeFileAtomic, type WriteOptions, type WriteResult } from "./fileio.js";
import { resolveSelectors } from "./selectors.js";

/**
 * A stateful view of one image for interactive editing: removals and new values are staged (and can be undone)
 * until save() writes them in one verified, atomic step.
 */
export class ImageDocument {
  private stagedRemovals = new Set<string>();
  private stagedSets = new Map<string, string>();
  private history: { removals: Set<string>; sets: Map<string, string> }[] = [];

  private constructor(
    private bytesValue: Uint8Array,
    private reportValue: MetadataReport,
    readonly path: string | undefined,
    private readonly readOptions: ReadOptions,
  ) {}

  static async open(input: string | Uint8Array, readOptions: ReadOptions = {}): Promise<ImageDocument> {
    const bytes = typeof input === "string" ? await readImageFile(input) : input;
    return new ImageDocument(bytes, await readMetadata(bytes, readOptions), typeof input === "string" ? input : undefined, readOptions);
  }

  get bytes(): Uint8Array {
    return this.bytesValue;
  }

  get report(): MetadataReport {
    return this.reportValue;
  }

  get fields(): readonly MetadataField[] {
    return this.reportValue.fields;
  }

  get pendingRemovals(): ReadonlySet<string> {
    return this.stagedRemovals;
  }

  get pendingSets(): ReadonlyMap<string, string> {
    return this.stagedSets;
  }

  get dirty(): boolean {
    return this.stagedRemovals.size > 0 || this.stagedSets.size > 0;
  }

  private checkpoint(): void {
    this.history.push({ removals: new Set(this.stagedRemovals), sets: new Map(this.stagedSets) });
    if (this.history.length > 100) this.history.shift();
  }

  /** Stages removal of the fields matched by the selectors (including everything that must go with them). */
  stageRemove(selectors: readonly string[]): ReadonlySet<string> {
    const { ids, unmatched } = resolveSelectors(this.fields, selectors);
    if (unmatched.length > 0) throw new ImgwandError("UNKNOWN_FIELD", `No such field: ${unmatched.join(", ")}`);
    this.checkpoint();
    for (const id of ids) {
      this.stagedRemovals.add(id);
      this.stagedSets.delete(id);
    }
    return ids;
  }

  /** Un-stages a removal (and everything that was staged together with it). */
  unstageRemove(selectors: readonly string[]): void {
    const { ids } = resolveSelectors(this.fields, selectors);
    this.checkpoint();
    for (const id of ids) this.stagedRemovals.delete(id);
  }

  stageSet(id: string, value: string): void {
    this.checkpoint();
    this.stagedRemovals.delete(id);
    this.stagedSets.set(id, value);
  }

  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.stagedRemovals = previous.removals;
    this.stagedSets = previous.sets;
    return true;
  }

  discard(): void {
    if (!this.dirty) return;
    this.checkpoint();
    this.stagedRemovals.clear();
    this.stagedSets.clear();
  }

  /** What saving would do, without writing anything. */
  preview(): EditOutcome {
    return editMetadata(this.bytesValue, { remove: [...this.stagedRemovals], set: Object.fromEntries(this.stagedSets) });
  }

  /** Applies the staged edits in memory only. */
  async apply(): Promise<EditOutcome> {
    const outcome = this.preview();
    this.bytesValue = outcome.bytes;
    this.reportValue = await readMetadata(outcome.bytes, this.readOptions);
    this.stagedRemovals.clear();
    this.stagedSets.clear();
    this.history = [];
    return outcome;
  }

  /**
   * Applies the staged edits and writes the result to `target` (default: the path the document was opened from).
   * Writing to another path always writes, even with nothing staged ("save as").
   */
  async save(target: string | undefined = this.path, options: WriteOptions = {}): Promise<{ outcome: EditOutcome; written?: WriteResult }> {
    const outcome = await this.apply();
    let written: WriteResult | undefined;
    if (target && (outcome.changed || target !== this.path)) written = await writeFileAtomic(target, this.bytesValue, options);
    return { outcome, written };
  }

  /** Replaces the document's content (after an external operation such as C2PA signing). */
  async replaceBytes(bytes: Uint8Array): Promise<void> {
    this.bytesValue = bytes;
    this.reportValue = await readMetadata(bytes, this.readOptions);
    this.stagedRemovals.clear();
    this.stagedSets.clear();
    this.history = [];
  }
}
