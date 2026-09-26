import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import {
  EMPTY_AUDIT_FILTERS,
  auditPageSchema,
  buildAuditQuery,
  type AuditFilterValues,
} from '@/lib/audit-contract';
import { ApiError, apiClient } from '@/lib/api-client';
import type { AuditHistoryState } from './switch-history';

export type AuditHistoryFilters = AuditFilterValues & { readonly query: string };

export type SwitchHistoryPagination = {
  readonly pageSize: number;
  readonly onPageSizeChange: (size: number) => void;
  readonly canPrev: boolean;
  readonly onPrev: () => void;
  readonly canNext: boolean;
  readonly onNext: () => void;
  readonly shownFrom: number;
  readonly shownTo: number;
};

const EMPTY_HISTORY_FILTERS: AuditHistoryFilters = { ...EMPTY_AUDIT_FILTERS, query: '' };

type UseSwitchHistory = {
  readonly historyState: AuditHistoryState;
  readonly historyFilters: AuditHistoryFilters;
  readonly setHistoryFilters: (filters: AuditHistoryFilters) => void;
  readonly applyHistoryFilters: () => Promise<void>;
  readonly resetHistoryFilters: () => Promise<void>;
  readonly historyPagination: SwitchHistoryPagination;
};

export function useSwitchHistory(id: string | undefined): UseSwitchHistory {
  const [historyState, setHistoryState] = useState<AuditHistoryState>({ kind: 'loading' });
  const [historyFilters, setHistoryFilters] = useState<AuditHistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AuditHistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [pageSize, setPageSize] = useState(10);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState(0);

  const loadPage = useCallback(
    async (
      nextId: string | undefined,
      filters: AuditHistoryFilters,
      cursor: number | null,
      size: number,
    ): Promise<void> => {
      if (!nextId || !z.string().uuid().safeParse(nextId).success) return;
      setHistoryState(current =>
        cursor === null
          ? { kind: 'loading' }
          : current.kind === 'ready'
            ? { ...current, loadingMore: true, message: null }
            : current,
      );
      try {
        const historyPage = await apiClient.request({
          path: `/switches/${nextId}/audit`,
          query: {
            ...buildAuditQuery(filters),
            q: filters.query || undefined,
            ...(cursor === null ? {} : { beforeId: cursor }),
            limit: size,
          },
          schema: auditPageSchema,
        });
        setHistoryState({
          kind: 'ready',
          items: historyPage.items,
          nextBeforeId: historyPage.nextBeforeId,
          loadingMore: false,
          message: null,
        });
      } catch (error) {
        if (error instanceof ApiError || error instanceof TypeError) {
          setHistoryState(current =>
            current.kind === 'ready'
              ? { ...current, loadingMore: false, message: 'History is temporarily unavailable.' }
              : { kind: 'unavailable' },
          );
          return;
        }
        throw error;
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(id, EMPTY_HISTORY_FILTERS, null, 10);
  }, [id, loadPage]);

  async function applyHistoryFilters(): Promise<void> {
    setAppliedFilters(historyFilters);
    setCursors([null]);
    setPage(0);
    await loadPage(id, historyFilters, null, pageSize);
  }

  async function resetHistoryFilters(): Promise<void> {
    setHistoryFilters(EMPTY_HISTORY_FILTERS);
    setAppliedFilters(EMPTY_HISTORY_FILTERS);
    setCursors([null]);
    setPage(0);
    await loadPage(id, EMPTY_HISTORY_FILTERS, null, pageSize);
  }

  async function goToNext(): Promise<void> {
    if (historyState.kind !== 'ready' || historyState.nextBeforeId === null || !id) return;
    const cursor = historyState.nextBeforeId;
    setCursors(current => [...current.slice(0, page + 1), cursor]);
    setPage(page + 1);
    await loadPage(id, appliedFilters, cursor, pageSize);
  }

  async function goToPrev(): Promise<void> {
    if (page === 0 || !id) return;
    const cursor = cursors[page - 1] ?? null;
    setPage(page - 1);
    await loadPage(id, appliedFilters, cursor, pageSize);
  }

  async function changePageSize(size: number): Promise<void> {
    setPageSize(size);
    setCursors([null]);
    setPage(0);
    await loadPage(id, appliedFilters, null, size);
  }

  const historyPagination: SwitchHistoryPagination = {
    pageSize,
    onPageSizeChange: size => void changePageSize(size),
    canPrev: page > 0,
    onPrev: () => void goToPrev(),
    canNext: historyState.kind === 'ready' && historyState.nextBeforeId !== null,
    onNext: () => void goToNext(),
    shownFrom: historyState.kind === 'ready' ? page * pageSize + 1 : 0,
    shownTo: historyState.kind === 'ready' ? page * pageSize + historyState.items.length : 0,
  };

  return {
    historyState,
    historyFilters,
    setHistoryFilters,
    applyHistoryFilters,
    resetHistoryFilters,
    historyPagination,
  };
}
