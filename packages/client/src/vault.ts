export type VaultDomain =
  | 'application'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'subagents'
  | 'instructions'
  | 'plugins'
  | 'automation'
  | 'memory';
export interface PortableApplication {
  version: 1;
  theme: 'system' | 'light' | 'dark';
  locale: 'en' | 'ko';
  sendKey: 'enter' | 'mod-enter';
  notify: boolean;
  shortcuts?: Partial<
    Record<
      | 'palette'
      | 'help'
      | 'session.new'
      | 'session.jump'
      | 'view.sidebar'
      | 'view.panel'
      | 'composer.focus'
      | 'settings'
      | 'nav.back'
      | 'nav.forward'
      | 'run.stop',
      {
        key: string;
        mod?: boolean;
        shift?: boolean;
        alt?: boolean;
      }
    >
  >;
}
export type VaultBindings = Partial<Record<VaultDomain, Record<string, string>>>;
export interface VaultCaptureRequest {
  password: string;
  domains: VaultDomain[];
  application: PortableApplication;
  bindings: VaultBindings;
  includeSecrets: string[];
}
export interface VaultPreview {
  previewId: string;
  entries: {
    domain: VaultDomain;
    available: boolean;
    changed: boolean;
    warnings: string[];
    fields: {
      key: string;
      label: string;
      kind: 'project' | 'session' | 'team' | 'parent' | 'model' | 'endpoint' | 'text';
    }[];
  }[];
}
export interface VaultApplyResult {
  id: string;
  status: string;
  application?: { expectedRevision: string; target: PortableApplication };
}
export interface VaultStatus {
  status: string;
  id: string | null;
  domains: { domain: VaultDomain; available: boolean }[];
  s3Configured: boolean;
}
export interface VaultS3Connection {
  password: string;
  config: { endpoint: string; region: string; bucket: string; key: string };
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}
