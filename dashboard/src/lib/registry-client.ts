import type {
  AuditEntry,
  AuditFilters,
  Classification,
  ConsumerRef,
  ContractSummary,
  DiffReport,
  GraphData,
  Language,
  OrgInfo,
  OverviewData,
  RegistryClient,
  VersionDetail,
  VersionMeta,
} from './types';
import {
  DEMO_MODE_DEFAULT,
  demoGetContract,
  demoGetDiff,
  demoGetGraph,
  demoGetOverview,
  demoGetVersion,
  demoListAudit,
  demoListConsumers,
  demoListContracts,
  demoListOrgs,
  demoListVersions,
  demoPublishers,
} from './demo-data';

/**
 * Reads the demo/live switches. `NEXT_PUBLIC_DEMO_MODE` defaults to true so
 * the console is browsable with zero backend; set it to exactly `false` or
 * `0` (and point `NEXT_PUBLIC_REGISTRY_URL` at a running registry service)
 * to go live. Anything else keeps demo mode on and warns — booleans are
 * never coerced loosely (`'FALSE'` does not disable demo mode).
 */
export function isDemoMode(): boolean {
  const raw = process.env.NEXT_PUBLIC_DEMO_MODE;
  if (raw === undefined || raw === '') return DEMO_MODE_DEFAULT;
  if (raw === 'false' || raw === '0') return false;
  if (raw !== 'true' && raw !== '1') {
    console.warn(
      `[dashboard] NEXT_PUBLIC_DEMO_MODE=${JSON.stringify(raw)} is not a recognized boolean (true/false/1/0); keeping demo mode ON. Set it to exactly "false" or "0" to go live.`,
    );
  }
  return true;
}

export function registryBaseUrl(): string | null {
  if (isDemoMode()) return null;
  return process.env.NEXT_PUBLIC_REGISTRY_URL ?? 'http://localhost:8080';
}

/* ------------------------------------------------------------------ */
/* REST client against the registry service                            */
/* ------------------------------------------------------------------ */

/** Hard ceiling for a single registry request, so a hung backend can never hang a render. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Typed failure from the registry REST layer. Thrown for network failures,
 * timeouts and non-404 HTTP errors so React error boundaries handle them
 * (Retry UI) instead of pages silently rendering "not found".
 * `status === 0` means the request never got an HTTP response (timeout,
 * connection refused, DNS).
 */
export class RegistryError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, opts: { status: number; path: string; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RegistryError';
    this.status = opts.status;
    this.path = opts.path;
  }
}

/** True when `err` is a typed 404 from the registry (safe to render as "not found"). */
export function isNotFound(err: unknown): boolean {
  return err instanceof RegistryError && err.status === 404;
}

/**
 * Extracts an array field from a list response. If none of the expected keys
 * is present this throws a `RegistryError` — an array-shaped response without
 * the documented key means the API contract drifted, and silently rendering
 * an empty page ("No contracts match") would mask the bug.
 */
function pickArray(body: Record<string, unknown>, keys: string[], path: string): unknown[] {
  for (const k of keys) {
    const v = body[k];
    if (Array.isArray(v)) return v;
  }
  throw new RegistryError(
    `registry response for GET ${path} has none of the expected array keys [${keys.join(', ')}] — API schema drift`,
    { status: 0, path },
  );
}

export class RestRegistryClient implements RegistryClient {
  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new RegistryError(
        timedOut
          ? `registry request timed out after ${FETCH_TIMEOUT_MS}ms on GET ${path}`
          : `registry unreachable on GET ${path}`,
        { status: 0, path, cause: err },
      );
    }
    if (!res.ok) {
      throw new RegistryError(`registry ${res.status} on GET ${path}`, { status: res.status, path });
    }
    return (await res.json()) as T;
  }

  async listOrgs(): Promise<OrgInfo[]> {
    const path = '/v1/orgs';
    const body = await this.get<Record<string, unknown>>(path);
    return pickArray(body, ['orgs'], path) as OrgInfo[];
  }

  async listContracts(org: string, project: string): Promise<ContractSummary[]> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts`;
    const body = await this.get<Record<string, unknown>>(path);
    return pickArray(body, ['contracts'], path) as ContractSummary[];
  }

  async listAllContracts(org?: string): Promise<ContractSummary[]> {
    const orgInfos = org ? [{ org, projects: [] as string[] }] : await this.listOrgs();
    // Fan out per org, then per (org, project): the org→project→contracts
    // walk runs in parallel instead of a sequential N+1 cascade.
    const perOrg = await Promise.all(
      orgInfos.map(async (o) => {
        const projectsPath = `/v1/orgs/${o.org}/projects`;
        let projects = o.projects ?? [];
        if (projects.length === 0) {
          const body = await this.get<Record<string, unknown>>(projectsPath);
          projects = (pickArray(body, ['projects'], projectsPath) as { project: string }[]).map(
            (p) => p.project,
          );
        }
        const contractLists = await Promise.all(
          projects.map((project) => this.listContracts(o.org, project)),
        );
        return contractLists.flat();
      }),
    );
    return perOrg.flat();
  }

  async getContract(org: string, project: string, base: string): Promise<ContractSummary | null> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts/${base}`;
    try {
      return await this.get<ContractSummary>(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listVersions(org: string, project: string, base: string): Promise<VersionMeta[]> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions`;
    const body = await this.get<Record<string, unknown>>(path);
    return pickArray(body, ['versions'], path) as VersionMeta[];
  }

  async getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${version}`;
    try {
      return await this.get<VersionDetail>(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listConsumers(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ConsumerRef[]> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${version}/consumers`;
    const body = await this.get<Record<string, unknown>>(path);
    return pickArray(body, ['consumers'], path) as ConsumerRef[];
  }

  async getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null> {
    const path = `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${to}/diff?from=${encodeURIComponent(from)}`;
    try {
      return await this.get<DiffReport>(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getGraph(org?: string): Promise<GraphData> {
    const qs = org ? `?org=${encodeURIComponent(org)}` : '';
    const path = `/v1/graph${qs}`;
    const body = await this.get<Record<string, unknown>>(path);
    return {
      nodes: pickArray(body, ['nodes'], path) as GraphData['nodes'],
      edges: pickArray(body, ['edges'], path) as GraphData['edges'],
    };
  }

  async listAudit(filters?: AuditFilters): Promise<AuditEntry[]> {
    const qs = new URLSearchParams();
    if (filters?.action) qs.set('action', filters.action);
    if (filters?.actor) qs.set('actor', filters.actor);
    if (filters?.contract) qs.set('contract', filters.contract);
    if (filters?.org) qs.set('org', filters.org);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const path = `/v1/audit${suffix}`;
    const body = await this.get<Record<string, unknown>>(path);
    return pickArray(body, ['entries', 'audit'], path) as AuditEntry[];
  }

  async getOverview(): Promise<OverviewData> {
    // Independent sources fetched concurrently, not back-to-back.
    const [contracts, orgs, audit] = await Promise.all([
      this.listAllContracts(),
      this.listOrgs(),
      this.listAudit(),
    ]);
    const publishes = audit.filter((e) => e.action === 'publish');
    const candidates = contracts.filter(
      (c) => c.latestVerdict && c.latestVerdict !== 'SAFE',
    );

    // All (versions → diff) lookups run concurrently per candidate contract.
    const verdicts = await Promise.all(
      candidates.map(async (c) => {
        const versions = await this.listVersions(c.org, c.project, c.base);
        if (versions.length < 2) return null;
        const diff = await this.getDiff(
          c.org,
          c.project,
          c.base,
          versions[versions.length - 2].version,
          versions[versions.length - 1].version,
        );
        return diff && diff.verdict !== 'SAFE' ? diff : null;
      }),
    );
    const recentBreaking = verdicts.filter((d): d is DiffReport => d !== null);
    recentBreaking.sort((a, b) => (a.to < b.to ? 1 : -1));
    return {
      contracts: contracts.length,
      versions: contracts.reduce((n, c) => n + c.versionCount, 0),
      orgs: orgs.length,
      projects: new Set(contracts.map((c) => `${c.org}/${c.project}`)).size,
      consumerLinks: contracts.reduce((n, c) => n + c.consumers, 0),
      latestVerdicts: contracts
        .filter((c) => c.latestVerdict)
        .map((c) => ({
          base: c.base,
          org: c.org,
          project: c.project,
          verdict: c.latestVerdict as Classification,
        })),
      recentPublishes: publishes.slice(0, 8).map((e) => ({
        packageName: `${e.contract}.${e.version ?? ''}`,
        base: e.contract,
        version: e.version ?? 'v0',
        hash: '',
        shortHash: '',
        imports: [],
        publishedAt: e.at,
        publisher: e.actor,
        owner: '',
        languages: [] as Language[],
        org: e.org,
        project: e.project,
      })),
      recentBreaking,
      objectCount: contracts.reduce((n, c) => n + c.versionCount, 0),
      lastPublishAt: publishes[0]?.at,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Demo client (zero backend)                                          */
/* ------------------------------------------------------------------ */

export class DemoRegistryClient implements RegistryClient {
  listOrgs(): Promise<OrgInfo[]> {
    return Promise.resolve(demoListOrgs());
  }
  listContracts(org: string, project: string): Promise<ContractSummary[]> {
    return Promise.resolve(demoListContracts(org, project));
  }
  listAllContracts(org?: string): Promise<ContractSummary[]> {
    return Promise.resolve(demoListContracts(org));
  }
  getContract(org: string, project: string, base: string): Promise<ContractSummary | null> {
    return Promise.resolve(demoGetContract(org, project, base));
  }
  listVersions(org: string, project: string, base: string): Promise<VersionMeta[]> {
    return Promise.resolve(demoListVersions(org, project, base));
  }
  getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null> {
    return Promise.resolve(demoGetVersion(org, project, base, version));
  }
  listConsumers(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ConsumerRef[]> {
    return Promise.resolve(demoListConsumers(org, project, base, version));
  }
  getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null> {
    return Promise.resolve(demoGetDiff(org, project, base, from, to));
  }
  getGraph(org?: string): Promise<GraphData> {
    return Promise.resolve(demoGetGraph(org));
  }
  listAudit(filters?: AuditFilters): Promise<AuditEntry[]> {
    return Promise.resolve(demoListAudit(filters));
  }
  getOverview(): Promise<OverviewData> {
    return Promise.resolve(demoGetOverview());
  }
  publishers(org: string, project: string, base: string) {
    return demoPublishers(org, project, base);
  }
}

/** Extra demo-only helpers surface on the demo client; shared base type. */
export interface RegistryClientWithHelpers extends RegistryClient {
  publishers?(org: string, project: string, base: string): ReturnType<typeof demoPublishers>;
}

let cached: RegistryClientWithHelpers | null = null;

/** Returns the process-wide registry client (demo or REST, per env). */
export function getRegistryClient(): RegistryClientWithHelpers {
  if (!cached) {
    const url = registryBaseUrl();
    cached = url ? new RestRegistryClient(url) : new DemoRegistryClient();
  }
  return cached;
}
