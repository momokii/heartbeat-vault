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

type SwitchHistory = {
  readonly historyState: AuditHistoryState;
  readonly historyFilters: AuditFilterValues;
  readonly setHistoryFilters: (filters: AuditFilterValues) => void;
  readonly applyHistoryFilters: () => Promise<void>;
  readonly resetHistoryFilters: () => Promise<void>;
  readonly loadMoreHistory: () => Promise<void>;
};

export function useSwitchHistory(id: string | undefined): SwitchHistory {
  const [historyState, setHistoryState] = useState<AuditHistoryState>({ kind: 'loading' });
  const [historyFilters, setHistoryFilters] = useState<AuditFilterValues>(EMPTY_AUDIT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AuditFilterValues>(EMPTY_AUDIT_FILTERS);

  const loadFirstPage = useCallback(
    async (filters: AuditFilterValues, signal?: AbortSignal): Promise<void> => {
      if (!id || !z.string().uuid().safeParse(id).success) return;
      setHistoryState({ kind: 'loading' });
      try {
        const page = await apiClient.request({
          path: `/switches/${id}/audit`,
          query: buildAuditQuery(filters),
          schema: auditPageSchema,
          signal,
        });
        if (!signal?.aborted) {
          setHistoryState({
            kind: 'ready',
            items: page.items,
            nextBeforeId: page.nextBeforeId,
            loadingMore: false,
            message: null,
          });
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError || error instanceof TypeError) {
          setHistoryState({ kind: 'unavailable' });
          return;
        }
        throw error;
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(EMPTY_AUDIT_FILTERS, controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  async function applyHistoryFilters(): Promise<void> {
    setAppliedFilters(historyFilters);
    await loadFirstPage(historyFilters);
  }

  async function resetHistoryFilters(): Promise<void> {
    setHistoryFilters(EMPTY_AUDIT_FILTERS);
    setAppliedFilters(EMPTY_AUDIT_FILTERS);
    await loadFirstPage(EMPTY_AUDIT_FILTERS);
  }

  async function loadMoreHistory(): Promise<void> {
    if (historyState.kind !== 'ready' || historyState.nextBeforeId === null || !id) return;
    setHistoryState({ ...historyState, loadingMore: true, message: null });
    try {
      const page = await apiClient.request({
        path: `/switches/${id}/audit`,
        query: buildAuditQuery(appliedFilters, historyState.nextBeforeId),
        schema: auditPageSchema,
      });
      setHistoryState({
        kind: 'ready',
        items: [...historyState.items, ...page.items],
        nextBeforeId: page.nextBeforeId,
        loadingMore: false,
        message: null,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        setHistoryState({
          ...historyState,
          loadingMore: false,
          message: 'History is temporarily unavailable.',
        });
        return;
      }
      throw error;
    }
  }

  return {
    historyState,
    historyFilters,
    setHistoryFilters,
    applyHistoryFilters,
    resetHistoryFilters,
    loadMoreHistory,
  };
}
