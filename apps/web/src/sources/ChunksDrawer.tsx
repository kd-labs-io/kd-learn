// The chunks of one source, in a drawer: from the sources screen, and from a citation in a lesson
// (`focus` scrolls to and marks the cited chunk).
import { Banner } from '@astryxdesign/core/Banner';
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer';
import { Item } from '@astryxdesign/core/Item';
import { List } from '@astryxdesign/core/List';
import type { ChunkLocator, SourceChunk } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { useEffect, useState } from 'react';

export const locatorText = (locator: ChunkLocator): string =>
  locator.page !== undefined
    ? m.sources_page({ page: locator.page })
    : (locator.heading ?? locator.url ?? '');

export function ChunksDrawer({
  title,
  load,
  focus,
  onClose,
}: {
  /** Undefined: closed. */
  readonly title: string | undefined;
  readonly load: () => Promise<ReadonlyArray<SourceChunk>>;
  readonly focus?: number | undefined;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly message: string }
    | { readonly status: 'ready'; readonly chunks: ReadonlyArray<SourceChunk> }
  >({ status: 'loading' });
  const open = title !== undefined;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'loading' });
    load()
      .then((chunks) => !cancelled && setState({ status: 'ready', chunks }))
      .catch(
        (error: unknown) =>
          !cancelled &&
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      cancelled = true;
    };
    // `load` is a new function on each render of the caller; the title and focus say what to show.
  }, [open, title, focus]);
  useEffect(() => {
    if (state.status !== 'ready' || focus === undefined) return;
    document
      .querySelector(`[data-chunk="${focus}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [state, focus]);

  return (
    <Drawer
      isOpen={open}
      onOpenChange={(next) => !next && onClose()}
      label={title ?? m.sources_chunks()}
      width={560}
    >
      <DrawerHeader title={title ?? ''} subtitle={m.sources_chunks()} onOpenChange={onClose} />
      {state.status === 'loading' ? (
        <LoadingSkeleton variant="list" label={m.loading()} />
      ) : state.status === 'error' ? (
        <Banner status="error" title={state.message} />
      ) : (
        <List density="compact" data-testid="source-chunks">
          {state.chunks.map((chunk) => (
            <Item
              key={chunk.ordinal}
              label={chunk.text}
              {...(focus === chunk.ordinal ? {} : { labelLines: 8 })}
              description={locatorText(chunk.locator)}
              isSelected={focus === chunk.ordinal}
              data-chunk={chunk.ordinal}
              {...(focus === chunk.ordinal ? { 'data-cited': 'true' } : {})}
              data-testid="source-chunk"
            />
          ))}
        </List>
      )}
    </Drawer>
  );
}
