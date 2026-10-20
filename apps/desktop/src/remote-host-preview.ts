import type { Session } from 'electron';
import { DesktopPreviews } from './preview.ts';
import { type DesktopPreviewTarget, validatePreviewTarget } from './preview-policy.ts';
import { publicRemotePreview, type RemoteLease } from './remote-host-preview-policy.ts';
import { connectRemoteHost, type RemoteHost, type RemoteHostConnection } from './remote-hosts.ts';

export class RemoteHostPreviews {
  private readonly options: {
    host: RemoteHost;
    session: Session;
    sshExecutable: string;
    sshConfig: string;
    signal: AbortSignal;
    pinIdentity: (fingerprint: string) => void;
  };
  private readonly forwards = new Map<string, Promise<RemoteHostConnection>>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly delegated = new Map<
    string,
    { delegationId: string; expiresAt: number; renewAt: number; target: DesktopPreviewTarget }
  >();
  private readonly windows: DesktopPreviews;
  private readonly sessions = new Set<string>();
  private readonly watch: NodeJS.Timeout;
  private checking = false;
  private closed = false;

  constructor(options: RemoteHostPreviews['options']) {
    this.options = options;
    this.windows = new DesktopPreviews((sessionId, leaseId) => this.target(sessionId, leaseId));
    this.watch = setInterval(() => void this.reap(), 5000);
    this.watch.unref();
  }

  private async read(path: string, init?: RequestInit) {
    if (this.closed || this.options.signal.aborted) throw new Error('Remote preview disconnected.');
    const response = await this.options.session.fetch(
      `http://127.0.0.1:${this.options.host.port}/api/v1${path}`,
      { ...init, signal: AbortSignal.timeout(10000), redirect: 'error' },
    );
    if (!response.ok) throw new Error('The remote preview lease is unavailable or expired.');
    return response.json();
  }

  private async leases(sessionId: string): Promise<RemoteLease[]> {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(sessionId)) throw new Error('Invalid session.');
    const value = await this.read(`/sessions/${encodeURIComponent(sessionId)}/previews`);
    if (!Array.isArray(value)) throw new Error('Unsupported remote preview service.');
    return value as RemoteLease[];
  }

  private release(origin: string, key: string) {
    const [sessionId, leaseId] = key.split('/');
    if (sessionId && leaseId) this.windows.close(sessionId, leaseId);
    this.delegated.delete(key);
    const owners = this.owners.get(origin);
    owners?.delete(key);
    if (!owners?.size) this.owners.delete(origin);
    const activeSessions = new Set(
      [...this.owners.values()].flatMap((entries) =>
        [...entries].map((entry) => entry.split('/')[0]),
      ),
    );
    for (const session of this.sessions)
      if (!activeSessions.has(session)) this.sessions.delete(session);
  }

  private releaseOrigin(origin: string) {
    for (const key of [...(this.owners.get(origin) ?? [])]) this.release(origin, key);
  }

  private async reap() {
    if (this.closed || this.checking || !this.forwards.size) return;
    this.checking = true;
    try {
      const groups = await Promise.allSettled([...this.sessions].map((id) => this.leases(id)));
      const leases = groups.flatMap((group) => (group.status === 'fulfilled' ? group.value : []));
      const active = new Set(
        leases
          .filter((lease) => lease.state === 'ready')
          .map((lease) => `${lease.sessionId}/${lease.leaseId}`),
      );
      for (const [origin, owners] of [...this.owners])
        for (const key of [...owners]) if (!active.has(key)) this.release(origin, key);
      for (const [origin, pending] of this.forwards) {
        if (this.owners.has(origin)) continue;
        this.forwards.delete(origin);
        await (await pending).close();
      }
    } catch {
      this.windows.closeAll();
      await Promise.allSettled(
        [...this.forwards.values()].map(async (pending) => (await pending).close()),
      );
      this.forwards.clear();
      this.owners.clear();
      this.sessions.clear();
      this.delegated.clear();
    } finally {
      this.checking = false;
    }
  }

  private async forward(origin: string) {
    let pending = this.forwards.get(origin);
    if (!pending) {
      const endpoint = new URL(origin);
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.2')
        throw new Error('Invalid remote preview listener.');
      pending = connectRemoteHost(this.options.host, {
        sshExecutable: this.options.sshExecutable,
        sshConfig: this.options.sshConfig,
        pinIdentity: this.options.pinIdentity,
        signal: this.options.signal,
        forward: { host: '127.0.0.2', port: Number(endpoint.port) },
        onDisconnect: () => {
          if (this.forwards.get(origin) === pending) {
            this.forwards.delete(origin);
            this.releaseOrigin(origin);
          }
        },
      });
      this.forwards.set(origin, pending);
      pending.catch(() => {
        if (this.forwards.get(origin) === pending) {
          this.forwards.delete(origin);
          this.releaseOrigin(origin);
        }
      });
    }
    const connection = await pending;
    if (this.closed || !connection.connected) {
      await connection.close();
      throw new Error('Remote preview disconnected.');
    }
  }

  async allowPublic(sessionId: string, url: string): Promise<boolean> {
    try {
      const leases = await this.leases(sessionId);
      const lease = leases.find((entry) => publicRemotePreview(entry, sessionId, url));
      if (!lease) return false;
      this.own(lease);
      await this.forward(lease.origin);
      return !this.closed;
    } catch {
      return false;
    }
  }

  private async target(sessionId: string, leaseId: string): Promise<DesktopPreviewTarget> {
    const lease = (await this.leases(sessionId)).find(
      (entry) =>
        entry.leaseId === leaseId && entry.sessionId === sessionId && entry.state === 'ready',
    );
    if (!lease) throw new Error('Remote preview was revoked.');
    this.own(lease);
    const key = `${sessionId}/${leaseId}`;
    let delegation = this.delegated.get(key);
    if (!delegation || performance.now() >= delegation.renewAt) {
      const authentication = await this.read('/session');
      if (typeof authentication.csrfToken !== 'string') throw new Error('Remote session expired.');
      const issuedBefore = performance.now();
      const value = await this.read(
        `/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(leaseId)}/delegations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: `http://127.0.0.1:${this.options.host.port}`,
            'x-corral-csrf': authentication.csrfToken,
          },
          body: JSON.stringify(delegation ? { delegationId: delegation.delegationId } : {}),
        },
      );
      const target = validatePreviewTarget(value.target);
      if (
        typeof value.delegationId !== 'string' ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        target.origin !== lease.origin ||
        target.url !== lease.url
      )
        throw new Error('Remote preview delegation does not match its lease.');
      delegation = {
        delegationId: value.delegationId,
        // Start at POST dispatch (not response receipt), conservatively before server issuance.
        // Monotonic deadlines are unaffected by either machine's wall clock.
        expiresAt: issuedBefore + 60000,
        renewAt: issuedBefore + 20000,
        target,
      };
      this.delegated.set(key, delegation);
    }
    await this.forward(delegation.target.origin);
    return delegation.target;
  }

  open(sessionId: string, leaseId: string) {
    const key = `${sessionId}/${leaseId}`;
    if ((this.delegated.get(key)?.expiresAt ?? Infinity) <= performance.now())
      this.delegated.delete(key);
    return this.windows.open(sessionId, leaseId);
  }

  private own(lease: RemoteLease) {
    this.sessions.add(lease.sessionId);
    const owners = this.owners.get(lease.origin) ?? new Set<string>();
    owners.add(`${lease.sessionId}/${lease.leaseId}`);
    this.owners.set(lease.origin, owners);
  }

  async close() {
    this.closed = true;
    clearInterval(this.watch);
    this.windows.closeAll();
    this.delegated.clear();
    await Promise.allSettled(
      [...this.forwards.values()].map(async (value) => (await value).close()),
    );
    this.forwards.clear();
    this.owners.clear();
    this.sessions.clear();
  }
}
