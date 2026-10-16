/**
 * Keeps the catalogue index in step with the library and trust records,
 * and answers inspect and match requests for workspace data.
 */
import type { Library } from "@pharos/books";
import { CatalogueIndex, type MatchableBook, type McpContext, inspect, matchBooks } from "@pharos/catalogue";
import type { BookMatch, DataSummary } from "@pharos/contracts";
import type { TrustStore } from "./orchestration.js";
import type { WorkspaceStore } from "./workspaces.js";

export class CatalogueHolder {
  private readonly index = new CatalogueIndex();
  private built: { library: Library; trust: number } | undefined;
  private books: MatchableBook[] = [];

  constructor(
    private readonly library: () => Promise<Library>,
    private readonly trust: TrustStore,
    private readonly gpu: () => boolean,
  ) {}

  /** The index and matchable books, rebuilt when the library or a trust level changed. */
  async get(): Promise<McpContext> {
    const library = await this.library();
    if (this.built?.library !== library || this.built.trust !== this.trust.version) {
      this.index.rebuild(library);
      this.books = library.bookEntries().map((entry) => {
        const b = library.book(entry.id, entry.version)!;
        return { entry, manifest: b.manifest!, accepts: b.accepts ?? [], guide: b.guide };
      });
      this.built = { library, trust: this.trust.version };
    }
    return { index: this.index, books: this.books, gpu: this.gpu() };
  }

  /** An artifact's summary: read once, then kept in its metadata. */
  async summary(workspaces: WorkspaceStore, workspace: string, id: string): Promise<DataSummary> {
    const a = await workspaces.get(workspace, id);
    if (a.meta.summary) return a.meta.summary as DataSummary;
    const summary = await inspect(a);
    await workspaces.setMeta(workspace, id, { summary });
    return summary;
  }

  async match(workspaces: WorkspaceStore, workspace: string, ids: string[], text?: string): Promise<{ summaries: DataSummary[]; matches: BookMatch[] }> {
    const summaries = await Promise.all(ids.map((id) => this.summary(workspaces, workspace, id)));
    const ctx = await this.get();
    return { summaries, matches: matchBooks(ctx.books, summaries, { text, gpu: ctx.gpu }) };
  }

  close() {
    this.index.close();
  }
}
