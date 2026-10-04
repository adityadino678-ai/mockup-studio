import type {
  PrintifyBlueprint,
  PrintifyCreateBody,
  PrintifyProduct,
  PrintifyProvider,
  PrintifyShop,
  PrintifyUpload,
  PrintifyVariantsResponse,
} from './types';

/**
 * The browser cannot reach Printify, so everything goes through the local proxy
 * in `server/`, which holds the token and adds the User-Agent header Printify
 * requires. See the comment at the top of that file.
 */
const BASE = import.meta.env.VITE_PRINTIFY_PROXY ?? 'http://localhost:8787';

export class ProxyError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ProxyError(
      0,
      `Cannot reach the Printify proxy at ${BASE}. Start it with "npm run dev".`,
      null,
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = data as { error?: string; message?: string } | null;
    const message =
      detail?.error ?? detail?.message ?? `Printify request failed (${res.status})`;
    throw new ProxyError(res.status, message, data);
  }
  return data as T;
}

export const printifyApi = {
  health: () =>
    call<{ ok: boolean; configured: boolean; shops?: PrintifyShop[] }>('/api/health'),

  shops: () => call<{ shops: PrintifyShop[] }>('/api/shops').then((r) => r.shops),

  blueprints: () => call<PrintifyBlueprint[]>('/api/blueprints'),

  providers: (blueprintId: number) =>
    call<PrintifyProvider[]>(`/api/blueprints/${blueprintId}/providers`),

  variants: (blueprintId: number, providerId: number, includeOutOfStock = false) =>
    call<PrintifyVariantsResponse>(
      `/api/blueprints/${blueprintId}/providers/${providerId}/variants${includeOutOfStock ? '?all=1' : ''}`,
    ),

  uploadImage: (fileName: string, base64: string) =>
    call<PrintifyUpload>('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ file_name: fileName, contents: base64 }),
    }),

  products: (shopId: number) =>
    call<{ data: PrintifyProduct[] }>(`/api/products?shop_id=${shopId}`).then((r) => r.data ?? []),

  product: (shopId: number, productId: string) =>
    call<PrintifyProduct>(`/api/products/${productId}?shop_id=${shopId}`),

  createProduct: (shopId: number, payload: PrintifyCreateBody) =>
    call<PrintifyProduct>('/api/products', {
      method: 'POST',
      body: JSON.stringify({ shop_id: shopId, payload }),
    }),

  publishProduct: (shopId: number, productId: string, fields: string[]) =>
    call<unknown>(`/api/products/${productId}/publish?shop_id=${shopId}`, {
      method: 'POST',
      body: JSON.stringify({ payload: { fields_to_publish: fields } }),
    }),

  /** Re-serves Printify's own mockup images so the page never hotlinks them. */
  imageUrl: (remoteUrl: string) => `${BASE}/api/image?url=${encodeURIComponent(remoteUrl)}`,
};