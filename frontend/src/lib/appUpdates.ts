/** Android update policy, independent of React/native bridges for regression tests. */
export interface AppUpdate {
  announcementId: string; artifactId: string; packageId: 'com.udf.party';
  versionCode: number; versionName: string; bytes: number; sha256: string;
  notes: string; publishedAt: string; downloadUrl: string;
}
export interface PreparedReleases {
  prepared: Array<{ artifact: { id: string; versionCode: number; versionName: string; bytes: number }; verified: boolean }>;
  catalogError: string | null; activeAnnouncementId: string | null; highestVersionCode: number;
  history: Array<AppUpdate & { withdrawnAt: string | null; publishedBy: string; withdrawnBy: string | null }>;
}
export function parseAppUpdate(raw: unknown): AppUpdate | null {
  if (raw === null) return null;
  const a = raw as AppUpdate;
  if (!a || a.packageId !== 'com.udf.party' || !Number.isInteger(a.versionCode) || a.versionCode < 1 || a.versionCode > 2100000000 ||
    typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256) || a.artifactId !== `${a.versionCode}-${a.sha256}` ||
    typeof a.announcementId !== 'string' || !/^[0-9a-f-]{36}$/.test(a.announcementId) ||
    typeof a.versionName !== 'string' || a.versionName.length > 64 ||
    typeof a.notes !== 'string' || a.notes.length > 2000 ||
    !Number.isInteger(a.bytes) || a.bytes < 1 || a.bytes > 300_000_000 ||
    a.downloadUrl !== `https://crm.udf-party.co.za/api/public/download/app-release/${a.artifactId}`) {
    throw new Error('Invalid update metadata');
  }
  return a;
}
export interface UpdateState {
  available: AppUpdate | null; busy: boolean; message: string;
}
interface Dependencies {
  fetchUpdate(signal: AbortSignal): Promise<unknown>;
  getPreference(key: string): Promise<string | null>;
  setPreference(key: string, value: string): Promise<void>;
  openUrl(url: string): Promise<boolean>;
  online(): boolean;
  changed(state: UpdateState): void;
  now?: () => number;
}
const DAY = 24 * 60 * 60 * 1000;
export class UpdateController {
  state: UpdateState = { available: null, busy: false, message: '' };
  private active = false;
  private stopped = false;
  private poll?: ReturnType<typeof setInterval>;
  private pending?: Promise<AppUpdate | null | undefined>;
  private abort?: AbortController;
  private epoch = 0;
  private manual = false;
  private opening = false;
  private downloading = false;
  private deferred = new Map<string, number>();
  constructor(readonly build: number, private deps: Dependencies) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private emit(patch: Partial<UpdateState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch }; this.deps.changed(this.state);
  }
  setActive(active: boolean) {
    if (this.stopped || active === this.active) return;
    this.active = active;
    if (active) {
      void this.check();
      this.poll = setInterval(() => { void this.check(); }, 60_000);
    } else {
      clearInterval(this.poll); this.epoch++; this.abort?.abort(); this.pending = undefined; this.manual = false;
      this.emit({ busy: false });
    }
  }
  stop() { this.setActive(false); this.stopped = true; }
  check(manual = false): Promise<AppUpdate | null | undefined> {
    if (this.stopped || !this.active || this.opening) return Promise.resolve(undefined);
    if (manual) this.manual = true;
    if (this.pending) return this.pending;
    if (!this.deps.online()) {
      if (manual) this.emit({ message: 'Offline. Connect to the internet and try again.' });
      this.manual = false;
      return Promise.resolve(undefined);
    }
    const epoch = this.epoch;
    const abort = new AbortController(); this.abort = abort;
    this.emit({ busy: true, message: manual ? 'Checking for updates…' : this.state.message });
    const timeout = setTimeout(() => abort.abort(), 10_000);
    this.pending = (async () => {
      try {
        const a = parseAppUpdate(await this.deps.fetchUpdate(abort.signal));
        if (abort.signal.aborted || this.stopped || epoch !== this.epoch) return undefined;
        let deferredUntil = a ? this.deferred.get(a.artifactId) ?? 0 : 0;
        if (a) {
          try { deferredUntil = Math.max(deferredUntil, Number(await this.deps.getPreference(`udf.update.later.${a.artifactId}`)) || 0); }
          catch { /* retain the in-memory deferral if device preferences fail */ }
        }
        if (abort.signal.aborted || this.stopped || epoch !== this.epoch) return undefined;
        const newer = a && a.versionCode > this.build;
        const eligible = newer && (this.manual || this.state.available?.artifactId === a.artifactId || deferredUntil <= this.now());
        this.emit({ available: eligible ? a : null,
          ...(this.manual ? { message: newer ? 'An update is available.' : 'You are up to date. No newer update is announced.' } : {}) });
        return newer ? a : null;
      } catch {
        if (epoch === this.epoch && this.manual) this.emit({ message: 'Unable to check for updates. Check your connection and try again.' });
        return undefined;
      } finally {
        clearTimeout(timeout);
        if (epoch === this.epoch) { this.pending = undefined; this.manual = false; this.emit({ busy: false }); }
      }
    })();
    return this.pending;
  }
  async later() {
    const a = this.state.available;
    // Invalidate an in-flight check so it cannot resurrect the dismissed prompt.
    this.epoch++; this.abort?.abort(); this.pending = undefined; this.manual = false;
    this.emit({ available: null, busy: false, message: '' });
    if (!a) return;
    const until = this.now() + DAY; this.deferred.set(a.artifactId, until);
    try { await this.deps.setPreference(`udf.update.later.${a.artifactId}`, String(until)); } catch { /* session deferral remains */ }
  }
  async download() {
    const selected = this.state.available;
    if (!selected || this.downloading) return;
    this.downloading = true;
    try {
      const current = await this.check(true);
      if (!current || !this.active || this.stopped || this.state.available?.artifactId !== selected.artifactId) return;
      if (current.artifactId !== selected.artifactId || current.announcementId !== selected.announcementId) return;
      this.opening = true; this.emit({ busy: true, message: '' });
      if (!await this.deps.openUrl(current.downloadUrl)) throw new Error('Browser unavailable');
      await this.later();
    } catch {
      this.emit({ message: 'Could not open the browser. Try Download update again.' });
    } finally { this.downloading = false; this.opening = false; this.emit({ busy: false }); }
  }
}
