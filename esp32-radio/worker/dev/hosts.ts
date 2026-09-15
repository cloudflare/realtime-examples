const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

/** Explicit extra hostnames/IPs shared by Vite and the live API proxy. */
export function developmentHosts(value = ''): string[] {
  const additional = value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  for (const host of additional) {
    let url: URL;
    try {
      url = new URL(`http://${host}`);
    } catch {
      throw new Error('RADIO_DEV_HOSTS must contain comma-separated hostnames or IPs.');
    }
    if (
      host.startsWith('.') ||
      host.includes('*') ||
      url.port ||
      url.host !== host ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'RADIO_DEV_HOSTS entries must be exact hostnames or IPs, without schemes, ports, paths, or wildcards.',
      );
    }
  }
  return [...new Set([...loopbackHosts, ...additional])];
}

export function allowedProxyRequest(
  host: string,
  origin: string | undefined,
  fetchSite: string | undefined,
  allowed: readonly string[],
): boolean {
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return (
    allowed.includes(hostname) &&
    (!origin || origin === `http://${host}`) &&
    fetchSite !== 'cross-site'
  );
}
