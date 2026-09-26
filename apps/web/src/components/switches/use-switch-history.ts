import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiClient } from '@/lib/api-client';
import { auditPageSchema, type AuditHistoryState } from './switch-history';

type SwitchHistory = {
  readonly historyState: AuditHistoryState;
  readonly loadMoreHistory: () => Promise<void>;
};

export function useSwitchHistory(id: string | undefined): SwitchHistory {
  const [historyState, setHistoryState] = useState<AuditHistoryState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory(): Promise<void> {
      if (!id || !z.string().uuid().safeParse(id).success) return;
      try {
        const page = await apiClient.request({
          path: `/switches/${id}/audit`,
          schema: auditPageSchema,
          signal: controller.signal,
        });
        if (!controller.signal.aborted)
          setHistoryState({
            kind: 'ready',
            items: page.items,
            nextBeforeId: page.nextBeforeId,
            loadingMore: false,
            message: null,
          });
      } catch {
        if (!controller.signal.aborted) setHistoryState({ kind: 'unavailable' });
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [id]);

  async function loadMoreHistory(): Promise<void> {
    if (historyState.kind !== 'ready' || historyState.nextBeforeId === null || !id) return;
    setHistoryState({ ...historyState, loadingMore: true, message: null });
    try {
      const page = await apiClient.request({
        path: `/switches/${id}/audit`,
        query: { beforeId: historyState.nextBeforeId },
        schema: auditPageSchema,
      });
      setHistoryState({
        kind: 'ready',
        items: [...historyState.items, ...page.items],
        nextBeforeId: page.nextBeforeId,
        loadingMore: false,
        message: null,
      });
    } catch {
      setHistoryState({
        ...historyState,
        loadingMore: false,
        message: 'History is temporarily unavailable.',
      });
    }
  }

  return { historyState, loadMoreHistory };
}
