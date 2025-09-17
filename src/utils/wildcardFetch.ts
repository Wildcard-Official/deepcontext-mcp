export function useWildcard(): boolean {
  return !!process.env.WILDCARD_API_KEY;
}

export function wildcardBaseUrl(): string {
  return process.env.WILDCARD_API_URL || 'http://localhost:4000';
}

export async function wildcardFetch(
  path: string,
  init: RequestInit = {},
  prefix: string = ''
): Promise<Response> {
  const url = `${wildcardBaseUrl()}${prefix}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
    'x-api-key': process.env.WILDCARD_API_KEY as string,
  } as Record<string, string>;

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
