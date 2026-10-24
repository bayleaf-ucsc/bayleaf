/** Orchestration metadata only. Python owns installation and application health,
 * except `computeruse` services, whose processes Daytona's Toolbox supervises. */
const COMMON_STEPS = ['checking', 'installing', 'configuring', 'starting', 'ready', 'failed', 'checking_readiness'];
const COMMON_ERRORS = ['insufficient_disk', 'requires_2_gib', 'installation_failed', 'port_in_use',
  'application_not_ready', 'setup_failed', 'setup_timeout'];
export const SERVICE_DEFS = {
  collabmd: {
    id: 'collabmd', root: '/home/daytona/.local/share/bayleaf/collabmd', port: 8795,
    slot: '__collabmd', credential: false, memoryGiB: 0, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_collabmd', 'starting_collabmd', 'configuring_preview'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'release_verification_failed',
      'unsupported_architecture', 'sharing_directory_invalid', 'preview_configuration_invalid'],
  },
  ttyd: {
    id: 'ttyd', root: '/home/daytona/.local/share/bayleaf/ttyd', port: 8794,
    slot: '__ttyd', credential: true, memoryGiB: 0, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_ttyd', 'starting_ttyd'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'release_verification_failed', 'unsupported_architecture'],
  },
  jupyter: {
    id: 'jupyter', root: '/home/daytona/.local/share/bayleaf/jupyter', port: 8793,
    slot: '__jupyter', credential: true, memoryGiB: 0, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_jupyter', 'starting_jupyter'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'python_311_required', 'managed_file_changed'],
  },
  nanobot: {
    id: 'nanobot', root: '/home/daytona/.local/share/bayleaf/nanobot', port: 8792,
    slot: '__nanobot', credential: true, memoryGiB: 0, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_nanobot', 'starting_nanobot', 'configuring_preview'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'python_311_required',
      'node_22_required', 'provider_configuration_unavailable', 'managed_file_changed', 'preview_configuration_invalid'],
  },
  openchamber: {
    id: 'openchamber', root: '/home/daytona/.local/share/bayleaf/browser', port: 3100,
    slot: '__browser', credential: true, memoryGiB: 2, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_openchamber', 'installing_opencode', 'starting_openchamber',
      'waiting_for_opencode', 'connecting_bayleaf', 'loading_tools'],
    errors: [...COMMON_ERRORS, 'node_22_required', 'credential_missing', 'credential_invalid',
      'provider_configuration_unavailable', 'opencode_installation_failed'],
  },
  'code-server': {
    id: 'code-server', root: '/home/daytona/.local/share/bayleaf/code-server', port: 8791,
    slot: '__code-server', credential: true, memoryGiB: 2, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_code_server', 'starting_code_server'],
    errors: [...COMMON_ERRORS, 'release_verification_failed', 'unsupported_architecture'],
  },
  dufs: {
    id: 'dufs', root: '/home/daytona/.local/share/bayleaf/dufs', port: 8790,
    slot: '__dufs', credential: true, memoryGiB: 0, driver: 'installer',
    steps: [...COMMON_STEPS, 'installing_dufs', 'starting_dufs'],
    errors: [...COMMON_ERRORS, 'release_verification_failed', 'unsupported_architecture'],
  },
  desktop: {
    // Daytona's computer-use stack (Xvfb :0, xfce4, x11vnc, noVNC on 6080),
    // started and stopped through Toolbox, never installed or created by us.
    // About 450 MB idle RSS. x11vnc has no password: the private gateway is the
    // only access control, so this slot must never become public.
    id: 'desktop', root: '/home/daytona/.local/share/bayleaf/desktop', port: 6080,
    slot: '__desktop', credential: false, memoryGiB: 1, driver: 'computeruse',
    // websockify serves /usr/share/novnc with no index page. Land on the client.
    landing: '/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify',
    steps: [...COMMON_STEPS, 'starting_desktop'],
    errors: [...COMMON_ERRORS, 'desktop_not_ready', 'invalid_desktop_status'],
  },
} as const;
export type ServiceId = keyof typeof SERVICE_DEFS;
export type ServiceDef = typeof SERVICE_DEFS[ServiceId];
export const serviceDef = (id: unknown): ServiceDef | undefined =>
  typeof id === 'string' && Object.hasOwn(SERVICE_DEFS, id) ? SERVICE_DEFS[id as ServiceId] : undefined;
export const managedSlot = (slot: string) => Object.values(SERVICE_DEFS).some(def => def.slot === slot);
/** Fixed policy, never a caller-selected public/private switch. */
export const managedAccess = (slot: string) => slot === '__collabmd' ? 'public' : 'private';
/** Fixed post-login landing path for a managed slot; never caller-selected. */
export const managedLanding = (slot: string) => {
  const def = Object.values(SERVICE_DEFS).find(def => def.slot === slot);
  return def && 'landing' in def ? def.landing : '/';
};
