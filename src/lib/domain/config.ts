// Host/port derivation for the *arr stack, ported from `ArrConfig.kt`.
// Deferred surface (design.md §3.2, tasks.md Slice 1 note "deferred") - not
// wired into any UI in the MVP.

export type ArrService = 'radarr' | 'sonarr' | 'prowlarr';

const DEFAULT_PORTS: Record<ArrService, number> = {
  radarr: 7878,
  sonarr: 8989,
  prowlarr: 9696,
};

export interface ArrConfig {
  service: ArrService;
  host: string;
  port: number;
  apiKey: string;
}

export function defaultPortFor(service: ArrService): number {
  return DEFAULT_PORTS[service];
}

export function buildArrBaseUrl(config: Pick<ArrConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}`;
}
