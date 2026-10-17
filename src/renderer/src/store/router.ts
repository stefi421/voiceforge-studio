import { create } from 'zustand'
import type { PageId } from '@shared/ipc'

export type PageParams = Record<string, string | undefined>

interface RouterState {
  page: PageId
  params: PageParams
  /** Monotonic counter so pages can react to repeated navigation to the same page. */
  nonce: number
  navigate: (page: PageId, params?: PageParams) => void
  setParams: (params: PageParams) => void
}

export const useRouter = create<RouterState>((set) => ({
  page: 'dashboard',
  params: {},
  nonce: 0,
  navigate: (page, params = {}) => set((s) => ({ page, params, nonce: s.nonce + 1 })),
  setParams: (params) => set({ params })
}))

export function navigate(page: PageId, params?: PageParams): void {
  useRouter.getState().navigate(page, params)
}
