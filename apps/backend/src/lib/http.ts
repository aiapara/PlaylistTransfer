export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data?.error?.message ?? data?.error_description ?? data?.error ?? response.statusText;
    const error = new Error(`${response.status} ${message}`) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = data;
    throw error;
  }

  return data as T;
}

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
