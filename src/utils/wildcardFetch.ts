export function useWildcard(): boolean {
  return !!process.env.WILDCARD_API_KEY;
}

export function wildcardBaseUrl(): string {
  return process.env.WILDCARD_API_URL || 'https://intelligent-context-backend.onrender.com' || 'http://localhost:4000';
}

export async function wildcardFetch(
  path: string,
  init: RequestInit = {},
  prefix: string = ''
): Promise<Response> {
  const url = `${wildcardBaseUrl()}${prefix}${path}`;

  const hasBody = init.body !== undefined && init.body !== null;
  const incomingHeaders = (init.headers || {}) as Record<string, string>;
  const headers: Record<string, string> = {
    ...incomingHeaders,
    'x-api-key': process.env.WILDCARD_API_KEY as string,
  };

  // Only set JSON content type if a body is present; otherwise remove to avoid empty JSON body errors
  const hasContentType = 'Content-Type' in headers || 'content-type' in headers;
  if (hasBody) {
    if (!hasContentType) headers['Content-Type'] = 'application/json';
  } else {
    delete headers['Content-Type'];
    delete headers['content-type'];
  }

  // Retry logic for rate limiting and 403 errors
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { ...init, headers });
      
      // If we get a 403 with HTML content (rate limiting), retry with backoff
      if (response.status === 403) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          console.log(`[WILDCARD-FETCH] Rate limited (403 HTML), attempt ${attempt}/${maxRetries}`);
          if (attempt < maxRetries) {
            // Exponential backoff: 2s, 4s, 8s
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`[WILDCARD-FETCH] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
      }
      
      return response;
    } catch (error) {
      lastError = error as Error;
      console.log(`[WILDCARD-FETCH] Network error, attempt ${attempt}/${maxRetries}:`, error);
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error(`Failed after ${maxRetries} attempts`);
}

export async function fetchMirrored(
  directUrl: string,
  directInit: RequestInit,
  wildcardPath: string,
  wildcardInit?: RequestInit
): Promise<Response> {
  if (useWildcard()) {
    return wildcardFetch(wildcardPath, wildcardInit ?? directInit);
  }
  return fetch(directUrl, directInit);
}
