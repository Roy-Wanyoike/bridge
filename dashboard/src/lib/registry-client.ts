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
 * the console is browsable with zero backend; set it to `false` and point
 * `NEXT_PUBLIC_REGISTRY_URL` at a running registry service to go live.
 */
export function isDemoMode(): boolean {
  const raw = process.env.NEXT_PUBLIC_DEMO_MODE;
  if (raw === undefined) return DEMO_MODE_DEFAULT;
  return raw !== 'false' && raw !== '0';
}

export function registryBaseUrl(): string | null {
  if (isDemoMode()) return null;
  return process.env.NEXT_PUBLIC_REGISTRY_URL ?? 'http://localhost:8080';
}

/* ------------------------------------------------------------------ */
/* REST client against the registry service                            */
/* ------------------------------------------------------------------ */

interface ListResponse<T> {
  [key: string]: unknown;
}

function pickArray<T>(body: ListResponse<T>, keys: string[]): T[] {
  for (const k of keys) {
    const v = (body as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

export class RestRegistryClient implements RegistryClient {
  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`registry ${res.status} on GET ${path}`);
    }
    return (await res.json()) as T;
  }

  async listOrgs(): Promise<OrgInfo[]> {
    const body = await this.get<Record<string, unknown>>('/v1/orgs');
    return pickArray<OrgInfo>(body, ['orgs']);
  }

  async listContracts(org: string, project: string): Promise<ContractSummary[]> {
    const body = await this.get<Record<string, unknown>>(
      `/v1/orgs/${org}/projects/${project}/contracts`,
    );
    return pickArray<ContractSummary>(body, ['contracts']);
  }

  async listAllContracts(org?: string): Promise<ContractSummary[]> {
    const orgInfos = org ? [{ org, projects: [] as string[] }] : await this.listOrgs();
    const out: ContractSummary[] = [];
    for (const o of orgInfos) {
      let projects = o.projects ?? [];
      if (projects.length === 0) {
        const body = await this.get<Record<string, unknown>>(`/v1/orgs/${o.org}/projects`);
        projects = pickArray<{ project: string }>(body, ['projects']).map((p) => p.project);
      }
      for (const project of projects) {
        out.push(...(await this.listContracts(o.org, project)));
      }
    }
    return out;
  }

  async getContract(org: string, project: string, base: string): Promise<ContractSummary | null> {
    try {
      return await this.get<ContractSummary>(
        `/v1/orgs/${org}/projects/${project}/contracts/${base}`,
      );
    } catch {
      return null;
    }
  }

  async listVersions(org: string, project: string, base: string): Promise<VersionMeta[]> {
    const body = await this.get<Record<string, unknown>>(
      `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions`,
    );
    return pickArray<VersionMeta>(body, ['versions']);
  }

  async getVersion(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<VersionDetail | null> {
    try {
      return await this.get<VersionDetail>(
        `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${version}`,
      );
    } catch {
      return null;
    }
  }

  async listConsumers(
    org: string,
    project: string,
    base: string,
    version: string,
  ): Promise<ConsumerRef[]> {
    const body = await this.get<Record<string, unknown>>(
      `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${version}/consumers`,
    );
    return pickArray<ConsumerRef>(body, ['consumers']);
  }

  async getDiff(
    org: string,
    project: string,
    base: string,
    from: string,
    to: string,
  ): Promise<DiffReport | null> {
    try {
      return await this.get<DiffReport>(
        `/v1/orgs/${org}/projects/${project}/contracts/${base}/versions/${to}/diff?from=${encodeURIComponent(from)}`,
      );
    } catch {
      return null;
    }
  }

  async getGraph(org?: string): Promise<GraphData> {
    const qs = org ? `?org=${encodeURIComponent(org)}` : '';
    const body = await this.get<Record<string, unknown>>(`/v1/graph${qs}`);
    return {
      nodes: pickArray<GraphData['nodes'][number]>(body, ['nodes']),
      edges: pickArray<GraphData['edges'][number]>(body, ['edges']),
    };
  }

  async listAudit(filters?: AuditFilters): Promise<AuditEntry[]> {
    const qs = new URLSearchParams();
    if (filters?.action) qs.set('action', filters.action);
    if (filters?.actor) qs.set('actor', filters.actor);
    if (filters?.contract) qs.set('contract', filters.contract);
    if (filters?.org) qs.set('org', filters.org);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const body = await this.get<Record<string, unknown>>(`/v1/audit${suffix}`);
    return pickArray<AuditEntry>(body, ['entries', 'audit']);
  }

  async getOverview(): Promise<OverviewData> {
    const contracts = await this.listAllContracts();
    const orgs = await this.listOrgs();
    const audit = await this.listAudit();
    const publishes = audit.filter((e) => e.action === 'publish');
    const recentBreaking: DiffReport[] = [];
    for (const c of contracts) {
      if (!c.latestVerdict || c.latestVerdict === 'SAFE') continue;
      const versions = await this.listVersions(c.org, c.project, c.base);
      if (versions.length < 2) continue;
      const diff = await this.getDiff(
        c.org,
        c.project,
        c.base,
        versions[versions.length - 2].version,
        versions[versions.length - 1].version,
      );
      if (diff && diff.verdict !== 'SAFE') recentBreaking.push(diff);
    }
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
