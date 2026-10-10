/** Orchestration metadata only. Python owns installation and application health. */
const COMMON_STEPS = ['checking', 'installing', 'configuring', 'starting', 'ready', 'failed', 'checking_readiness'];
const COMMON_ERRORS = ['insufficient_disk', 'requires_2_gib', 'installation_failed', 'port_in_use',
  'application_not_ready', 'setup_failed', 'setup_timeout'];
export const SERVICE_DEFS = {
  ttyd: {
    id: 'ttyd', root: '/home/daytona/.local/share/bayleaf/ttyd', port: 8794,
    slot: '__ttyd', credential: true, memoryGiB: 0,
    steps: [...COMMON_STEPS, 'installing_ttyd', 'starting_ttyd'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'release_verification_failed', 'unsupported_architecture'],
  },
  jupyter: {
    id: 'jupyter', root: '/home/daytona/.local/share/bayleaf/jupyter', port: 8793,
    slot: '__jupyter', credential: true, memoryGiB: 0,
    steps: [...COMMON_STEPS, 'installing_jupyter', 'starting_jupyter'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'python_311_required', 'managed_file_changed'],
  },
  nanobot: {
    id: 'nanobot', root: '/home/daytona/.local/share/bayleaf/nanobot', port: 8792,
    slot: '__nanobot', credential: true, memoryGiB: 0,
    steps: [...COMMON_STEPS, 'installing_nanobot', 'starting_nanobot', 'configuring_preview'],
    errors: [...COMMON_ERRORS, 'credential_missing', 'credential_invalid', 'python_311_required',
      'node_22_required', 'provider_configuration_unavailable', 'managed_file_changed', 'preview_configuration_invalid'],
  },
  openchamber: {
    id: 'openchamber', root: '/home/daytona/.local/share/bayleaf/browser', port: 3100,
    slot: '__browser', credential: true, memoryGiB: 2,
    steps: [...COMMON_STEPS, 'installing_openchamber', 'installing_opencode', 'starting_openchamber',
      'waiting_for_opencode', 'connecting_bayleaf', 'loading_tools'],
    errors: [...COMMON_ERRORS, 'node_22_required', 'credential_missing', 'credential_invalid',
      'provider_configuration_unavailable', 'opencode_installation_failed'],
  },
  'code-server': {
    id: 'code-server', root: '/home/daytona/.local/share/bayleaf/code-server', port: 8791,
    slot: '__code-server', credential: true, memoryGiB: 2,
    steps: [...COMMON_STEPS, 'installing_code_server', 'starting_code_server'],
    errors: [...COMMON_ERRORS, 'release_verification_failed', 'unsupported_architecture'],
  },
  dufs: {
    id: 'dufs', root: '/home/daytona/.local/share/bayleaf/dufs', port: 8790,
    slot: '__dufs', credential: true, memoryGiB: 0,
    steps: [...COMMON_STEPS, 'installing_dufs', 'starting_dufs'],
    errors: [...COMMON_ERRORS, 'release_verification_failed', 'unsupported_architecture'],
  },
} as const;
export type ServiceId = keyof typeof SERVICE_DEFS;
export type ServiceDef = typeof SERVICE_DEFS[ServiceId];
export const serviceDef = (id: unknown): ServiceDef | undefined =>
  typeof id === 'string' && Object.hasOwn(SERVICE_DEFS, id) ? SERVICE_DEFS[id as ServiceId] : undefined;
export const managedSlot = (slot: string) => Object.values(SERVICE_DEFS).some(def => def.slot === slot);
