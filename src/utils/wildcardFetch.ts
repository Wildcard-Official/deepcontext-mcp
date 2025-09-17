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

  return fetch(url, { ...init, headers });
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
