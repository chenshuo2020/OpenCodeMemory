import type { ApiResult } from "$shared/api";

export type { ApiResult };

declare global {
  interface Window {
    __OPENCODE_MEM_TOKEN__?: string;
    opencodeMemDesktop?: {
      service: {
        query: () => Promise<{ success: boolean; output?: string }>;
        start: () => Promise<{ success: boolean; output?: string }>;
        stop: () => Promise<{ success: boolean; output?: string }>;
        restart: () => Promise<{ success: boolean; output?: string }>;
      };
      getServiceUrl: () => Promise<string>;
      openBrowser: () => Promise<void>;
    };
  }
}

export async function fetchAPI<T = unknown>(
  endpoint: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<ApiResult<T>> {
  try {
    const controller = new AbortController();
    const timeoutMs =
      options.timeout ||
      (options.method === "POST" && endpoint.includes("/ai-cleanup") ? 180000 : 60000);
    const { timeout: _timeout, headers: extraHeaders, ...fetchOptions } = options;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(endpoint, {
      ...fetchOptions,
      headers: {
        ...(extraHeaders as Record<string, string>),
        "x-opencode-mem-token": window.__OPENCODE_MEM_TOKEN__ || "",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return (await response.json()) as ApiResult<T>;
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
